import { vimeoEmbedUrl, youtubeEmbedUrl } from "./video-links";
import { bindShare } from "./rail";

/**
 * The feed's player logic: which panel is active, what gets a player, what
 * plays, and the small state machine around each one.
 *
 * - An IntersectionObserver at 0.6 sets the active panel — never a click,
 *   or the scroll handler and the click would disagree.
 * - Only three players exist at a time: the active one and its neighbours.
 *   Everything else is a poster. Hosted embeds (YouTube, Vimeo) are only
 *   created when active, because an iframe with autoplay starts the moment
 *   it exists, whether or not it is on screen.
 * - The poster stays until the player has actually painted a frame.
 * - Muted autoplay is normally allowed but not always — iOS Low Power Mode
 *   blocks it outright. When play() is refused the panel shows the play
 *   glyph, so one tap starts it rather than two.
 * - Sound is one setting for the whole feed: unmute once and the next clips
 *   come in with sound, like every other short-video feed.
 */

type Source =
	| { kind: "file"; src: string }
	| { kind: "youtube"; id: string }
	| { kind: "vimeo"; ref: string };

const SOUND_KEY = "feed-sound";
const YT_ORIGIN = "https://www.youtube-nocookie.com";
const VIMEO_ORIGIN = "https://player.vimeo.com";

function readSound(): boolean {
	try {
		return sessionStorage.getItem(SOUND_KEY) === "1";
	} catch {
		return false;
	}
}

function writeSound(on: boolean) {
	try {
		sessionStorage.setItem(SOUND_KEY, on ? "1" : "0");
	} catch {
		/* private mode */
	}
}

class Player {
	readonly box: HTMLElement;
	readonly source: Source;
	private el: HTMLVideoElement | HTMLIFrameElement | null = null;
	private ring: HTMLElement | null;
	private glyph: HTMLElement | null;
	private painted = false;
	private blocked = false;
	private failed = false;
	private userPaused = false;
	private held = false;
	private embedTimer: number | undefined;
	active = false;

	constructor(box: HTMLElement) {
		this.box = box;
		const { videoSrc, videoId, vimeo } = box.dataset;
		this.source = videoSrc
			? { kind: "file", src: videoSrc }
			: vimeo
				? { kind: "vimeo", ref: vimeo }
				: { kind: "youtube", id: videoId ?? "" };
		this.ring = box.querySelector("[data-ring]");
		this.glyph = box.querySelector("[data-play]");
	}

	get isFile() {
		return this.source.kind === "file";
	}

	get isPlaying() {
		return this.el instanceof HTMLVideoElement ? !this.el.paused : this.active && !!this.el;
	}

	owns(source: MessageEventSource | null) {
		return this.el instanceof HTMLIFrameElement && this.el.contentWindow === source;
	}

	/** Neighbour panels get a paused file player so the swipe lands on a warm one. */
	mount(preload: "auto" | "metadata") {
		if (!this.isFile) return;
		if (this.el) {
			(this.el as HTMLVideoElement).preload = preload;
			return;
		}
		const video = document.createElement("video");
		video.src = (this.source as { src: string }).src;
		video.playsInline = true;
		video.muted = true;
		video.loop = true;
		video.preload = preload;
		// A loading indicator, not a controls bar: the rail has mute and
		// fullscreen, and a tap toggles play.
		video.addEventListener("timeupdate", () => {
			if (!this.painted && video.currentTime > 0) this.setPainted();
		});
		video.addEventListener("waiting", () => this.refresh());
		video.addEventListener("playing", () => {
			this.blocked = false;
			this.refresh();
		});
		video.addEventListener("pause", () => this.refresh());
		video.addEventListener("error", () => {
			this.failed = true;
			this.refresh();
		});
		this.el = video;
		this.box.insertBefore(video, this.box.firstChild);
	}

	private mountEmbed(soundOn: boolean) {
		if (this.el) return;
		const iframe = document.createElement("iframe");
		iframe.src =
			this.source.kind === "youtube"
				? youtubeEmbedUrl(this.source.id, {
						autoplay: "1",
						mute: soundOn ? "0" : "1",
						origin: location.origin,
					})
				: vimeoEmbedUrl((this.source as { ref: string }).ref, {
						autoplay: "1",
						muted: soundOn ? "0" : "1",
					});
		iframe.title = this.box.dataset.title ?? "Video";
		iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
		iframe.allowFullscreen = true;
		iframe.addEventListener("load", () => {
			this.subscribeEmbed();
			// The player will tell us when it plays; if it never does, don't
			// leave the poster over a running video.
			this.embedTimer = window.setTimeout(() => this.setPainted(), 1500);
		});
		this.el = iframe;
		this.box.insertBefore(iframe, this.box.firstChild);
	}

