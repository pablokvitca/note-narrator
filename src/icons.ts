import { addIcon } from 'obsidian';

/** A saved-audio file with a small play badge, for the "Play saved" action -- distinct from the plain `play` triangle used for playback controls. */
export const PLAY_SAVED_ICON_ID = 'obsidian-reader-play-saved';

const PLAY_SAVED_ICON_SVG = `
<path d="M4 3h8l5 5v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M12 3v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M6.5 10.3h1.3l2-1.5v6.4l-2-1.5H6.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="17.5" cy="17.5" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/>
<path d="M16.2 15.7v3.6l3.1-1.8z" fill="currentColor" stroke="none"/>
`;

/** Registers this plugin's custom Lucide-style icons. Call once from `onload()`. */
export function registerCustomIcons(): void {
	addIcon(PLAY_SAVED_ICON_ID, PLAY_SAVED_ICON_SVG);
}
