import type { APIRoute } from "astro";
import { parseVideoLink, type VideoLink } from "../../../utils/video-links";

export const prerender = false;

/**
 * Studio's link lookup. Proxies YouTube's and Vimeo's public oEmbed endpoints
 * — neither sends a CORS header, and proxying keeps URL validation here: only
 * those two hosts are ever fetched.
 *
 * Signed-in editors only. Nothing here is secret, but there's no reason to
 * run a lookup service for the public.
 */

export type Lookup = {
	provider: VideoLink["provider"];
	id: string;
	hash?: string;
	title: string | null;
	description: string | null;
	author: string | null;
	poster: string | null;
	duration: number | null;
	width: number | null;
	height: number | null;
	vertical: boolean;
	/**
	 * Vimeo won't describe "Embed only" videos to an unauthenticated caller —
	 * they're private on Vimeo but embed fine anywhere. All that proves is
	 * that Vimeo won't tell us the details, so the composer lets the editor
	 * type the title and still publishes.
	 */
	limited: boolean;
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

async function fetchJson(url: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
	const res = await fetch(url, {
		headers: { Accept: "application/json", "User-Agent": "jedbarish.com studio" },
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) return { status: res.status, body: null };
	try {
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	} catch {
		return { status: res.status, body: null };
	}
}

async function lookupYouTube(id: string, vertical: boolean): Promise<Lookup> {
	const watch = `https://www.youtube.com/watch?v=${id}`;
	const { body } = await fetchJson(
		`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
	);

	// oEmbed's thumbnail is the 480px hqdefault; the 1280px maxres exists for
	// most uploads but not all, so check before preferring it.
	let poster = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
	try {
		const maxres = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
		const head = await fetch(maxres, { method: "HEAD", signal: AbortSignal.timeout(4000) });
		if (head.ok) poster = maxres;
	} catch {
		// keep hqdefault
	}

	return {
		provider: "youtube",
		id,
		title: str(body?.title),
		description: null, // YouTube's oEmbed carries no description
		author: str(body?.author_name),
		poster,
		duration: null,
		width: null,
		height: null,
		vertical,
		limited: !body,
	};
}

/**
 * Fail-soft recovery for embed-only Vimeo videos: the player page is public
 * and carries the title and thumbnails in its config JSON. Undocumented, so
 * everything is read defensively — the page for an unavailable video also
 * contains strings like `"title":"Stream limit"` in unrelated objects, which
 * is why only the `"video":{…}` object is trusted for the title.
 */
async function scrapeVimeoPlayer(id: string, hash: string | undefined, referer: string) {
	try {
		const url = `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
		const res = await fetch(url, {
			headers: { Referer: referer, "User-Agent": "Mozilla/5.0 (jedbarish.com studio)" },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return null;
		const html = await res.text();
		const decode = (raw: string) => {
			try {
				return (JSON.parse(`"${raw}"`) as string).replace(/\\\//g, "/");
			} catch {
				return raw;
			}
		};

		// The video object, allowing one level of nesting for `thumbs`.
		const video = /"video":\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(html)?.[1] ?? "";
		const titleRaw = /"title":"((?:[^"\\]|\\.)*)"/.exec(video)?.[1];
		const w = /"width":(\d+)/.exec(video)?.[1];
		const h = /"height":(\d+)/.exec(video)?.[1];
		const thumbs = /"thumbs":\{([^}]*)\}/.exec(video)?.[1] ?? "";
		const thumbRaw =
			/"1280":"([^"]+)"/.exec(thumbs)?.[1] ??
			/"640":"([^"]+)"/.exec(thumbs)?.[1] ??
			/"base":"([^"]+)"/.exec(thumbs)?.[1];

		// Page-level fallbacks: "<title>Name on Vimeo</title>" and og:image.
		const pageTitle = /<title>([^<]*?)\s+on Vimeo<\/title>/i.exec(html)?.[1];
		const ogImage = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1];

		return {
			title: titleRaw ? decode(titleRaw) : pageTitle?.trim() || null,
			poster: thumbRaw ? decode(thumbRaw) : (ogImage ?? null),
			width: w ? Number(w) : null,
			height: h ? Number(h) : null,
		};
	} catch {
		return null;
	}
}

async function lookupVimeo(id: string, hash: string | undefined, referer: string): Promise<Lookup> {
	const page = `https://vimeo.com/${id}${hash ? `/${hash}` : ""}`;
	// width=1280 scales thumbnail_url up from the 640px default.
	const { body } = await fetchJson(
		`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(page)}&width=1280`,
	);

	if (body) {
		const width = num(body.width);
		const height = num(body.height);
		return {
			provider: "vimeo",
			id,
			hash,
			title: str(body.title),
			description: str(body.description),
			author: str(body.author_name),
			poster: str(body.thumbnail_url),
			duration: num(body.duration),
			width,
			height,
			vertical: !!(width && height && height > width),
			limited: false,
		};
	}

	const scraped = await scrapeVimeoPlayer(id, hash, referer);
	return {
		provider: "vimeo",
		id,
		hash,
		title: scraped?.title ?? null,
		description: null,
		author: null,
		poster: scraped?.poster ?? null,
		duration: null,
		width: scraped?.width ?? null,
		height: scraped?.height ?? null,
		vertical: !!(scraped?.width && scraped?.height && scraped.height > scraped.width),
		limited: true,
	};
}

export const GET: APIRoute = async ({ url, locals }) => {
	if (!locals.user) return json({ error: "Sign in required" }, 401);

	const input = url.searchParams.get("url") ?? "";
	const link = parseVideoLink(input);
	if (!link) return json({ error: "Not a YouTube or Vimeo link" }, 400);

	try {
		const result =
			link.provider === "youtube"
				? await lookupYouTube(link.id, !!link.vertical)
				: await lookupVimeo(link.id, link.hash, url.origin + "/");
		return json(result);
	} catch (error) {
		console.error("[studio/oembed]", error);
		return json({ error: "Lookup failed" }, 502);
	}
};