	/** Ask the embedded player to report playback, so the poster can drop on its first frame. */
	private subscribeEmbed() {
		const win = (this.el as HTMLIFrameElement | null)?.contentWindow;
		if (!win) return;
		if (this.source.kind === "youtube") {
			win.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), YT_ORIGIN);
		} else {
			win.postMessage(JSON.stringify({ method: "addEventListener", value: "play" }), VIMEO_ORIGIN);
		}
	}

	/** A message from this player's iframe. */
	onMessage(data: unknown) {
		if (typeof data === "string") {
			try {
				data = JSON.parse(data);
			} catch {
				return;
			}
		}
		const d = data as { event?: string; info?: number | { playerState?: number } };
		const playing =
			d.event === "play" ||
			(d.event === "onStateChange" && d.info === 1) ||
			(d.event === "infoDelivery" && typeof d.info === "object" && d.info?.playerState === 1);
		if (playing) this.setPainted();
	}

	private setPainted() {
		if (this.painted) return;
		this.painted = true;
		window.clearTimeout(this.embedTimer);
		this.box.classList.add("is-painted");
		this.refresh();
	}

	play(soundOn: boolean) {
		this.active = true;
		this.userPaused = false;
		if (this.isFile) {
			this.mount("auto");
			const video = this.el as HTMLVideoElement;
			video.muted = !soundOn;
			this.refresh();
			video.play().then(
				() => {
					this.blocked = false;
					this.refresh();
				},
				() => {
					// Autoplay refused (Low Power Mode, or a browser that wants a
					// gesture). Say so with the glyph; one tap starts it.
					this.blocked = true;
					this.refresh();
				},
			);
		} else {
			this.mountEmbed(soundOn);
			this.refresh();
		}
	}

	/** Leaving the panel: stop the sound at once, keep the element for a neighbour. */
	pause() {
		this.active = false;
		if (this.el instanceof HTMLVideoElement) this.el.pause();
		else this.unmount();
		this.refresh();
	}

	/** Paused by the caption sheet or a hidden page, not the viewer: resume after. */
	hold() {
		this.held = true;
		if (this.el instanceof HTMLVideoElement) this.el.pause();
		this.refresh();
	}

	resume(soundOn: boolean) {
		this.held = false;
		if (this.userPaused) {
			this.refresh();
			return;
		}
		if (this.el instanceof HTMLVideoElement) {
			this.el.play().then(
				() => this.refresh(),
				() => this.refresh(),
			);
		} else if (this.active) this.play(soundOn);
	}

	unmount() {
		window.clearTimeout(this.embedTimer);
		if (this.el instanceof HTMLVideoElement) this.el.pause();
		this.el?.remove();
		this.el = null;
		this.painted = false;
		this.blocked = false;
		this.failed = false;
		this.userPaused = false;
		this.held = false;
		this.box.classList.remove("is-painted");
		this.refresh();
	}

	/** A tap on a file player toggles it; embeds handle their own taps. */
	toggle(soundOn: boolean) {
		if (!(this.el instanceof HTMLVideoElement)) return;
		if (this.el.paused) {
			this.userPaused = false;
			this.el.muted = !soundOn;
			this.el.play().then(
				() => {
					this.blocked = false;
					this.refresh();
				},
				() => this.refresh(),
			);
		} else {
			this.userPaused = true;
			this.el.pause();
		}
		this.refresh();
	}

	setMuted(muted: boolean) {
		if (this.el instanceof HTMLVideoElement) {
			this.el.muted = muted;
			return;
		}
		const win = (this.el as HTMLIFrameElement | null)?.contentWindow;
		if (!win) return;
		if (this.source.kind === "youtube") {
			win.postMessage(
				JSON.stringify({ event: "command", func: muted ? "mute" : "unMute", args: [] }),
				YT_ORIGIN,
			);
		} else {
			win.postMessage(JSON.stringify({ method: "setMuted", value: muted }), VIMEO_ORIGIN);
			win.postMessage(JSON.stringify({ method: "setVolume", value: muted ? 0 : 1 }), VIMEO_ORIGIN);
		}
	}

	fullscreen() {
		type Prefixed = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
		type NativeVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
		const box = this.box as Prefixed;
		const video = this.el instanceof HTMLVideoElement ? (this.el as NativeVideo) : null;

		// iPhone has no element fullscreen at all; the native player is the way
		// in, and it rotates to landscape.
		const native = () => {
			if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
			else if (this.el instanceof HTMLIFrameElement) this.el.requestFullscreen?.().catch(() => {});
		};

		// Everywhere else, fullscreen the box rather than the video so the
		// poster, ring and play glyph come along.
		const request = box.requestFullscreen?.bind(box) ?? box.webkitRequestFullscreen?.bind(box);
		if (!request) {
			native();
			return;
		}
		try {
			const result = request();
			if (result && typeof (result as Promise<void>).catch === "function") {
				(result as Promise<void>).catch(native);
			}
		} catch {
			native();
		}
	}

	/** Derive the overlays from state. */
	private refresh() {
		const video = this.el instanceof HTMLVideoElement ? this.el : null;
		const paused = video ? video.paused : false;
		// Whatever paused an active clip — the viewer, a refused autoplay, the
		// browser backgrounding the page — it needs a tap target to come back.
		// Only a sheet-hold hides it, since the sheet is covering the clip.
		const showGlyph = this.active && !!video && !this.held && (this.blocked || this.failed || paused);
		const showRing =
			this.active && !!this.el && !this.painted && !this.blocked && !this.failed && !paused;
		if (this.glyph) this.glyph.hidden = !showGlyph;
		if (this.ring) this.ring.hidden = !showRing;
		if (this.failed) this.box.classList.remove("is-painted");
	}
}

