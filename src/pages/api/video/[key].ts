import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

/**
 * Range-capable video serving, straight from the R2 bucket.
 *
 * EmDash's own media endpoint returns the whole file with a 200 even when the
 * client asks for a byte range. That is fine for images but wrong for video:
 * seeking needs 206 Partial Content, every play otherwise pulls the entire
 * file, and iOS Safari commonly refuses to start playback at all when a range
 * request is answered with a full-body 200.
 *
 * R2's get() takes a range option, so this reads only what was asked for.
 */

function bucket(): R2Bucket | null {
	const binding = (env as unknown as { MEDIA?: unknown } | undefined)?.MEDIA;
	return binding && typeof binding === "object" ? (binding as R2Bucket) : null;
}

/** Parse a single "bytes=start-end" range. Multi-range is not supported. */
function parseRange(header: string | null, size: number) {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;

	const [, rawStart, rawEnd] = match;
	if (rawStart === "" && rawEnd === "") return null;

	let start: number;
	let end: number;
	if (rawStart === "") {
		// "bytes=-500" — the final 500 bytes.
		const suffix = Number(rawEnd);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === "" ? size - 1 : Number(rawEnd);
	}

	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	if (start > end || start >= size) return null;
	return { start, end: Math.min(end, size - 1) };
}

export const GET: APIRoute = async ({ params, request }) => {
	const store = bucket();
	if (!store) return new Response("No storage binding", { status: 503 });

	const key = params.key;
	// Keys are generated ULIDs plus an extension; refuse anything else so this
	// cannot be pointed at arbitrary objects.
	if (!key || !/^[A-Za-z0-9._-]{1,128}$/.test(key) || key.includes("..")) {
		return new Response("Bad key", { status: 400 });
	}

	const head = await store.head(key);
	if (!head) return new Response("Not found", { status: 404 });

	const size = head.size;
	const type = head.httpMetadata?.contentType ?? "video/mp4";
	const common = {
		"Content-Type": type,
		"Cache-Control": "public, max-age=31536000, immutable",
		"Accept-Ranges": "bytes",
		ETag: head.httpEtag,
	};

	const range = parseRange(request.headers.get("Range"), size);

	if (!range) {
		const object = await store.get(key);
		if (!object) return new Response("Not found", { status: 404 });
		return new Response(object.body, {
			status: 200,
			headers: { ...common, "Content-Length": String(size) },
		});
	}

	const length = range.end - range.start + 1;
	const object = await store.get(key, {
		range: { offset: range.start, length },
	});
	if (!object) return new Response("Not found", { status: 404 });

	return new Response(object.body, {
		status: 206,
		headers: {
			...common,
			"Content-Length": String(length),
			"Content-Range": `bytes ${range.start}-${range.end}/${size}`,
		},
	});
};
