/**
 * Keyboard navigation for a vertical scroll-snap container.
 *
 * Snap containers respond to arrow keys only when they hold focus, and the
 * feed is scrolled by swiping rather than clicked into — so on desktop the
 * arrows usually do nothing. This moves panel-to-panel explicitly.
 */
export function bindSnapKeys(
	container: HTMLElement,
	itemSelector: string,
	options: { isActive?: () => boolean } = {},
) {
	const isActive = options.isActive ?? (() => true);

	const items = () => [...container.querySelectorAll<HTMLElement>(itemSelector)];

	/** Index of the panel currently filling most of the container. */
	const currentIndex = () => {
		const list = items();
		const top = container.scrollTop;
		let best = 0;
		let bestGap = Number.POSITIVE_INFINITY;
		list.forEach((item, i) => {
			const gap = Math.abs(item.offsetTop - top);
			if (gap < bestGap) {
				bestGap = gap;
				best = i;
			}
		});
		return best;
	};

	/**
	 * Jumps rather than animates. Smooth scrolling is unreliable inside a
	 * `scroll-snap-type: mandatory` container — it silently does nothing in some
	 * engines — and an instant move matches how the feed already behaves when
	 * swiped, where each panel snaps into place.
	 */
	const go = (index: number) => {
		const list = items();
		if (list.length === 0) return;
		const target = list[Math.max(0, Math.min(index, list.length - 1))];
		if (!target) return;
		container.scrollTo({ top: target.offsetTop, behavior: "auto" });
	};

	document.addEventListener("keydown", (event) => {
		if (!isActive()) return;

		// Leave typing alone — the search field is a normal input.
		const target = event.target as HTMLElement | null;
		if (
			target &&
			(target.isContentEditable ||
				["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
		) {
			return;
		}

		// Don't steal browser and OS shortcuts.
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		switch (event.key) {
			case "ArrowDown":
			case "j":
			case "PageDown":
				event.preventDefault();
				go(currentIndex() + 1);
				break;
			case "ArrowUp":
			case "k":
			case "PageUp":
				event.preventDefault();
				go(currentIndex() - 1);
				break;
			case " ":
				// Space pages forward, Shift+Space back — the usual reading idiom.
				event.preventDefault();
				go(currentIndex() + (event.shiftKey ? -1 : 1));
				break;
			case "Home":
				event.preventDefault();
				go(0);
				break;
			case "End":
				event.preventDefault();
				go(items().length - 1);
				break;
			default:
				break;
		}
	});
}
