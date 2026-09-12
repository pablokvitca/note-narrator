import { addIcon } from 'obsidian';
import { SKIP_SECONDS_OPTIONS, SkipSeconds } from './settings';

/** A saved-audio file with a play triangle on its corner, for the "Play saved" action -- distinct from the plain `play` triangle used for playback controls. */
export const PLAY_SAVED_ICON_ID = 'obsidian-reader-play-saved';

/*
 * Path coordinates below are authored in a 24x24 grid, matching Lucide's own icons -- but unlike
 * `setIcon()`'s built-in Lucide icons (rendered in a `viewBox="0 0 24 24"` SVG), Obsidian's
 * `addIcon()` always wraps custom icon content in a `viewBox="0 0 100 100"` container (confirmed in
 * the installed app's own app.js, not assumed). Without correcting for that, a 24-unit icon renders
 * as a tiny speck confined to a corner of that 100-unit canvas. The `<g transform="scale(...)">`
 * wrapper rescales the whole 24x24 drawing (paths, stroke widths, everything uniformly) up to fill
 * the real 100x100 viewBox, so it reads at the same visual size as its Lucide neighbors.
 */
const PLAY_SAVED_ICON_SVG = `
<g transform="scale(4.1667)">
<!-- File + waveform are shifted 1 unit up-left from the "natural" 24-unit layout (corner would
     otherwise sit at (17,21)), purely to leave enough headroom in the bottom-right corner for a
     play triangle large enough to read clearly without its tip clipping the 24-unit canvas edge. -->
<path d="M3 2h8l5 5v11a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M11 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
<!-- A centered two-peak waveform (seven bars), not a speaker glyph -- the file's main content. -->
<path d="M3 12.5V14.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
<path d="M4.8 10.3V16.7" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
<path d="M6.7 11.7V15.3" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
<path d="M8.5 12.5V14.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
<path d="M10.3 11.7V15.3" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
<path d="M12.2 10.3V16.7" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
<path d="M14 12.5V14.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
<!-- The play triangle: no circle around it, centroid at (16,20) -- the (shifted) file outline's
     exact bottom-right corner. Enlarged (r 3.4 -> 4.2) now that the shift above gives it room. -->
<path d="M20.2 20L13.9 23.6L13.9 16.4Z" fill="currentColor" stroke="none"/>
</g>
`;

/** Icon id for a rewind/skip-forward transport button showing the given duration, in the given direction. One custom icon per (seconds, direction) pair -- see {@link buildSkipIconSvg}. */
export function skipIconId(seconds: SkipSeconds, direction: 'back' | 'forward'): string {
	return `obsidian-reader-skip-${direction}-${seconds}`;
}

/*
 * A circular-arrow-with-a-number icon, the way most media players show a skip amount (Apple
 * Podcasts, YouTube's double-tap-to-skip, etc.) -- the arc+arrowhead shape is Lucide's own
 * `rotate-ccw` glyph (a real, tested icon, not invented from scratch), with the duration set as
 * `<text>` inside it. The arc+arrowhead alone is mirrored for the forward direction (via an inner
 * `<g>`, not the outer one) so the number itself never renders backwards.
 */
function buildSkipIconSvg(seconds: SkipSeconds, direction: 'back' | 'forward'): string {
	const arrow = `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
	const arrowGroup = direction === 'forward' ? `<g transform="scale(-1,1) translate(-24,0)">${arrow}</g>` : arrow;
	const label = String(seconds);
	const fontSize = label.length > 2 ? 7.5 : 8.5;
	return `
<g transform="scale(4.1667)">
${arrowGroup}
<text x="12" y="14.6" text-anchor="middle" font-size="${fontSize}" font-weight="700" font-family="inherit" fill="currentColor" stroke="none">${label}</text>
</g>
`;
}

/** Registers this plugin's custom Lucide-style icons. Call once from `onload()`. */
export function registerCustomIcons(): void {
	addIcon(PLAY_SAVED_ICON_ID, PLAY_SAVED_ICON_SVG);

	for (const seconds of SKIP_SECONDS_OPTIONS) {
		addIcon(skipIconId(seconds, 'back'), buildSkipIconSvg(seconds, 'back'));
		addIcon(skipIconId(seconds, 'forward'), buildSkipIconSvg(seconds, 'forward'));
	}
}
