import { Plugin, setTooltip } from 'obsidian';

const LONG_PRESS_MS = 500;
const VISIBLE_MS = 2000;
const MOVE_CANCEL_PX = 10;

/**
 * The element a touch long-press most recently revealed a tooltip on, so the click-suppression
 * listener (see {@link initTouchTooltipSupport}) knows to swallow the tap that follows -- otherwise
 * holding to read a button's tooltip on a touchscreen also activates it the moment you lift your
 * finger, since a long-press-then-release still fires a normal `click`.
 */
let lastLongPressElement: HTMLElement | null = null;
let installed = false;

/** Cleanup callbacks for whatever bubbles and long-press timers are live right now, so unloading the plugin can drop them. */
const liveCleanups = new Set<() => void>();

function resetTouchTooltipState(): void {
	for (const cleanup of [...liveCleanups]) cleanup();
	liveCleanups.clear();
	lastLongPressElement = null;
	installed = false;
}

/** Elements whose long-press listeners are already wired, so calling `attachTooltip()` again on the same element (e.g. a button whose label/tooltip changes, like Read -> Regenerate) only refreshes the tooltip text instead of stacking a second set of listeners. */
const wiredElements = new WeakSet<HTMLElement>();

/**
 * Installs the one document-level listener {@link attachTooltip} depends on, for the plugin's
 * lifetime. Idempotent -- safe to call from every view that uses `attachTooltip()`, not just once.
 */
export function initTouchTooltipSupport(plugin: Plugin): void {
	if (installed) return;
	installed = true;
	// Reset on unload so re-enabling the plugin without restarting Obsidian installs the click handler again.
	plugin.register(resetTouchTooltipState);
	plugin.registerDomEvent(
		document,
		'click',
		(evt) => {
			if (!lastLongPressElement) return;
			if (evt.target instanceof Node && lastLongPressElement.contains(evt.target)) {
				lastLongPressElement = null;
				evt.preventDefault();
				evt.stopImmediatePropagation();
			}
		},
		true,
	);
}

/**
 * Attaches a tooltip that works from both a mouse and a touchscreen. Obsidian's own `setTooltip()`
 * already covers mouse hover -- but its underlying mechanism explicitly excludes touch input (its
 * `pointerover` handler short-circuits whenever `pointerType !== 'mouse'`, confirmed in the installed
 * app's own app.js), and there's no separate long-press equivalent built in. This adds one: holding a
 * touch point on `el` for ~500ms without moving shows a small bubble styled like Obsidian's own
 * tooltip (reusing its `tooltip`/`tooltip-arrow` classes), auto-dismissed after a couple of seconds or
 * on release, and suppresses the click that would otherwise follow.
 *
 * Idempotent per element: safe to call again on the same `el` (e.g. when its label/tooltip changes)
 * to just refresh the text -- only the first call wires up the long-press listeners.
 */
export function attachTooltip(el: HTMLElement, text: string): void {
	setTooltip(el, text);
	if (wiredElements.has(el)) return;
	wiredElements.add(el);

	let timer: number | null = null;
	let bubble: HTMLElement | null = null;
	let startX = 0;
	let startY = 0;

	let hideTimer: number | null = null;

	const clearTimer = () => {
		if (timer === null) return;
		window.clearTimeout(timer);
		timer = null;
		releaseIfIdle();
	};

	const removeBubble = () => {
		if (hideTimer !== null) {
			window.clearTimeout(hideTimer);
			hideTimer = null;
		}
		bubble?.remove();
		bubble = null;
		releaseIfIdle();
	};

	/** Stops tracking this element for unload cleanup once it has no live timer or bubble. */
	const releaseIfIdle = () => {
		if (timer === null && bubble === null) liveCleanups.delete(cleanup);
	};

	const cleanup = () => {
		clearTimer();
		removeBubble();
	};

	const showBubble = () => {
		timer = null;
		removeBubble();

		// Read the live aria-label rather than closing over the `text` param -- attachTooltip() may
		// have been called again since with an updated tooltip (e.g. Read -> Regenerate), and
		// setTooltip() always keeps aria-label current.
		const doc = el.ownerDocument;
		bubble = doc.body.createDiv({ cls: 'tooltip note-narrator-touch-tooltip', text: el.getAttribute('aria-label') ?? text });
		bubble.createDiv({ cls: 'tooltip-arrow' });
		bubble.setCssStyles({ position: 'fixed' });

		const anchorRect = el.getBoundingClientRect();
		const bubbleRect = bubble.getBoundingClientRect();
		const viewportWidth = doc.defaultView?.innerWidth ?? anchorRect.right;
		const top = Math.max(anchorRect.top - bubbleRect.height - 8, 4);
		const left = Math.min(Math.max(anchorRect.left + anchorRect.width / 2 - bubbleRect.width / 2, 4), viewportWidth - bubbleRect.width - 4);
		bubble.setCssStyles({ top: `${top}px`, left: `${left}px` });

		lastLongPressElement = el;
		liveCleanups.add(cleanup);
		hideTimer = window.setTimeout(removeBubble, VISIBLE_MS);
	};

	el.addEventListener('pointerdown', (evt: PointerEvent) => {
		if (evt.pointerType === 'mouse') return;
		clearTimer();
		startX = evt.clientX;
		startY = evt.clientY;
		timer = window.setTimeout(showBubble, LONG_PRESS_MS);
		liveCleanups.add(cleanup);
	});
	el.addEventListener('pointermove', (evt: PointerEvent) => {
		if (evt.pointerType === 'mouse' || timer === null) return;
		if (Math.abs(evt.clientX - startX) > MOVE_CANCEL_PX || Math.abs(evt.clientY - startY) > MOVE_CANCEL_PX) clearTimer();
	});
	el.addEventListener('pointerup', clearTimer);
	el.addEventListener('pointercancel', () => {
		clearTimer();
		removeBubble();
	});
}
