/**
 * Split caption text into plain and link segments.
 *
 * Matches `https?://` and scheme-less `www.` — people type the second far
 * more often. A bare domain like `example.org` is deliberately not matched:
 * nothing distinguishes it from a sentence, so "e.g." and "Inc." would become
 * links. A scheme-less host gets `https://` prepended or the browser reads it
 * as a relative path.
 */
export type Segment = { text: string; href?: string };

const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

export function linkify(text: string): Segment[] {
	const out: Segment[] = [];
	let last = 0;
	for (const match of text.matchAll(URL_RE)) {
		const start = match.index ?? 0;
		let raw = match[0];
		// Trailing punctuation belongs to the sentence, not the URL.
		const trail = /[.,!?;:)\]]+$/.exec(raw)?.[0] ?? "";
		raw = raw.slice(0, raw.length - trail.length);
		if (start > last) out.push({ text: text.slice(last, start) });
		out.push({ text: raw, href: /^https?:\/\//i.test(raw) ? raw : `https://${raw}` });
		last = start + raw.length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out;
}
