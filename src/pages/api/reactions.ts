import type { APIRoute } from "astro";
// Astro v6 removed Astro.locals.runtime.env; bindings come from the workers
// runtime module now.
import { env } from "cloudflare:workers";

export const prerender = false;

/**
 * Reactions — a small, self-owned replacement for comments.
 *
 * Stored in the site's own D1 table rather than an EmDash collection, because
 * these are writes from anonymous visitors: routing them through the content
 * API would mean handing the public a content-write credential.
 *
 * A visitor id (a random value the browser keeps in localStorage) makes the
 * toggle idempotent per person. It is not an identity claim and is not
 * treated as one — it only stops the same browser double-counting itself.
 *
 * One reaction per person per item, like a poll: choosing another swaps it,
 * choosing the same one again clears it.
 */

const KINDS = ["like", "love", "ily", "wow"] as const;
type Kind = (typeof KINDS)[number];

// Only collections that actually appear on the site.
const COLLECTIONS = new Set(["posts", "photos"]);

const TABLE = `
CREATE TABLE IF NOT EXISTS site_reactions (
  collection TEXT NOT NULL,
  content_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  visitor    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (collection, content_id, kind, visitor)
)`;

function db(): D1Database | null {
	const binding = (env as unknown as { DB?: unknown } | undefined)?.DB;
	return binding && typeof binding === "object" ? (binding as D1Database) : null;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

function validTarget(collection: unknown, id: unknown) {
	return (
		typeof collection === "string" &&
		COLLECTIONS.has(collection) &&
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= 64
	);
}

/** Counts for one item, plus the reaction this visitor has left, if any. */
export const GET: APIRoute = async ({ url }) => {
	const database = db();
	if (!database) return json({ counts: {}, mine: [] });

	const collection = url.searchParams.get("collection");
	const id = url.searchParams.get("id");
	const visitor = url.searchParams.get("visitor") ?? "";
	if (!validTarget(collection, id)) return json({ error: "bad target" }, 400);

	await database.prepare(TABLE).run();

	const totals = await database
		.prepare(
			"SELECT kind, COUNT(*) AS n FROM site_reactions WHERE collection = ? AND content_id = ? GROUP BY kind",
		)
		.bind(collection, id)
		.all<{ kind: string; n: number }>();

	const counts: Record<string, number> = {};
	for (const row of totals.results ?? []) counts[row.kind] = Number(row.n);

	let mine: string | null = null;
	if (visitor) {
		// Newest first: rows from before the one-per-person rule may still
		// carry more than one, and the latest is the one that counts.
		const own = await database
			.prepare(
				"SELECT kind FROM site_reactions WHERE collection = ? AND content_id = ? AND visitor = ? ORDER BY created_at DESC LIMIT 1",
			)
			.bind(collection, id, visitor)
			.first<{ kind: string }>();
		mine = own?.kind ?? null;
	}

	return json({ counts, mine });
};

/** Set, swap or clear this visitor's reaction on one item. */
export const POST: APIRoute = async ({ request }) => {
	const database = db();
	if (!database) return json({ error: "no database" }, 503);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: "bad json" }, 400);
	}

	const { collection, id, kind, visitor } = body as Record<string, string>;
	if (!validTarget(collection, id)) return json({ error: "bad target" }, 400);
	if (!KINDS.includes(kind as Kind)) return json({ error: "bad kind" }, 400);
	if (typeof visitor !== "string" || visitor.length < 8 || visitor.length > 64) {
		return json({ error: "bad visitor" }, 400);
	}

	await database.prepare(TABLE).run();

	const current = await database
		.prepare(
			"SELECT kind FROM site_reactions WHERE collection = ? AND content_id = ? AND visitor = ? ORDER BY created_at DESC LIMIT 1",
		)
		.bind(collection, id, visitor)
		.first<{ kind: string }>();

	// Clearing everything this visitor has on the item covers the swap and the
	// un-react alike, and tidies any pre-rule duplicates on the way past.
	const clear = database
		.prepare(
			"DELETE FROM site_reactions WHERE collection = ? AND content_id = ? AND visitor = ?",
		)
		.bind(collection, id, visitor);

	const mine = current?.kind === kind ? null : kind;
	if (mine) {
		// One transaction, so a swap can't be observed as "no reaction".
		await database.batch([
			clear,
			database
				.prepare(
					"INSERT INTO site_reactions (collection, content_id, kind, visitor, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(collection, id, kind, visitor, new Date().toISOString()),
		]);
	} else {
		await clear.run();
	}

	const totals = await database
		.prepare(
			"SELECT kind, COUNT(*) AS n FROM site_reactions WHERE collection = ? AND content_id = ? GROUP BY kind",
		)
		.bind(collection, id)
		.all<{ kind: string; n: number }>();

	const counts: Record<string, number> = {};
	for (const row of totals.results ?? []) counts[row.kind] = Number(row.n);

	return json({ counts, mine });
};
