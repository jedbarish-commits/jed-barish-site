#!/usr/bin/env node
/**
 * Import an Instagram "Download your information" export into the photos
 * collection.
 *
 *   node scripts/import-instagram.mjs --export ~/Downloads/instagram-export --dry-run
 *   EMDASH_TOKEN=... node scripts/import-instagram.mjs --export ~/Downloads/instagram-export
 *
 * The export must be requested in JSON format (not HTML). Point --export at
 * the unzipped folder; the script finds the posts file itself.
 *
 * Re-runnable: each photo records the export's media URI in `source_ref`, and
 * anything already imported is skipped.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const EXPORT_DIR = opt("export");
const SITE = (opt("site", "https://jedbarish.com") ?? "").replace(/\/$/, "");
const LIMIT = Number(opt("limit", "0")) || 0;
const DRY_RUN = flag("dry-run");
// Photos land as drafts unless --publish is passed. An Instagram back
// catalogue is personal by default; nothing goes public without asking for it.
const PUBLISH = flag("publish");
// Trim: pasting a token often drags in a trailing newline or a stray space,
// which makes an otherwise valid token fail with an opaque 401.
const TOKEN = process.env.EMDASH_TOKEN?.trim();

if (!EXPORT_DIR) {
	console.error("Missing --export <path to unzipped Instagram export>");
	process.exit(1);
}
if (!DRY_RUN && !TOKEN) {
	console.error(
		"Missing EMDASH_TOKEN. Create an API token in the admin (Settings -> API\n" +
			"tokens) with content and media write scope, then:\n\n" +
			"  EMDASH_TOKEN=... node scripts/import-instagram.mjs --export <dir>\n\n" +
			"Or pass --dry-run to preview without writing anything.",
	);
	process.exit(1);
}

/**
 * Instagram writes UTF-8 bytes but labels them latin-1, so emoji and accented
 * characters arrive mojibaked ("ð"). Re-interpreting the
 * bytes fixes it; if that throws, the string was already clean.
 */
function fixEncoding(value) {
	if (typeof value !== "string") return value;
	try {
		const repaired = Buffer.from(value, "latin1").toString("utf8");
		return repaired.includes("�") ? value : repaired;
	} catch {
		return value;
	}
}

/** Instagram has moved the posts file between export versions. */
async function findPostsFiles(root) {
	const candidates = [
		"your_instagram_activity/media",
		"your_instagram_activity/content",
		"content",
		"media",
	];
	const found = [];
	for (const rel of candidates) {
		const dir = path.join(root, rel);
		if (!existsSync(dir)) continue;
		for (const name of await readdir(dir)) {
			if (/^posts.*\.json$/i.test(name)) found.push(path.join(dir, name));
		}
	}
	if (found.length === 0) {
		// Fall back to a shallow walk — layouts vary by export age and region.
		const walk = async (dir, depth = 0) => {
			if (depth > 4) return;
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) await walk(full, depth + 1);
				else if (/^posts.*\.json$/i.test(entry.name)) found.push(full);
			}
		};
		await walk(root).catch(() => {});
	}
	return found;
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);

function mimeFor(file) {
	const ext = path.extname(file).toLowerCase();
	return (
		{
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".png": "image/png",
			".webp": "image/webp",
			".heic": "image/heic",
		}[ext] ?? "application/octet-stream"
	);
}

/**
 * Flatten the export's posts (each may be a carousel) into single photos.
 *
 * Exports ship two shapes side by side and neither is a superset of the other,
 * so both are read and the results deduplicated on the media URI:
 *
 *   posts_1.json  media live on the post: { media: [...], title, creation_timestamp }
 *   posts.json    media live under a label: { label_values: [{ label: "Media",
 *                 media: [...] }, { label: "Caption", value }], timestamp }
 */
