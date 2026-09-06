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

	// Newlines are kept: a title that is the caption's whole first line is
	// followed by one, and that is the signal we need.
	const normalise = (value: string) =>
		value
			.replace(/[…]|\.\.\./g, "") // the truncation ellipsis
			.replace(/[ \t]+/g, " ")
			.trim()
			.toLowerCase();

	const t = normalise(title);
	const c = normalise(caption);
	if (!t) return false;
	if (c === t) return true;
	if (!c.startsWith(t)) return false;

	// A clipped title ends in an ellipsis; a whole-line title is followed by a
	// break or punctuation. A title that merely opens a longer sentence —
	// "Big Buck Bunny" against "Big Buck Bunny tells the story of…" — is a
	// name, not an echo, and the caption still has something to say.
	if (/(…|\.\.\.)\s*$/.test(title.trim())) return true;
	const rest = c.slice(t.length).replace(/^ +/, "");
	return rest === "" || /^[\n.!?,:;—–|-]/.test(rest);
}
