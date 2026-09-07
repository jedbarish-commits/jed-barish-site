import type { ImageValue } from "emdash";

/**
 * A photo post is one entry with a cover (`image`) and, for a carousel, a
 * `gallery` — a JSON list of full image records, cover included, in order.
 * Full records rather than ids because a JSON field isn't hydrated by the
 * loader the way an image field is; storing what the media API returned
 * means rendering needs no lookups.
 */

export function isImageValue(value: unknown): value is ImageValue {
	return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

/** The slides to show for a photo post: the gallery when it has several, else the cover. */
export function slidesOf(data: { image?: ImageValue | null; gallery?: unknown }): ImageValue[] {
	const gallery = Array.isArray(data.gallery) ? data.gallery.filter(isImageValue) : [];
	if (gallery.length > 1) return gallery;
	return data.image ? [data.image] : [];
}

/**
 * Full-size URL for an image value. It may carry a direct src (a linked URL)
 * or a storage key (uploaded to R2); the viewer wants the original either way.
 */
export function fullImageSrc(image: ImageValue | null | undefined): string | undefined {
	if (!image) return undefined;
	if (typeof image.src === "string" && image.src) return image.src;
	const key =
		(typeof image.meta?.storageKey === "string" ? image.meta.storageKey : undefined) || image.id;
	return key ? `/_emdash/api/media/file/${key}` : undefined;
}
