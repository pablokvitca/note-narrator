import { describe, expect, it } from 'vitest';
import type { MarkdownView, TFile } from 'obsidian';
import { editorTextForNote, pauseButtonAction, savedAudioPanelUpdate, staleBadgeTooltip } from '../../src/ui/panel-decisions';

/** Test doubles only implement what the helpers touch; this is the one place they stand in for the real types. */
function fake<T>(value: object): T {
	return value as T;
}

function file(path: string): TFile {
	return fake<TFile>({ path });
}

function view(path: string | null, text: string): MarkdownView {
	return fake<MarkdownView>({ file: path === null ? null : file(path), editor: { getValue: () => text } });
}

describe('pauseButtonAction', () => {
	it('pauses while playing', () => {
		expect(pauseButtonAction('playing')).toBe('pause');
	});

	it('pauses while the next chunk is still generating', () => {
		expect(pauseButtonAction('generating')).toBe('pause');
	});

	it('resumes once paused', () => {
		expect(pauseButtonAction('paused')).toBe('resume');
	});

	it('does nothing when idle', () => {
		expect(pauseButtonAction('idle')).toBeNull();
	});
});

describe('editorTextForNote', () => {
	it('is the editor\'s current text when the view shows the panel\'s note', () => {
		expect(editorTextForNote(view('A.md', 'Edited, not saved yet'), file('A.md'))).toBe('Edited, not saved yet');
	});

	it('is undefined when the view shows another note', () => {
		expect(editorTextForNote(view('B.md', 'Other note'), file('A.md'))).toBeUndefined();
	});

	it('is undefined without a view, a view\'s file or a note', () => {
		expect(editorTextForNote(null, file('A.md'))).toBeUndefined();
		expect(editorTextForNote(view(null, 'Text'), file('A.md'))).toBeUndefined();
		expect(editorTextForNote(view('A.md', 'Text'), null)).toBeUndefined();
	});
});

describe('savedAudioPanelUpdate', () => {
	it('labels Read to regenerate outdated audio, and leaves the background button generating', () => {
		expect(savedAudioPanelUpdate('outdated', false)).toEqual({ readLabel: 'Regenerate', savedAudioCurrent: false });
	});

	it('labels Read to regenerate audio made with another narrator', () => {
		expect(savedAudioPanelUpdate('other-narrator', false)).toEqual({ readLabel: 'Regenerate with new narrator', savedAudioCurrent: false });
	});

	it('leaves Read as is for current audio, and makes the background button regenerate', () => {
		expect(savedAudioPanelUpdate('current', false)).toEqual({ readLabel: null, savedAudioCurrent: true });
	});

	it('leaves Read as is when the freshness is unknown', () => {
		expect(savedAudioPanelUpdate('unknown', false)).toEqual({ readLabel: null, savedAudioCurrent: false });
	});

	it('never relabels Read during a generated read of the note, whose audio replaces the saved file', () => {
		expect(savedAudioPanelUpdate('outdated', true).readLabel).toBeNull();
		expect(savedAudioPanelUpdate('other-narrator', true).readLabel).toBeNull();
		expect(savedAudioPanelUpdate('current', true).savedAudioCurrent).toBe(true);
	});
});

describe('staleBadgeTooltip', () => {
	it('says the note was edited, or the narrator changed', () => {
		expect(staleBadgeTooltip('note-edited')).toContain('The note changed after this audio was generated');
		expect(staleBadgeTooltip('narrator-changed')).toContain('Made with a different narrator');
	});
});
