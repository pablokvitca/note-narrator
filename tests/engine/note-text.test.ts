import { describe, expect, it } from 'vitest';
import type { App, TFile } from 'obsidian';
import { TFile as StubTFile } from '../stubs/obsidian';
import { NoteText } from '../../src/engine/note-text';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from '../../src/settings/settings';
import { migrateProfileSettings } from '../../src/settings/profiles';

function fake<T>(value: object): T {
	return value as T;
}

function noteText(overrides: Partial<NoteNarratorSettings> = {}): NoteText {
	const settings: NoteNarratorSettings = { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), startPlaybackImmediately: true, quickStart: true, ...overrides };
	return new NoteText(fake<App>({}), settings);
}

function chunksFor(text: NoteText, title: string, content: string): string[] {
	const { rawText, positionBase } = text.buildNoteInput(fake<TFile>(Object.assign(new StubTFile(), { basename: title })), content);
	return text.buildChunksAndPositions(rawText, positionBase).chunks;
}

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(' ');

describe('NoteText quick start', () => {
	it('never makes the title the whole lead-in, even when the first sentence is too long to fit beside it', () => {
		const text = noteText({ quickStartUnit: 'words', quickStartWordCount: 10 });
		const chunks = chunksFor(text, 'Why does this happen?', `${words(25)}.`);

		expect(chunks[0]).toMatch(/^Why does this happen\?\s+word0/);
		expect(chunks.join(' ')).toContain('word24');
	});

	it('does the same with a character-sized lead-in', () => {
		const text = noteText({ quickStartUnit: 'characters', quickStartCharCount: 40 });
		const chunks = chunksFor(text, 'Why?', `${words(20)}.`);

		expect(chunks[0]).toMatch(/^Why\?\s+word0/);
	});

	it('reads the title with the note when a comment comes before the first heading', () => {
		const text = noteText({ quickStartUnit: 'words', quickStartWordCount: 150 });
		const chunks = chunksFor(text, 'My note', '%% todo %%\n\n# Heading\nThe first sentence. The second sentence.');

		expect(chunks[0]).toMatch(/^My note\s+Heading\s+The first sentence/);
	});

	it('leaves the lead-in alone when it already has more than the title', () => {
		const text = noteText({ quickStartUnit: 'words', quickStartWordCount: 6 });
		const chunks = chunksFor(text, 'My note', 'One two three. Four five six. Seven eight nine.');

		expect(chunks[0]).toBe('My note\n\nOne two three.');
	});
});