function collectPhotos(posts) {
	const out = [];

	const push = (item, fallbackCaption, fallbackTs, siblings) => {
		const uri = item.uri;
		if (!uri) return;
		if (!IMAGE_EXT.has(path.extname(uri).toLowerCase())) return; // skip video
		const caption = fixEncoding(item.title ?? "") || fallbackCaption;
		const ts = item.creation_timestamp ?? fallbackTs ?? null;
		out.push({
			uri,
			caption,
			takenAt: ts ? new Date(ts * 1000) : null,
			isCarousel: siblings > 1,
		});
	};

	for (const post of Array.isArray(posts) ? posts : []) {
		const labels = Array.isArray(post.label_values) ? post.label_values : [];
		const labelled = (name) => labels.find((l) => l.label === name);

		const postCaption =
			fixEncoding(post.title ?? "") ||
			fixEncoding(labelled("Caption")?.value ?? "");
		const postTs = post.creation_timestamp ?? post.timestamp ?? null;

		const direct = Array.isArray(post.media) ? post.media : [];
		for (const item of direct) push(item, postCaption, postTs, direct.length);

		for (const label of labels) {
			const nested = Array.isArray(label.media) ? label.media : [];
			for (const item of nested) push(item, postCaption, postTs, nested.length);
		}
	}

	// The two files overlap heavily; keep the first sighting of each URI.
	const seen = new Set();
	return out.filter((p) => {
		if (seen.has(p.uri)) return false;
		seen.add(p.uri);
		return true;
	});
}

/** First line of the caption, trimmed — Instagram has no separate title. */
function titleFrom(caption, takenAt) {
	const first = (caption || "").split("\n").map((s) => s.trim()).find(Boolean);
	if (first) return first.length > 80 ? `${first.slice(0, 77)}…` : first;
	return takenAt
		? takenAt.toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			})
		: "Untitled";
}

const api = async (pathname, init = {}) => {
	const res = await fetch(`${SITE}${pathname}`, {
		...init,
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"X-EmDash-Request": "1",
			...(init.headers ?? {}),
		},
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text.slice(0, 300);
	}
	return { ok: res.ok, status: res.status, body };
};

/**
 * Check the token before doing any work. Without this a bad token surfaces as
 * one 401 per photo, after the dedupe check has already silently returned an
 * empty set — which looks like "nothing imported yet" rather than "not logged
 * in", and then tries the whole export anyway.
 */
async function preflight() {
	const { ok, status, body } = await api("/_emdash/api/content/photos?limit=1");
	if (ok) return;

	const detail =
		typeof body === "object" ? (body?.error?.message ?? "") : String(body);
	const lines = [`Auth check failed against ${SITE} (HTTP ${status}${detail ? `: ${detail}` : ""}).`, ""];

	if (status === 401) {
		lines.push(
			"The token was rejected. Most likely one of:",
			"  - It was created on a different site than " + SITE,
			"    (a token made in a localhost admin will not work against production)",
			"  - The paste was truncated — tokens start with `ec_pat_` and are long",
			"  - It was revoked, or has expired",
			"",
			`Token seen by this script: ${
				TOKEN ? `${TOKEN.slice(0, 7)}…${TOKEN.slice(-4)} (${TOKEN.length} chars)` : "(empty)"
			}`,
		);
	} else if (status === 403) {
		lines.push(
			"The token authenticated but lacks the needed scopes. It needs:",
			"  content:read, content:write, media:read, media:write",
		);
	}
	console.error(lines.join("\n"));
	process.exit(1);
}

async function alreadyImported() {
	const seen = new Set();
	let cursor;
	do {
		const qs = new URLSearchParams({ limit: "100" });
		if (cursor) qs.set("cursor", cursor);
		const { ok, status, body } = await api(`/_emdash/api/content/photos?${qs}`);
		// Never swallow this: an unreadable list means dedupe is blind, and
		// continuing would re-import everything on the next run.
		if (!ok) {
			throw new Error(
				`Could not list existing photos (HTTP ${status}). Aborting rather than ` +
					"risk duplicate imports.",
			);
		}
		for (const item of body?.data?.items ?? []) {
			const ref = item?.data?.source_ref;
			if (ref) seen.add(ref);
		}
		cursor = body?.data?.nextCursor;
	} while (cursor);
	return seen;
}

