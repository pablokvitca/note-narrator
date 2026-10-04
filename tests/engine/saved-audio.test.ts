import { describe, expect, it } from 'vitest';
import type { App, TFile } from 'obsidian';
// SavedAudio checks `instanceof TFile`, which (through the vitest alias) is this stub class.
import { TFile as StubTFile } from '../stubs/obsidian';
import { SavedAudio } from '../../src/engine/saved-audio';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from '../../src/settings/settings';
import { hashText } from '../../src/text/text-utils';

/** Test doubles only implement what SavedAudio touches; this is the one place they stand in for the real types. */
function fake<T>(value: object): T {
	return value as T;
}

function makeFile(path: string): TFile {
	return fake<TFile>(Object.assign(new StubTFile(), { path, basename: path.replace(/\.md$/, '') }));
}

interface Vault {
	/** The note's content on disk. */
	content: string;
	/** What the metadata cache reports as its frontmatter (which can lag the content). */
	cachedFrontmatter?: Record<string, unknown>;
	/** Whether the linked audio file exists. */
	audioExists?: boolean;
}

function makeSavedAudio(vault: Vault, settings: Partial<NoteNarratorSettings> = {}): { saved: SavedAudio; note: TFile; settings: NoteNarratorSettings } {
	const note = makeFile('Note.md');
	const fullSettings = { ...DEFAULT_SETTINGS, autoCleanupMissingAudioProperties: false, ...settings };
	const app = fake<App>({
		vault: {
			cachedRead: () => Promise.resolve(vault.content),
			getAbstractFileByPath: (path: string) => (vault.audioExists === false ? null : makeFile(path)),
		},
		metadataCache: { getFileCache: () => ({ frontmatter: vault.cachedFrontmatter }) },
	});
	return { saved: new SavedAudio(app, fullSettings, () => {}), note, settings: fullSettings };
}

describe('SavedAudio.stalenessHash', () => {
	it('ignores Note Narrator\'s own audio properties and the extra excluded ones', () => {
		const { saved, note, settings } = makeSavedAudio({ content: '' }, { extraStaleHashExcludedProperties: 'reviewed\n' });
		const plain = saved.stalenessHash('---\ntitle: Hello\n---\nBody', note);
		const withBookkeeping = saved.stalenessHash(
			`---\ntitle: Hello\n${settings.audioLinkProperty}: "[[a.mp3]]"\n${settings.audioHashProperty}: abc\nreviewed: true\n---\nBody`,
			note,
		);
		expect(withBookkeeping).toBe(plain);
	});

	it('changes when the body or a real property changes', () => {
		const { saved, note } = makeSavedAudio({ content: '' });
		const base = saved.stalenessHash('---\ntitle: Hello\n---\nBody', note);
		expect(saved.stalenessHash('---\ntitle: Hello\n---\nBody edited', note)).not.toBe(base);
		expect(saved.stalenessHash('---\ntitle: Bye\n---\nBody', note)).not.toBe(base);
	});

	it('hashes CRLF and LF versions of the same note the same', () => {
		const { saved, note } = makeSavedAudio({ content: '' });
		expect(saved.stalenessHash('---\r\ntitle: Hello\r\n---\r\nLine one\r\nLine two', note)).toBe(
			saved.stalenessHash('---\ntitle: Hello\n---\nLine one\nLine two', note),
		);
	});

	it('takes the frontmatter from the text it is given, not the (possibly lagging) metadata cache', () => {
		const stale = makeSavedAudio({ content: '', cachedFrontmatter: { title: 'Old' } });
		const fresh = makeSavedAudio({ content: '', cachedFrontmatter: { title: 'New' } });
		const text = '---\ntitle: New\n---\nBody';
		expect(stale.saved.stalenessHash(text, stale.note)).toBe(fresh.saved.stalenessHash(text, fresh.note));
	});

	it('falls back to the metadata cache\'s frontmatter when the YAML does not parse', () => {
		const { saved, note } = makeSavedAudio({ content: '', cachedFrontmatter: { title: 'Hello' } });
		expect(saved.stalenessHash('---\ntitle: [unclosed\n---\nBody', note)).toBe(saved.stalenessHash('---\ntitle: Hello\n---\nBody', note));
	});
});

