/**
 * Video link parsing shared by the Studio composer, its oEmbed lookup and
 * the players.
 *
 * A video on this site is a reference plus metadata, not a file: YouTube and
 * Vimeo host it, the record stores the id, and the player resolves it at
 * render time. (Self-hosted files exist too, for the Instagram back
 * catalogue, but nothing new is expected to go that way.)
 */

export type VideoLink =
	| { provider: "youtube"; id: string; vertical?: boolean }
	| { provider: "vimeo"; id: string; hash?: string };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{5,}$/;

/**
 * Accepts full URLs, player URLs, unlisted-video hashes and a bare id —
 * someone reading an id off the Vimeo app shouldn't be told it's invalid.
 */
export function parseVideoLink(input: string): VideoLink | null {
	const raw = input.trim();
	if (!raw) return null;

	// Bare ids first: a YouTube id is 11 chars, a Vimeo id is all digits.
	if (VIMEO_ID.test(raw)) return { provider: "vimeo", id: raw };
	if (YT_ID.test(raw)) return { provider: "youtube", id: raw };

	let url: URL;
	try {
		url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		return null;
	}
	const host = url.hostname.replace(/^www\.|^m\./, "");
	const parts = url.pathname.split("/").filter(Boolean);

	if (host === "youtu.be") {
		const id = parts[0];
		return id && YT_ID.test(id) ? { provider: "youtube", id } : null;
	}

	if (host === "youtube.com" || host === "youtube-nocookie.com") {
		const v = url.searchParams.get("v");
		if (v && YT_ID.test(v)) return { provider: "youtube", id: v };
		// /shorts/ID, /embed/ID, /live/ID, /v/ID
		const [kind, id] = parts;
		if (id && YT_ID.test(id) && ["shorts", "embed", "live", "v"].includes(kind)) {
			return { provider: "youtube", id, vertical: kind === "shorts" || undefined };
		}
		return null;
	}

	if (host === "vimeo.com" || host === "player.vimeo.com") {
		// The numeric segment is the id wherever it sits: /ID, /ID/HASH,
		// /video/ID, /channels/x/ID, /groups/x/videos/ID, /manage/videos/ID.
		const at = parts.findIndex((p) => VIMEO_ID.test(p));
		if (at === -1) return null;
		const id = parts[at]!;
		const next = parts[at + 1];
		const hash =
			url.searchParams.get("h") ??
			(next && /^[A-Za-z0-9]{6,32}$/.test(next) && !VIMEO_ID.test(next) ? next : undefined);
		return hash ? { provider: "vimeo", id, hash } : { provider: "vimeo", id };
	}

	return null;
}

/** Stored form of a Vimeo reference: "id" or "id:hash" for unlisted videos. */
export function vimeoRef(id: string, hash?: string | null): string {
	return hash ? `${id}:${hash}` : id;
}

export function splitVimeoRef(ref: string): { id: string; hash?: string } {
	const [id, hash] = ref.split(":");
	return hash ? { id: id!, hash } : { id: id! };
}

/**
 * Embed URL with captions on. `texttrack` has to be in the query, before any
 * `#t=` fragment — appended after the hash it lands in the fragment and Vimeo
 * never reads it.
 */
export function vimeoEmbedUrl(ref: string, extra: Record<string, string> = {}): string {
	const { id, hash } = splitVimeoRef(ref);
	const params = new URLSearchParams({
		texttrack: "en",
		dnt: "1",
		playsinline: "1",
		title: "0",
		byline: "0",
		portrait: "0",
		...(hash ? { h: hash } : {}),
		...extra,
	});
	return `https://player.vimeo.com/video/${id}?${params}`;
}

export function youtubeEmbedUrl(id: string, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams({
		playsinline: "1",
		rel: "0",
		modestbranding: "1",
		// Captions on by default.
		cc_load_policy: "1",
		...extra,
	});
	return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}

export function watchUrl(link: VideoLink): string {
	return link.provider === "youtube"
		? `https://www.youtube.com/watch?v=${link.id}`
		: `https://vimeo.com/${link.id}${link.hash ? `/${link.hash}` : ""}`;
}
