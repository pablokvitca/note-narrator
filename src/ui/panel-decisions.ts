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
 * leave it, including during a generated read of the note, whose audio replaces the saved file once saved, so
 * the old file's freshness doesn't apply to it), and whether the saved audio counts as up to date, which turns
 * the background button into a regenerate. A label also enables the button, even while the saved file plays.
 */
export function savedAudioPanelUpdate(freshness: SavedAudioFreshness, readingGenerated: boolean): { readLabel: string | null; savedAudioCurrent: boolean } {
	return { readLabel: readingGenerated ? null : readButtonLabel(freshness), savedAudioCurrent: freshness === 'current' };
}