describe('SavedAudio.getAudioStatus', () => {
	const linked = (settings: NoteNarratorSettings, hash: string) => ({ [settings.audioLinkProperty]: '[[Note.mp3]]', [settings.audioHashProperty]: hash, [settings.audioPathProperty]: 'Note.mp3' });

	it('is none when the note links no audio', async () => {
		const { saved, note } = makeSavedAudio({ content: 'Body', cachedFrontmatter: {} });
		expect(await saved.getAudioStatus(note)).toBe('none');
	});

	it('is up to date when the stored hash matches the note on disk', async () => {
		const vault: Vault = { content: 'Body' };
		const { saved, note, settings } = makeSavedAudio(vault);
		vault.cachedFrontmatter = linked(settings, saved.stalenessHash('Body', note));
		expect(await saved.getAudioStatus(note)).toBe('up-to-date');
	});

	it('reports a stored hash that isn\'t text (e.g. edited into a number) as outdated instead of failing', async () => {
		const vault: Vault = { content: 'Body' };
		const { saved, note, settings } = makeSavedAudio(vault);
		vault.cachedFrontmatter = { ...linked(settings, 'unused'), [settings.audioHashProperty]: 12345678 };

		expect(await saved.getAudioStatus(note)).toBe('outdated');
	});

	it('is outdated once the note changes', async () => {
		const vault: Vault = { content: 'Body' };
		const { saved, note, settings } = makeSavedAudio(vault);
		vault.cachedFrontmatter = linked(settings, saved.stalenessHash('Body', note));
		vault.content = 'Body edited';
		expect(await saved.getAudioStatus(note)).toBe('outdated');
	});

	it('reports a property edit as outdated right away, even before the metadata cache catches up', async () => {
		const before = '---\nstatus: draft\n---\nBody';
		const vault: Vault = { content: before };
		const { saved, note, settings } = makeSavedAudio(vault);
		// Saved by 1.1 (a versioned hash); the cache still shows the pre-edit property.
		vault.cachedFrontmatter = { status: 'draft', ...linked(settings, saved.stalenessHash(before, note)) };

		vault.content = '---\nstatus: final\n---\nBody';

		expect(await saved.getAudioStatus(note)).toBe('outdated');
	});

	it('keeps the saved audio of a typical note with frontmatter up to date, from the hash 1.0.0 stored', async () => {
		const content = '---\ntitle: Hello\ntags:\n  - reading\n---\nBody line one.\nBody line two.';
		const cachedFrontmatter = { title: 'Hello', tags: ['reading'] };
		const vault: Vault = { content, cachedFrontmatter };
		const { saved, note, settings } = makeSavedAudio(vault);
		// 1.0.0: the metadata cache's frontmatter (minus Note Narrator's own properties) plus the body.
		const hashFrom100 = hashText(`${JSON.stringify(cachedFrontmatter)}\nBody line one.\nBody line two.`);

		vault.cachedFrontmatter = { ...cachedFrontmatter, ...linked(settings, hashFrom100) };
		expect(await saved.getAudioStatus(note)).toBe('up-to-date');
	});

	it('still accepts a hash stored by an older version (cache frontmatter, no line-ending normalization)', async () => {
		const content = 'Line one\r\nLine two';
		const vault: Vault = { content };
		const { saved, note, settings } = makeSavedAudio(vault);
		const legacyHash = hashText(`${JSON.stringify({})}\n${content}`);
		expect(legacyHash).not.toBe(saved.stalenessHash(content, note));
		vault.cachedFrontmatter = linked(settings, legacyHash);
		expect(await saved.getAudioStatus(note)).toBe('up-to-date');
	});
});
