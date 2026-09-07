#!/usr/bin/env node
/**
 * Regroup Instagram carousels into single photo posts.
 *
 * The importer had nowhere to put a multi-image post, so every image of a
 * carousel became its own photo entry carrying the whole caption. This reads
 * the export again to learn which images belonged together, in order, and
 * for each carousel:
 *
 *   - the entry for the first image becomes the post (its slug, URL and
 *     reactions survive) and gets a `gallery` of every slide, cover included;
 *   - the sibling entries go to the trash (recoverable, not deleted).
 *
 * Idempotent: a post that already has its gallery, or whose siblings are
 * gone, is skipped. Grouping comes from the export, never from guessing by
 * caption.
 *
 * Usage (the token is needed for both — a dry run reads, it just never writes):
 *   EMDASH_TOKEN=... node scripts/group-carousels.mjs --export ~/Downloads/instagram-export --dry-run
 *   EMDASH_TOKEN=... node scripts/group-carousels.mjs --export ~/Downloads/instagram-export
 *
 * The token comes from the environment on purpose: it never has to be pasted
 * anywhere that keeps a transcript.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const v = args[i + 1];
	return v && !v.startsWith("--") ? v : true;
};
const DRY = args.includes("--dry-run");
const LIMIT = Number(opt("limit", "0")) || 0;
const SITE = String(opt("site", "https://jedbarish.com")).replace(/\/$/, "");
const EXPORT_DIR = opt("export");
const TOKEN = process.env.EMDASH_TOKEN?.trim();
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);

if (!EXPORT_DIR || EXPORT_DIR === true) {
	console.error("Pass --export <instagram export folder>.");
	process.exit(1);
}
// Listing the site's photos needs the token even for a dry run; the dry run
// just never writes.
if (!TOKEN) {
	console.error("EMDASH_TOKEN is not set. Export it first (it is read from the environment, never from arguments).");
	process.exit(1);
}

// ---- export ---------------------------------------------------------------

function fixEncoding(value) {
	if (typeof value !== "string") return value;
	try {
		const repaired = Buffer.from(value, "latin1").toString("utf8");
		return repaired.includes("�") ? value : repaired;
	} catch {
		return value;
	}
}

async function findPostsFiles(root) {
	const found = [];
	for (const rel of ["your_instagram_activity/media", "your_instagram_activity/content", "content", "media"]) {
		const dir = path.join(root, rel);
		if (!existsSync(dir)) continue;
		for (const name of await readdir(dir)) {
			if (/^posts.*\.json$/i.test(name)) found.push(path.join(dir, name));
		}
	}
	return found;
}

/** Carousels only: posts with two or more images, as ordered lists of URIs. */
async function carouselsFromExport(root) {
	const groups = [];
	const seen = new Set();
	for (const file of await findPostsFiles(root)) {
		const json = JSON.parse(await readFile(file, "utf8"));
		const posts = Array.isArray(json) ? json : Array.isArray(json?.media) ? json.media : [];
		for (const post of posts) {
			const labels = Array.isArray(post.label_values) ? post.label_values : [];
			const media = [
				...(Array.isArray(post.media) ? post.media : []),
				...labels.flatMap((l) => (Array.isArray(l.media) ? l.media : [])),
			];
			const uris = media.map((m) => m.uri).filter((u) => u && IMAGE_EXT.has(path.extname(u).toLowerCase()));
			// The two export files overlap; a post seen once is done.
			const fresh = uris.filter((u) => !seen.has(u));
			uris.forEach((u) => seen.add(u));
			if (fresh.length >= 2) {
				groups.push({
					caption: fixEncoding(post.title ?? "") || fixEncoding(labels.find((l) => l.label === "Caption")?.value ?? ""),
					uris: fresh,
				});
			}
		}
	}
	return groups;
}

// ---- API ------------------------------------------------------------------

async function api(pathname, init = {}) {
	const headers = new Headers(init.headers);
	if (TOKEN) headers.set("Authorization", `Bearer ${TOKEN}`);
	let last;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(`${SITE}${pathname}`, { ...init, headers });
			const body = await res.json().catch(() => null);
			if (res.status === 401) throw Object.assign(new Error("Token rejected (401)."), { fatal: true });
			if (res.status >= 500) {
				last = new Error(`HTTP ${res.status}`);
				await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
				continue;
			}
			return { ok: res.ok, status: res.status, body };
		} catch (error) {
			if (error.fatal) throw error;
			last = error;
			await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
		}
	}
	throw last ?? new Error("request failed");
}

