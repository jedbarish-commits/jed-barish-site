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
import os from "node:os";
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

if (!EXPORT_DIR && !flag("fix-dates") && !flag("publish-all")) {
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
const VIDEO_EXT = new Set([".mp4"]);

function mimeFor(file) {
	const ext = path.extname(file).toLowerCase();
	return (
		{
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".png": "image/png",
			".webp": "image/webp",
			".heic": "image/heic",
			".mp4": "video/mp4",
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
function collectMedia(posts, extensions) {
	const out = [];

	const push = (item, fallbackCaption, fallbackTs, siblings) => {
		const uri = item.uri;
		if (!uri) return;
		if (!extensions.has(path.extname(uri).toLowerCase())) return;
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

/** Thrown when the token stops working part-way through a run. */
class AuthLostError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A few hundred uploads over several minutes will hit the occasional dropped
 * connection or 5xx. Those are retried with backoff. A 401 mid-run means the
 * token died, which retrying cannot fix — that aborts the run so the rest of
 * the export isn't burned through producing identical failures.
 */
const api = async (pathname, init = {}, attempt = 1) => {
	const MAX_ATTEMPTS = 4;
	let res;
	try {
		res = await fetch(`${SITE}${pathname}`, {
			...init,
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"X-EmDash-Request": "1",
				...(init.headers ?? {}),
			},
		});
	} catch (error) {
		// Network-level failure (dropped connection, DNS, sleep/wake).
		if (attempt < MAX_ATTEMPTS) {
			await sleep(attempt * 1000);
			return api(pathname, init, attempt + 1);
		}
		throw error;
	}

	if (res.status === 401) {
		throw new AuthLostError(
			"The API token stopped being accepted part-way through the run.\n" +
				"It has most likely expired or been revoked. Create a fresh token and\n" +
				"run the same command again — already-imported photos are skipped, so it\n" +
				"picks up where this left off.",
		);
	}

	if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
		await sleep(attempt * 1000);
		return api(pathname, init, attempt + 1);
	}

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
	let ok, status, body;
	try {
		({ ok, status, body } = await api("/_emdash/api/content/photos?limit=1"));
	} catch (error) {
		// api() throws on 401 so a mid-run token death aborts the import. At
		// startup that is just a bad token, and deserves the fuller diagnosis
		// below rather than "it stopped working part-way through".
		if (!(error instanceof AuthLostError)) throw error;
		ok = false;
		status = 401;
		body = null;
	}
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

async function alreadyImported(collection = "photos") {
	const seen = new Set();
	let cursor;
	do {
		const qs = new URLSearchParams({ limit: "100" });
		if (cursor) qs.set("cursor", cursor);
		const { ok, status, body } = await api(`/_emdash/api/content/${collection}?${qs}`);
		// Never swallow this: an unreadable list means dedupe is blind, and
		// continuing would re-import everything on the next run.
		if (!ok) {
			throw new Error(
				`Could not list existing ${collection} (HTTP ${status}). Aborting rather ` +
					"than risk duplicate imports.",
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

/**
 * Publishing from the admin stamps published_at with "now", so an imported
 * back catalogue ends up all dated the day it was imported. This rewrites
 * published_at to the photo's taken_at, which is the date it was actually
 * posted on Instagram. Safe to re-run.
 */
async function fixDates() {
	await preflight();

	const items = [];
	let cursor;
	do {
		const qs = new URLSearchParams({ limit: "100" });
		if (cursor) qs.set("cursor", cursor);
		const { ok, status, body } = await api(`/_emdash/api/content/${collection}?${qs}`);
		if (!ok) throw new Error(`Could not list photos (HTTP ${status}).`);
		items.push(...(body?.data?.items ?? []));
		cursor = body?.data?.nextCursor;
	} while (cursor);

	let fixed = 0;
	let skipped = 0;
	for (const item of items) {
		const taken = item?.data?.taken_at;
		if (!taken) {
			skipped++;
			continue;
		}
		const want = new Date(taken).toISOString();
		if (item.publishedAt && new Date(item.publishedAt).toISOString() === want) {
			skipped++;
			continue;
		}
		if (item.status !== "published") {
			// Nothing to correct until it is published.
			skipped++;
			continue;
		}
		const res = await api(`/_emdash/api/content/photos/${item.id}/publish`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ publishedAt: want }),
		});
		if (res.ok) {
			fixed++;
			process.stdout.write(`\r  redated ${fixed}…`);
		} else {
			console.warn(`\n  failed ${item.id}: HTTP ${res.status}`);
		}
	}
	console.log(
		`\n\nDone. ${fixed} redated to their original post date, ${skipped} left alone.`,
	);
}

/** Lowercase, hyphenated, ASCII-ish — close enough to match EmDash's own. */
function slugify(text) {
	return String(text)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/, "");
}

/**
 * Create a content entry, disambiguating a slug collision.
 *
 * EmDash derives the slug from the title, and a title here is the first line
 * of an Instagram caption — the same caption reused across posts produces the
 * same slug and the second create fails. The first attempt lets EmDash choose
 * so most entries keep a clean slug; only a collision falls back to appending
 * the Instagram media id, which is unique per item.
 */
async function createEntry(collection, data, sourceRef) {
	const body = (slug) =>
		JSON.stringify(slug ? { slug, data } : { data });
	const post = (slug) =>
		api(`/_emdash/api/content/${collection}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body(slug),
		});

	let res = await post();
	if (res.ok) return res;

	// Truncate the title part only — slicing the joined string could cut the
	// suffix off and collide all over again. Carousels are the common case:
	// every image in one inherits the post caption, so eleven images can share
	// a title.
	const unique = path.basename(sourceRef).replace(/\.[^.]+$/, "");
	const stem = slugify(data.title).slice(0, 80).replace(/-+$/, "");
	res = await post(`${stem}-${unique}`);
	if (res.ok) return res;

	throw new Error(
		`create ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
	);
}

/** Upload one local file into the media library, returning its media id. */
async function uploadFile(absPath, alt) {
	const bytes = await readFile(absPath);
	const form = new FormData();
	form.append(
		"file",
		new Blob([bytes], { type: mimeFor(absPath) }),
		path.basename(absPath),
	);
	const up = await api("/_emdash/api/media", { method: "POST", body: form });
	if (!up.ok) {
		throw new Error(`media ${up.status}: ${JSON.stringify(up.body).slice(0, 200)}`);
	}
	const id = up.body?.data?.item?.id ?? up.body?.item?.id;
	if (!id) throw new Error("no media id returned");
	if (alt) {
		await api(`/_emdash/api/media/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ alt }),
		}).catch(() => {});
	}
	return id;
}

/**
 * Instagram exports ship no poster image for videos, so pull a frame with
 * ffmpeg. One second in, falling back to the very first frame for clips
 * shorter than that. A poster is optional — a video without one still imports.
 */
async function posterFrame(videoPath) {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const run = promisify(execFile);
	const out = path.join(
		os.tmpdir(),
		`ig-poster-${path.basename(videoPath, ".mp4")}.jpg`,
	);
	for (const seek of ["1", "0"]) {
		try {
			await run("ffmpeg", ["-ss", seek, "-i", videoPath, "-frames:v", "1", "-q:v", "3", "-y", out]);
			if (existsSync(out)) return out;
		} catch {
			// try the next seek point
		}
	}
	return null;
}

/** Gather one media kind out of every posts file, deduplicated across them. */
async function gather(root, files, extensions) {
	const byUri = new Map();
	for (const file of files) {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		for (const item of collectMedia(parsed, extensions)) {
			// Files overlap; prefer whichever sighting actually has a caption.
			const existing = byUri.get(item.uri);
			if (!existing || (!existing.caption && item.caption)) {
				byUri.set(item.uri, item);
			}
		}
	}
	const out = [...byUri.values()];
	out.sort((a, b) => (a.takenAt?.getTime() ?? 0) - (b.takenAt?.getTime() ?? 0));
	return out;
}

async function importPhotos(root, items) {
	const seen = await alreadyImported("photos");
	console.log(`Photos: ${seen.size} already imported.`);

	let created = 0, skipped = 0, failed = 0;
	for (const photo of items) {
		if (seen.has(photo.uri)) { skipped++; continue; }
		const abs = path.join(root, photo.uri);
		if (!existsSync(abs)) { console.warn(`  missing file: ${photo.uri}`); failed++; continue; }

		const title = titleFrom(photo.caption, photo.takenAt);
		try {
			const mediaId = await uploadFile(abs, title);
			const create = await createEntry(
				"photos",
				{
					title,
					caption: photo.caption || undefined,
					image: mediaId,
					source_ref: photo.uri,
					taken_at: photo.takenAt?.toISOString(),
				},
				photo.uri,
			);
			if (PUBLISH) {
				const id = create.body?.data?.item?.id;
				await api(`/_emdash/api/content/photos/${id}/publish`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(photo.takenAt ? { publishedAt: photo.takenAt.toISOString() } : {}),
				});
			}
			created++;
			process.stdout.write(`\r  photos imported ${created}…`);
		} catch (error) {
			if (error instanceof AuthLostError) throw error;
			failed++;
			console.warn(`\n  failed: ${photo.uri}\n    ${error.message}`);
		}
	}
	console.log(`\nPhotos: ${created} imported, ${skipped} already present, ${failed} failed.`);
}

/**
 * Videos go into the Videos collection (slug "posts") alongside the YouTube
 * entries, with the file in video_file and an ffmpeg-extracted poster as the
 * featured image.
 */
async function importVideos(root, items) {
	const seen = await alreadyImported("posts");
	console.log(`Videos: ${seen.size} already imported.`);

	let created = 0, skipped = 0, failed = 0;
	for (const video of items) {
		if (seen.has(video.uri)) { skipped++; continue; }
		const abs = path.join(root, video.uri);
		if (!existsSync(abs)) { console.warn(`  missing file: ${video.uri}`); failed++; continue; }

		const title = titleFrom(video.caption, video.takenAt);
		try {
			const videoId = await uploadFile(abs, title);

			// Poster is best-effort: a video without one still imports fine.
			let posterId;
			const poster = await posterFrame(abs);
			if (poster) {
				try {
					posterId = await uploadFile(poster, title);
				} catch {
					posterId = undefined;
				}
			}

			const create = await createEntry(
				"posts",
				{
					title,
					excerpt: video.caption || undefined,
					video_file: videoId,
					featured_image: posterId,
					source_ref: video.uri,
					taken_at: video.takenAt?.toISOString(),
				},
				video.uri,
			);
			if (PUBLISH) {
				const id = create.body?.data?.item?.id;
				await api(`/_emdash/api/content/posts/${id}/publish`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(video.takenAt ? { publishedAt: video.takenAt.toISOString() } : {}),
				});
			}
			created++;
			process.stdout.write(`\r  videos imported ${created}…`);
		} catch (error) {
			if (error instanceof AuthLostError) throw error;
			failed++;
			console.warn(`\n  failed: ${video.uri}\n    ${error.message}`);
		}
	}
	console.log(`\nVideos: ${created} imported, ${skipped} already present, ${failed} failed.`);
}

/**
 * Publish everything in both collections, dated to when it was taken.
 *
 * Publishing from the admin stamps published_at with "now", which for an
 * imported back catalogue means several hundred items all landing on the same
 * timestamp — and the site orders the feed by published_at. Publishing through
 * here backdates in the same call, so the ordering is right immediately rather
 * than needing a second pass.
 */
async function publishAll() {
	await preflight();

	for (const collection of ["photos", "posts"]) {
		const items = [];
		let cursor;
		do {
			const qs = new URLSearchParams({ limit: "100" });
			if (cursor) qs.set("cursor", cursor);
			const { ok, status, body } = await api(
				`/_emdash/api/content/${collection}?${qs}`,
			);
			if (!ok) throw new Error(`Could not list ${collection} (HTTP ${status}).`);
			items.push(...(body?.data?.items ?? []));
			cursor = body?.data?.nextCursor;
		} while (cursor);

		let published = 0;
		let redated = 0;
		let skipped = 0;
		let failed = 0;

		for (const item of items) {
			const taken = item?.data?.taken_at;
			const want = taken ? new Date(taken).toISOString() : null;
			const isDraft = item.status !== "published";
			const dateWrong =
				want && item.publishedAt
					? new Date(item.publishedAt).toISOString() !== want
					: false;

			if (!isDraft && !dateWrong) {
				skipped++;
				continue;
			}

			const res = await api(
				`/_emdash/api/content/${collection}/${item.id}/publish`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(want ? { publishedAt: want } : {}),
				},
			);
			if (res.ok) {
				if (isDraft) published++;
				else redated++;
				process.stdout.write(
					`\r  ${collection}: ${published} published, ${redated} redated…`,
				);
			} else {
				failed++;
				console.warn(`\n  failed ${item.id}: HTTP ${res.status}`);
			}
		}

		console.log(
			`\n${collection}: ${published} published, ${redated} redated, ` +
				`${skipped} already correct, ${failed} failed.`,
		);
	}
}

async function main() {
	if (flag("publish-all")) {
		await publishAll();
		return;
	}
	if (flag("fix-dates")) {
		await fixDates();
		return;
	}

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

	const only = opt("only");
	const wantPhotos = only !== "videos";
	const wantVideos = only !== "photos";

	let photos = wantPhotos ? await gather(root, files, IMAGE_EXT) : [];
	let videos = wantVideos ? await gather(root, files, VIDEO_EXT) : [];
	console.log(`\n${photos.length} image(s), ${videos.length} video(s) in the export.`);
	if (LIMIT) {
		photos = photos.slice(0, LIMIT);
		videos = videos.slice(0, LIMIT);
	}

	if (DRY_RUN) {
		console.log("\n--dry-run: nothing will be written.\n");
		for (const [label, list] of [["PHOTO", photos], ["VIDEO", videos]]) {
			for (const m of list.slice(0, 10)) {
				const when = m.takenAt ? m.takenAt.toISOString().slice(0, 10) : "(no date)";
				console.log(`  ${label}  ${when}  ${titleFrom(m.caption, m.takenAt)}`);
			}
			if (list.length > 10) console.log(`  … and ${list.length - 10} more ${label.toLowerCase()}s`);
		}
		return;
	}

	await preflight();
	if (wantPhotos) await importPhotos(root, photos);
	if (wantVideos) await importVideos(root, videos);
}

main().catch((error) => {
	if (error instanceof AuthLostError) {
		console.error(`\n\n${error.message}`);
		process.exit(1);
	}
	console.error(error);
	process.exit(1);
});