async function main() {
	const root = path.resolve(EXPORT_DIR.replace(/^~/, process.env.HOME ?? "~"));
	if (!existsSync(root)) {
		console.error(`Export folder not found: ${root}`);
		process.exit(1);
	}

	const files = await findPostsFiles(root);
	if (files.length === 0) {
		console.error(
			`No posts*.json found under ${root}.\n` +
				"Make sure you unzipped the export and requested it in JSON format.",
		);
		process.exit(1);
	}
	console.log(`Found ${files.length} posts file(s):`);
	for (const f of files) console.log(`  ${path.relative(root, f)}`);

	const byUri = new Map();
	for (const file of files) {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		for (const photo of collectPhotos(parsed)) {
			// Files overlap; prefer whichever sighting actually has a caption.
			const existing = byUri.get(photo.uri);
			if (!existing || (!existing.caption && photo.caption)) {
				byUri.set(photo.uri, photo);
			}
		}
	}
	let photos = [...byUri.values()];
	photos.sort((a, b) => (a.takenAt?.getTime() ?? 0) - (b.takenAt?.getTime() ?? 0));

	console.log(`\n${photos.length} image(s) in the export.`);
	if (LIMIT) photos = photos.slice(0, LIMIT);

	if (DRY_RUN) {
		console.log("\n--dry-run: nothing will be written.\n");
		for (const p of photos.slice(0, 20)) {
			const when = p.takenAt ? p.takenAt.toISOString().slice(0, 10) : "(no date)";
			console.log(`  ${when}  ${titleFrom(p.caption, p.takenAt)}`);
		}
		if (photos.length > 20) console.log(`  … and ${photos.length - 20} more`);
		return;
	}

	await preflight();

	const seen = await alreadyImported();
	console.log(`${seen.size} already imported; skipping those.\n`);

	let created = 0;
	let skipped = 0;
	let failed = 0;

	for (const photo of photos) {
		if (seen.has(photo.uri)) {
			skipped++;
			continue;
		}
		const abs = path.join(root, photo.uri);
		if (!existsSync(abs)) {
			console.warn(`  missing file, skipped: ${photo.uri}`);
			failed++;
			continue;
		}

		const title = titleFrom(photo.caption, photo.takenAt);
		try {
			// 1. upload the file into the media library (and R2)
			const bytes = await readFile(abs);
			const form = new FormData();
			form.append(
				"file",
				new Blob([bytes], { type: mimeFor(abs) }),
				path.basename(abs),
			);
			form.append("alt", title);
			const up = await api("/_emdash/api/media", { method: "POST", body: form });
			if (!up.ok) throw new Error(`media ${up.status}: ${JSON.stringify(up.body).slice(0, 200)}`);
			const mediaId = up.body?.data?.item?.id ?? up.body?.item?.id;
			if (!mediaId) throw new Error("no media id returned");

			// The upload endpoint ignores an `alt` form field, so set it in a
			// follow-up PUT (PATCH is not routed). Non-fatal: a photo without alt
			// text is still worth importing.
			await api(`/_emdash/api/media/${mediaId}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ alt: title }),
			}).catch(() => {});

			// 2. create the photo entry
			const create = await api("/_emdash/api/content/photos", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					data: {
						title,
						caption: photo.caption || undefined,
						image: mediaId,
						source_ref: photo.uri,
						taken_at: photo.takenAt?.toISOString(),
					},
				}),
			});
			if (!create.ok) throw new Error(`create ${create.status}: ${JSON.stringify(create.body).slice(0, 200)}`);
			const id = create.body?.data?.item?.id;

			// 3. publish, backdated to when it was taken -- only if asked
			if (PUBLISH) {
				const pub = await api(`/_emdash/api/content/photos/${id}/publish`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						photo.takenAt ? { publishedAt: photo.takenAt.toISOString() } : {},
					),
				});
				if (!pub.ok) throw new Error(`publish ${pub.status}`);
			}

			created++;
			process.stdout.write(`\r  imported ${created}…`);
		} catch (error) {
			failed++;
			console.warn(`\n  failed: ${photo.uri}\n    ${error.message}`);
		}
	}

	console.log(
		`\n\nDone. ${created} imported as ${PUBLISH ? "published" : "drafts"}, ` +
			`${skipped} already present, ${failed} failed.`,
	);
	if (!PUBLISH && created > 0) {
		console.log("Review them in the admin, then publish the ones you want public.");
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