async function allPhotos() {
	const items = [];
	let cursor;
	do {
		const qs = new URLSearchParams({ limit: "100" });
		if (cursor) qs.set("cursor", cursor);
		const { ok, status, body } = await api(`/_emdash/api/content/photos?${qs}`);
		if (!ok) throw new Error(`Could not list photos (HTTP ${status}).`);
		items.push(...(body?.data?.items ?? []));
		cursor = body?.data?.nextCursor;
	} while (cursor);
	return items;
}

async function reactionCount(id) {
	try {
		const res = await fetch(`${SITE}/api/reactions?collection=photos&id=${encodeURIComponent(id)}`);
		const json = await res.json();
		return Object.values(json?.counts ?? {}).reduce((a, b) => a + b, 0);
	} catch {
		return 0;
	}
}

// ---- main -----------------------------------------------------------------

const groups = await carouselsFromExport(EXPORT_DIR);
console.log(`${groups.length} carousels in the export (${groups.reduce((n, g) => n + g.uris.length, 0)} images).`);

const probe = await api("/_emdash/api/content/photos?limit=1");
if (!probe.ok) throw new Error(`Token check failed (HTTP ${probe.status}).`);
const photos = await allPhotos();
const byRef = new Map();
for (const item of photos) {
	const ref = item?.data?.source_ref;
	if (ref) byRef.set(ref, item);
}
console.log(`${photos.length} photo entries on the site.`);

let merged = 0;
let trashed = 0;
let skipped = 0;
let failed = 0;
let done = 0;

for (const group of groups) {
	if (LIMIT && done >= LIMIT) break;
	const entries = group.uris.map((u) => byRef.get(u)).filter(Boolean);
	if (entries.length < 2) {
		skipped++;
		continue;
	}
	const post = entries[0];
	const already = Array.isArray(post.data?.gallery) && post.data.gallery.length >= 2;
	if (already) {
		skipped++;
		continue;
	}
	const siblings = entries.slice(1);
	// Every slide is the full image record the API already returns, plus the
	// slide's own source_ref so the importer still recognises it as imported.
	const gallery = entries.map((e) => ({ ...e.data.image, source_ref: e.data.source_ref }));
	const label = `${post.slug ?? post.id} (${entries.length} slides)`;

	const withReactions = [];
	for (const s of siblings) {
		const n = await reactionCount(s.id);
		if (n) withReactions.push(`${s.slug}: ${n}`);
	}

	if (DRY) {
		console.log(`would merge  ${label}${withReactions.length ? `  ⚠ reactions on siblings: ${withReactions.join(", ")}` : ""}`);
		done++;
		continue;
	}

	try {
		const put = await api(`/_emdash/api/content/photos/${post.id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: { gallery } }),
		});
		if (!put.ok) throw new Error(`update ${put.status}: ${JSON.stringify(put.body).slice(0, 160)}`);

		// Editing a published entry makes a draft revision; publish it again.
		// No publishedAt in the body, so the original date is kept.
		if (post.status === "published") {
			const pub = await api(`/_emdash/api/content/photos/${post.id}/publish`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			if (!pub.ok) throw new Error(`publish ${pub.status}`);
		}
		merged++;

		for (const s of siblings) {
			const del = await api(`/_emdash/api/content/photos/${s.id}`, { method: "DELETE" });
			if (del.ok) trashed++;
			else console.warn(`  could not trash ${s.slug}: HTTP ${del.status}`);
		}
		console.log(`merged  ${label}${withReactions.length ? `  ⚠ sibling reactions not carried over: ${withReactions.join(", ")}` : ""}`);
	} catch (error) {
		failed++;
		console.warn(`FAILED  ${label}: ${error.message}`);
		if (error.fatal) break;
	}
	done++;
}

console.log(
	DRY
		? `\nDry run: ${done} carousels would be merged, ${skipped} skipped (already grouped or slides missing).`
		: `\n${merged} merged, ${trashed} slides moved to trash, ${skipped} skipped, ${failed} failed.`,
);