export function mountFeed(feed: HTMLElement) {
	const panels = [...feed.querySelectorAll<HTMLElement>("[data-panel]")];
	const players = new Map<number, Player>();
	panels.forEach((panel, i) => {
		const box = panel.querySelector<HTMLElement>("[data-player]");
		if (box) players.set(i, new Player(box));
	});

	let soundOn = readSound();
	let active = -1;
	let heldBySheet = false;

	const muteButtons = [...feed.querySelectorAll<HTMLElement>("[data-mute]")];
	const paintMute = () => {
		for (const b of muteButtons) {
			b.dataset.muted = String(!soundOn);
			b.setAttribute("aria-label", soundOn ? "Mute" : "Unmute");
		}
	};
	paintMute();

	const apply = () => {
		for (const [i, player] of players) {
			const distance = Math.abs(i - active);
			if (distance === 0) player.play(soundOn);
			else if (distance === 1 && player.isFile) {
				player.pause();
				player.mount("metadata");
			} else {
				player.pause();
				player.unmount();
			}
		}
	};

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const i = panels.indexOf(entry.target as HTMLElement);
				if (i !== active) {
					active = i;
					apply();
				}
			}
		},
		{ root: feed, threshold: 0.6 },
	);
	panels.forEach((p) => observer.observe(p));

	// Messages from embedded players, routed to whichever iframe sent them.
	window.addEventListener("message", (event) => {
		if (event.origin !== YT_ORIGIN && event.origin !== VIMEO_ORIGIN) return;
		for (const player of players.values()) {
			if (player.owns(event.source)) player.onMessage(event.data);
		}
	});

	feed.addEventListener("click", (event) => {
		const target = event.target as HTMLElement;
		if (target.closest("[data-mute]")) {
			soundOn = !soundOn;
			writeSound(soundOn);
			paintMute();
			players.get(active)?.setMuted(!soundOn);
			return;
		}
		if (target.closest("[data-fullscreen]")) {
			players.get(active)?.fullscreen();
			return;
		}
		if (target.closest("[data-share], [data-reactions], .cap, .action-rail")) return;

		const box = target.closest<HTMLElement>("[data-player]");
		if (!box) return;
		for (const player of players.values()) {
			if (player.box === box) player.toggle(soundOn);
		}
	});

	bindShare(feed);

	// Reading the full caption pauses the video underneath; closing resumes
	// it — unless the viewer had already paused it, in which case it stays.
	document.addEventListener("sheet:open", () => {
		const player = players.get(active);
		if (player?.isPlaying) {
			player.hold();
			heldBySheet = true;
		}
	});
	document.addEventListener("sheet:close", () => {
		if (!heldBySheet) return;
		heldBySheet = false;
		players.get(active)?.resume(soundOn);
	});

	document.addEventListener("visibilitychange", () => {
		const player = players.get(active);
		if (!player) return;
		if (document.hidden) player.hold();
		else player.resume(soundOn);
	});

	const hint = feed.querySelector<HTMLElement>("[data-swipe-hint]");
	if (hint) {
		feed.addEventListener("scroll", () => hint.classList.add("is-gone"), { once: true, passive: true });
	}
}
