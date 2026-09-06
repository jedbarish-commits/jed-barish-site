import type { APIRoute } from "astro";

export const prerender = false;

/**
 * Fetches an image on behalf of the Studio composer so the browser can upload
 * it to the media library: the poster a lookup returned, or a photo given by
 * URL. Image CDNs rarely send CORS headers, so the browser can't read those
 * bytes itself.
 *
 * Signed-in editors only, https only, images only, and capped in size — it
 * is an image fetcher, not a general proxy.
 */

const MAX_BYTES = 25 * 1024 * 1024;

const text = (body: string, status: number) =>
	new Response(body, { status, headers: { "Cache-Control": "no-store" } });

function acceptable(target: URL): boolean {
	if (target.protocol !== "https:") return false;
	const host = target.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
	// IP literals — there is nothing on a private network from a Worker, but
	// keep the rule simple: hostnames only.
	if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
	return true;
}

export const GET: APIRoute = async ({ url, locals }) => {
	if (!locals.user) return text("Sign in required", 401);

	let target: URL;
	try {
		target = new URL(url.searchParams.get("url") ?? "");
	} catch {
		return text("Bad url", 400);
	}
	if (!acceptable(target)) return text("Only https image URLs are fetched", 400);

	let upstream: Response;
	try {
		upstream = await fetch(target, {
			headers: { Accept: "image/*", "User-Agent": "Mozilla/5.0 (jedbarish.com studio)" },
			redirect: "follow",
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		return text("Could not reach that URL", 502);
	}
	if (!upstream.ok || !upstream.body) return text(`Upstream said ${upstream.status}`, 502);

	const type = (upstream.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
	if (!type.startsWith("image/")) return text(`That URL is ${type || "not an image"}`, 415);

	const declared = Number(upstream.headers.get("Content-Length") ?? "0");
	if (declared > MAX_BYTES) return text("Image is too large", 413);

	// Enforce the cap on the stream too — Content-Length is optional.
	let seen = 0;
	const capped = upstream.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > MAX_BYTES) controller.error(new Error("too large"));
				else controller.enqueue(chunk);
			},
		}),
	);

	const name = target.pathname.split("/").pop() || "image";
	return new Response(capped, {
		status: 200,
		headers: {
			"Content-Type": type,
			"Cache-Control": "no-store",
			"X-Source-Filename": encodeURIComponent(name),
		},
	});
};
