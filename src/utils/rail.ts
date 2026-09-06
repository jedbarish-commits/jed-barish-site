/**
 * Share button behaviour, shared by the home feed and the photo viewer.
 * The native share sheet where there is one; otherwise the link goes to the
 * clipboard with a small toast so the tap visibly did something.
 */
export function bindShare(root: HTMLElement) {
	root.addEventListener("click", (event) => {
		const button = (event.target as HTMLElement).closest<HTMLElement>("[data-share]");
		if (!button) return;
		event.preventDefault();
		const url = new URL(button.dataset.shareUrl ?? location.href, location.href).href;
		const title = button.dataset.shareTitle ?? document.title;
		if (navigator.share) {
			navigator.share({ title, url }).catch(() => {
				/* dismissed */
			});
			return;
		}
		navigator.clipboard
			?.writeText(url)
			.then(() => toast("Link copied"))
			.catch(() => toast(url));
	});
}

let toastTimer: number | undefined;
export function toast(text: string) {
	let el = document.querySelector<HTMLElement>("[data-toast]");
	if (!el) {
		el = document.createElement("div");
		el.dataset.toast = "";
		el.setAttribute("role", "status");
		Object.assign(el.style, {
			position: "fixed",
			left: "50%",
			bottom: "calc(env(safe-area-inset-bottom, 0px) + 110px)",
			transform: "translateX(-50%)",
			zIndex: "95",
			padding: "10px 16px",
			borderRadius: "999px",
			background: "rgb(255 255 255 / 0.92)",
			color: "#111",
			fontSize: "0.875rem",
			fontWeight: "600",
			maxWidth: "80vw",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			boxShadow: "0 6px 20px rgb(0 0 0 / 0.4)",
		});
		document.body.appendChild(el);
	}
	el.textContent = text;
	el.hidden = false;
	window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => {
		el!.hidden = true;
	}, 1800);
}
