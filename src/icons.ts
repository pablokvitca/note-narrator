import { addIcon } from 'obsidian';

/** A saved-audio file with a small play badge, for the "Play saved" action -- distinct from the plain `play` triangle used for playback controls. */
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
<path d="M4 3h8l5 5v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M12 3v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M6.5 10.3h1.3l2-1.5v6.4l-2-1.5H6.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="17.5" cy="17.5" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/>
<path d="M16.2 15.7v3.6l3.1-1.8z" fill="currentColor" stroke="none"/>
</g>
`;

/** Registers this plugin's custom Lucide-style icons. Call once from `onload()`. */
export function registerCustomIcons(): void {
	addIcon(PLAY_SAVED_ICON_ID, PLAY_SAVED_ICON_SVG);
}
