import type { MarkdownView, TFile } from 'obsidian';
import type { ReaderStatus } from '../engine/reader-types';
import type { SavedAudioFreshness } from '../engine/saved-audio-freshness';
import { readButtonLabel } from './read-button';

/**
 * What the panel's Pause/Resume button does for a reader status. Pausing also works while the next chunk is
 * still generating: it then starts paused when it arrives. Pure, so it's unit-testable without the panel.
 */
export function pauseButtonAction(status: ReaderStatus): 'pause' | 'resume' | null {
	if (status === 'playing' || status === 'generating') return 'pause';
	if (status === 'paused') return 'resume';
	return null;
}

/**
 * The editor's current text for the panel's note, when the view shows that note. It lets a background job made
 * from an older version of the note count as stale, even before the edit is saved to disk.
 */
export function editorTextForNote(view: MarkdownView | null, file: TFile | null): string | undefined {
	return view && file && view.file?.path === file.path ? view.editor.getValue() : undefined;
}

/**
 * What the panel changes once a note's saved-audio freshness is known: the Read button's new label (null to
 * leave it, including while it's disabled during a read, so it doesn't flash "Regenerate"), and whether the
 * saved audio counts as up to date, which turns the background button into a regenerate.
 */
export function savedAudioPanelUpdate(freshness: SavedAudioFreshness, readActive: boolean): { readLabel: string | null; savedAudioCurrent: boolean } {
	return { readLabel: readActive ? null : readButtonLabel(freshness), savedAudioCurrent: freshness === 'current' };
}
