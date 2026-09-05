/**
 * Instagram posts have no title, so the importer takes the first line of the
 * caption and truncates it. That makes the title a prefix of the caption, and
 * rendering both prints the same sentence twice — once clipped, once in full.
 *
 * Returns true when the title carries nothing the caption doesn't already say.
 */
export function titleEchoesCaption(
	title: string | null | undefined,
	caption: string | null | undefined,
): boolean {
	if (!title || !caption) return false;

	const normalise = (value: string) =>
		value
			.replace(/[…]|\.\.\./g, "") // the truncation ellipsis
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();

	const t = normalise(title);
	const c = normalise(caption);
	if (!t) return false;

	// A title is redundant when the caption opens with it, which covers both
	// the truncated case and an untruncated single-line caption.
	return c === t || c.startsWith(t);
}
