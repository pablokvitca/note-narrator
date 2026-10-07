import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownView, TFile } from 'obsidian';
import { Notice, TFile as StubTFile, parseYaml, stringifyYaml } from '../stubs/obsidian';
import { Reader } from '../../src/engine/reader';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from '../../src/settings/settings';
import { migrateProfileSettings } from '../../src/settings/profiles';
import { extractFrontmatterYaml, stripFrontmatter } from '../../src/text/text-utils';
import { savedAudioFreshness } from '../../src/engine/saved-audio-freshness';
import { backgroundButtonSpec } from '../../src/ui/background-button';
import { editorTextForNote, savedAudioPanelUpdate } from '../../src/ui/panel-decisions';

/**
 * Reader with its real collaborators (NoteText, SavedAudio, profiles, text chunking) against an in-memory
 * vault that behaves like Obsidian's where it matters here: processFrontMatter rewrites the note's YAML as
 * block YAML (real YAML library), the editor shows the file's current text, and the metadata cache is a
 * snapshot that lags edits -- it's only refreshed (with a 'changed' event) after processFrontMatter, or when
 * a test calls refreshCache(), like Obsidian re-indexing a note a moment after it changes. Only the TTS
 * provider (every chunk becomes an 8-byte buffer) and audio decoding are faked, so no network or audio.
 * Complements reader.test.ts, which fakes those collaborators to control timing precisely.
 */

const CHUNK_BYTES = 8;

const fakes = vi.hoisted(() => ({
	synthCalls: [] as { text: string; resolve: () => void }[],
	/** When true, the voice name lookup a save starts with stays pending until the test calls releaseVoiceLabels(). */
	holdVoiceLabels: false,
	heldVoiceLabels: [] as (() => void)[],
}));

vi.mock('../../src/tts/registry', () => ({
	getProviderApiKey: () => 'key',
	missingApiKeyMessage: () => 'No API key.',
	resolveVoiceLabel: () =>
		fakes.holdVoiceLabels ? new Promise<string>((resolve) => fakes.heldVoiceLabels.push(() => resolve('Voice'))) : Promise.resolve('Voice'),
	createTTSProvider: () => ({
		synthesize: (text: string) =>
			new Promise<ArrayBuffer>((resolve) => fakes.synthCalls.push({ text, resolve: () => resolve(new ArrayBuffer(8)) })),
	}),
}));

vi.mock('../../src/engine/audio-utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/engine/audio-utils')>()),
	decodeAudioDuration: () => Promise.resolve(1.5),
}));

class FakeAudio {
	static instances: FakeAudio[] = [];
	paused = true;
	duration = 1.5;
	currentTime = 0;
	playbackRate = 1;
	volume = 1;
	muted = false;
	constructor(public src: string) {
		FakeAudio.instances.push(this);
	}
	play(): Promise<void> {
		this.paused = false;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
	}
	addEventListener(): void {}
	removeEventListener(): void {}
}

/** Test doubles only implement what Reader and its collaborators touch; this is where they stand in for the real types. */
function fake<T>(value: object): T {
	return value as T;
}

/** An in-memory vault: text notes, binary audio files, and the frontmatter view of each note. */
class FakeVault {
	readonly text = new Map<string, string>();
	readonly binary = new Map<string, ArrayBuffer>();
	/** The metadata cache's frontmatter per note: a snapshot, refreshed only by refreshCache(). */
	private readonly cache = new Map<string, Record<string, unknown> | undefined>();
	private readonly changedHandlers = new Set<(file: TFile) => void>();
	private readonly deleteHandlers = new Set<(file: TFile) => void>();
	private readonly renameHandlers = new Set<(file: TFile, oldPath: string) => void>();
	/** Like Obsidian, one TFile instance per path. */
	private readonly files = new Map<string, TFile>();
	/** When true, audio writes (createBinary, modifyBinary) stay pending until the test calls releaseWrites(). */
	holdWrites = false;
	private readonly heldWrites: (() => void)[] = [];

	/** Finishes the audio writes held by holdWrites, in order. Returns how many there were. */
	releaseWrites(): number {
		const held = this.heldWrites.splice(0);
		for (const write of held) write();
		return held.length;
	}

	/** Runs an audio write now, or holds it until releaseWrites() when holdWrites is set. */
	private writeBinary<T>(write: () => T): Promise<T> {
		if (!this.holdWrites) return Promise.resolve(write());
		return new Promise<T>((resolve) => this.heldWrites.push(() => resolve(write())));
	}

	/** Subscribes to the vault's 'delete' event (what main.ts wires to Reader.handleFileDeleted()). */
	onDelete(handler: (file: TFile) => void): void {
		this.deleteHandlers.add(handler);
	}

	/** Deletes a file the way Obsidian's trash does: it's gone, and the vault fires 'delete'. */
	trash(path: string): void {
		const file = this.file(path);
		this.text.delete(path);
		this.binary.delete(path);
		for (const handler of this.deleteHandlers) handler(file);
	}

	/** Subscribes to the vault's 'rename' event (what main.ts wires to Reader.handleFileRenamed()). */
	onRename(handler: (file: TFile, oldPath: string) => void): void {
		this.renameHandlers.add(handler);
	}

	/** Every file path under a folder, at any depth. */
	private pathsUnder(folder: string): string[] {
		return [...this.text.keys(), ...this.binary.keys()].filter((path) => path.startsWith(`${folder}/`));
	}

	/**
	 * Trashes a whole folder the way Obsidian does (recorded in Obsidian 1.13 for both its own trash and a
	 * folder deleted outside it): one 'delete' per contained file first, then one for the folder itself.
	 * Obsidian also fires one per subfolder, in depth-first order; those are left out here, since Reader only
	 * acts on the paths of notes and audio files.
	 */
	trashFolder(folder: string): void {
		for (const path of this.pathsUnder(folder)) this.trash(path);
		const folderEntry = fake<TFile>({ path: folder });
		for (const handler of this.deleteHandlers) handler(folderEntry);
	}

	/**
	 * Renames or moves a whole folder the way Obsidian does (recorded in Obsidian 1.13): one 'rename' for the
	 * folder itself first, then one per contained file, each TFile keeping its identity with its path updated.
	 * Unlike Obsidian with "Automatically update internal links" on, a note's link to moved audio isn't rewritten.
	 */
	renameFolder(folder: string, newFolder: string): void {
		const folderEntry = fake<TFile>({ path: newFolder });
		for (const handler of this.renameHandlers) handler(folderEntry, folder);
		for (const oldPath of this.pathsUnder(folder)) {
			const newPath = `${newFolder}${oldPath.slice(folder.length)}`;
			const file = this.file(oldPath);
			for (const map of [this.text, this.binary, this.cache] as Map<string, unknown>[]) {
				if (!map.has(oldPath)) continue;
				map.set(newPath, map.get(oldPath));
				map.delete(oldPath);
			}
			this.files.delete(oldPath);
			this.files.set(newPath, file);
			file.path = newPath;
			for (const handler of this.renameHandlers) handler(file, oldPath);
		}
	}

	/** Sets a note's text, as an edit in the editor would; the metadata cache lags until refreshCache(). */
	write(path: string, content: string): void {
		this.text.set(path, content);
	}

	/** Re-indexes a note, like Obsidian's metadata cache does shortly after it changes, and fires 'changed'. */
	refreshCache(path: string): void {
		this.cache.set(path, this.frontmatter(path));
		for (const handler of this.changedHandlers) handler(this.file(path));
	}

	file(path: string): TFile {
		let file = this.files.get(path);
		if (!file) {
			file = fake<TFile>(Object.assign(new StubTFile(), { path, basename: path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), extension: path.split('.').pop() }));
			// Like Obsidian's, the parent folder follows the file's path (so it moves with a renamed folder).
			Object.defineProperty(file, 'parent', { get: (): { path: string } => ({ path: file!.path.includes('/') ? file!.path.slice(0, file!.path.lastIndexOf('/')) : '/' }) });
			this.files.set(path, file);
		}
		return file;
	}

	/** The frontmatter as the file's text has it right now (what the cache will show once refreshed). */
	frontmatter(path: string): Record<string, unknown> | undefined {
		const yaml = extractFrontmatterYaml(this.text.get(path) ?? '');
		return yaml === null ? undefined : (parseYaml(yaml) as Record<string, unknown>);
	}

	app(): App {
		return fake<App>({
			vault: {
				configDir: 'vault-config',
				cachedRead: (f: TFile) => Promise.resolve(this.text.get(f.path) ?? ''),
				readBinary: (f: TFile) => Promise.resolve(this.binary.get(f.path) ?? new ArrayBuffer(0)),
				createBinary: (path: string, data: ArrayBuffer) =>
					this.writeBinary(() => {
						this.binary.set(path, data);
						return this.file(path);
					}),
				modifyBinary: (f: TFile, data: ArrayBuffer) =>
					this.writeBinary(() => {
						this.binary.set(f.path, data);
					}),
				createFolder: () => Promise.resolve(),
				getAbstractFileByPath: (path: string) => (this.text.has(path) || this.binary.has(path) ? this.file(path) : null),
			},
			metadataCache: {
				getFileCache: (f: TFile) => ({ frontmatter: this.cache.get(f.path) }),
				on: (_name: 'changed', handler: (file: TFile) => void) => {
					this.changedHandlers.add(handler);
					return handler;
				},
				offref: (ref: (file: TFile) => void) => this.changedHandlers.delete(ref),
			},
			fileManager: {
				generateMarkdownLink: (f: TFile) => `[[${f.path}]]`,
				trashFile: (f: TFile) => {
					this.trash(f.path);
					return Promise.resolve();
				},
				// Like Obsidian: hands over the frontmatter parsed from the file, writes it back as block YAML above
				// the body, and the metadata cache catches up a moment later.
				processFrontMatter: (f: TFile, update: (frontmatter: Record<string, unknown>) => void) => {
					const data = this.frontmatter(f.path) ?? {};
					update(data);
					const body = stripFrontmatter(this.text.get(f.path) ?? '');
					this.text.set(f.path, `---\n${stringifyYaml(data)}---\n${body}`);
					queueMicrotask(() => this.refreshCache(f.path));
					return Promise.resolve();
				},
			},
			workspace: { getActiveViewOfType: () => null },
		});
	}

	/**
	 * A Markdown view of the note that, like the real editor, shows the file's current text, or `unsavedText`
	 * for an edit the editor hasn't saved to disk yet.
	 */
	view(path: string, unsavedText?: string): MarkdownView {
		return fake<MarkdownView>({ file: this.file(path), editor: { getValue: () => unsavedText ?? this.text.get(path) ?? '', getSelection: () => '' } });
	}
}

/** Lets pending promise chains run; real collaborators make them longer than in reader.test.ts. */
async function settle(): Promise<void> {
	for (let i = 0; i < 200; i++) await Promise.resolve();
}

async function finishGenerating(): Promise<void> {
	for (let i = 0; i < 10 && fakes.synthCalls.length > 0; i++) {
		for (const call of fakes.synthCalls.splice(0)) call.resolve();
		await settle();
	}
}

/** Two sections, so the note is read as more than one chunk. */
const NOTE = '# First\n\nThe first section has a sentence.\n\n# Second\n\nThe second section has another one.';

let vault: FakeVault;
let reader: Reader;

beforeEach(() => {
	vi.stubGlobal('window', {
		setTimeout: (callback: () => void) => {
			queueMicrotask(callback);
			return 0;
		},
		clearTimeout: () => {},
	});
	vi.stubGlobal('Audio', FakeAudio);
	fakes.synthCalls.length = 0;
	fakes.holdVoiceLabels = false;
	fakes.heldVoiceLabels.length = 0;
	FakeAudio.instances = [];
	Notice.messages = [];
	vault = new FakeVault();
	vault.write('Note.md', NOTE);
	vault.refreshCache('Note.md');
	const settings = { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true } as NoteNarratorSettings;
	reader = new Reader(vault.app(), settings);
	// As main.ts wires it.
	vault.onDelete((file) => reader.handleFileDeleted(file.path));
	vault.onRename((file, oldPath) => reader.handleFileRenamed(file.path, oldPath));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('Reader end to end: a finished background job and its own save', () => {
	it('stays fresh after its save writes Note Narrator properties into the note, so Read plays it', async () => {
		const note = vault.file('Note.md');
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		const generated = reader.getState().backgroundJobs[0]?.chunkCount ?? 0;
		expect(generated).toBeGreaterThan(1);

		// The save rewrote the note's frontmatter (link, hash, durations...), changing its text.
		const saved = vault.text.get('Note.md') ?? '';
		expect(saved).not.toBe(NOTE);
		expect(saved.endsWith(NOTE)).toBe(true);
		expect(await reader.getAudioStatus(note)).toBe('up-to-date');
		expect(reader.getGenerateInBackgroundAction(note, saved)).toBe('ready-in-background');

		await reader.readNote(vault.view('Note.md'));
		await settle();

		const state = reader.getState();
		expect(state.backgroundJobs).toHaveLength(0);
		expect(state.activeFile?.path).toBe('Note.md');
		expect(state.status).toBe('playing');
		// Played from the job's audio: nothing generated again.
		expect(fakes.synthCalls).toHaveLength(0);
	});

	it('counts as stale, and Read generates again, once the note body is edited after the save', async () => {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();

		vault.write('Note.md', `${vault.text.get('Note.md') ?? ''}\n\nAn added line.`);
		expect(await reader.getAudioStatus(vault.file('Note.md'))).toBe('outdated');

		// Not awaited: a fresh read only resolves once it has played to the end.
		void reader.readNote(vault.view('Note.md'));
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(reader.getState().status).toBe('generating');
		expect(fakes.synthCalls.length).toBeGreaterThan(0);
	});
});

describe('Reader end to end: a note with its own properties', () => {
	const WITH_PROPERTIES = '---\nstatus: draft\ntags:\n  - reading\n---\n' + NOTE;

	it('keeps the user\'s properties through the save, and the job stays fresh', async () => {
		vault.write('Note.md', WITH_PROPERTIES);
		vault.refreshCache('Note.md');
		const note = vault.file('Note.md');
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();

		expect(vault.frontmatter('Note.md')).toMatchObject({ status: 'draft', tags: ['reading'] });
		expect(await reader.getAudioStatus(note)).toBe('up-to-date');
		expect(reader.getGenerateInBackgroundAction(note, vault.text.get('Note.md'))).toBe('ready-in-background');
	});

	it('treats a property edit as a change right away, before the metadata cache catches up', async () => {
		vault.write('Note.md', WITH_PROPERTIES);
		vault.refreshCache('Note.md');
		const note = vault.file('Note.md');
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();

		// Edited in the editor; the cache still has "draft".
		vault.write('Note.md', (vault.text.get('Note.md') ?? '').replace('status: draft', 'status: final'));
		expect(reader.getGenerateInBackgroundAction(note, vault.text.get('Note.md'))).toBe('generate');
		expect(await reader.getAudioStatus(note)).toBe('outdated');

		vault.refreshCache('Note.md');
		expect(await reader.getAudioStatus(note)).toBe('outdated');
	});
});

describe('Reader end to end: Play saved', () => {
	async function saveAudioByReading(): Promise<{ note: TFile; audio: TFile; chunkCount: number }> {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		const chunkCount = reader.getState().backgroundJobs[0]?.chunkCount ?? 0;
		const info = await reader.getAudioInfo(vault.file('Note.md'));
		if (!info) throw new Error('expected saved audio');
		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]?.id ?? -1);
		return { note: vault.file('Note.md'), audio: info.audioFile, chunkCount };
	}

	it('plays the saved file chunk by chunk, sliced back using the saved chunk durations', async () => {
		const { note, audio, chunkCount } = await saveAudioByReading();
		expect(vault.binary.get(audio.path)?.byteLength).toBe(chunkCount * CHUNK_BYTES);

		void reader.playSavedFile(audio, note);
		await settle();

		const state = reader.getState();
		expect(state.status).toBe('playing');
		expect(state.activeReadKind).toBe('saved');
		expect(state.chunkCount).toBe(chunkCount);
		expect(state.chunkDurations).toEqual(new Array(chunkCount).fill(1.5));
		// One audio element per chunk, starting with the first.
		expect(FakeAudio.instances).toHaveLength(1);
		expect(fakes.synthCalls).toHaveLength(0);
	});

	it('plays an outdated saved file as one piece, since its chunks no longer line up with the note', async () => {
		const { note, audio } = await saveAudioByReading();
		vault.write('Note.md', `${vault.text.get('Note.md') ?? ''}\n\n# Third\n\nA new section.`);

		void reader.playSavedFile(audio, note);
		await settle();

		const state = reader.getState();
		expect(state.status).toBe('playing');
		expect(state.chunkCount).toBe(1);
	});
});

describe('Reader end to end: deleting and clearing saved audio', () => {
	async function generateAndSave(): Promise<string> {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		const info = await reader.getAudioInfo(vault.file('Note.md'));
		if (!info) throw new Error('expected saved audio');
		return info.audioFile.path;
	}

	it('drops the finished card when its saved audio is deleted, so the note can be generated again', async () => {
		const audioPath = await generateAndSave();
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done']);

		vault.trash(audioPath);

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(reader.getGenerateInBackgroundAction(vault.file('Note.md'), vault.text.get('Note.md'))).toBe('generate');
	});

	it('Clear removes the audio, its properties and the finished card', async () => {
		const audioPath = await generateAndSave();

		await reader.clearReaderFiles(vault.file('Note.md'));
		await settle();

		expect(vault.binary.has(audioPath)).toBe(false);
		// No Note Narrator properties left, and the note itself untouched.
		expect(Object.keys(vault.frontmatter('Note.md') ?? {})).toEqual([]);
		expect(vault.text.get('Note.md')?.endsWith(NOTE)).toBe(true);
		expect(await reader.getAudioStatus(vault.file('Note.md'))).toBe('none');
		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});

	it('Clear keeps a generation in progress, which then saves and links its new audio', async () => {
		const oldAudio = await generateAndSave();
		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]?.id ?? -1);
		vault.write('Note.md', `${vault.text.get('Note.md') ?? ''}\n\nAn added line.`);
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['generating']);

		await reader.clearReaderFiles(vault.file('Note.md'));
		await settle();

		expect(vault.binary.has(oldAudio)).toBe(false);
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['generating']);

		await finishGenerating();

		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done']);
		expect(await reader.getAudioStatus(vault.file('Note.md'))).toBe('up-to-date');
	});
});

describe('Reader end to end: the panel\'s background button', () => {
	/** The button the panel shows for the note: first from the job list, then again once the saved audio's freshness loads. */
	async function panelBackgroundButton(view: MarkdownView): Promise<{ first: string; settled: string }> {
		const note = vault.file('Note.md');
		const currentContent = editorTextForNote(view, note);
		const first = reader.getGenerateInBackgroundAction(note, currentContent);
		// The same steps as the panel, which leaves the button as it was when the note has no saved audio.
		const info = await reader.getAudioInfo(note);
		const freshness = info ? savedAudioFreshness(info.status, info.savedVoice, reader.getActiveNarrator()?.voice ?? null) : null;
		const savedAudioCurrent = freshness !== null && savedAudioPanelUpdate(freshness, false).savedAudioCurrent;
		const settled = reader.getGenerateInBackgroundAction(note, currentContent, savedAudioCurrent);
		return { first: backgroundButtonSpec(first).tooltip, settled: backgroundButtonSpec(settled).tooltip };
	}

	it('switches to Regenerate in background once the saved audio turns out to be current', async () => {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]!.id);

		const { first, settled } = await panelBackgroundButton(vault.view('Note.md'));

		expect(first).toBe(backgroundButtonSpec('generate').tooltip);
		expect(settled).toBe(backgroundButtonSpec('regenerate').tooltip);
		expect(settled.startsWith('Regenerate in background')).toBe(true);
	});

	it('treats a finished card as stale from the editor\'s unsaved edit, so it offers to regenerate', async () => {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		const saved = vault.text.get('Note.md') ?? '';

		expect((await panelBackgroundButton(vault.view('Note.md'))).settled).toBe(backgroundButtonSpec('ready-in-background').tooltip);
		const { first, settled } = await panelBackgroundButton(vault.view('Note.md', `${saved}\n\nAn unsaved line.`));

		expect(first).toBe(backgroundButtonSpec('generate').tooltip);
		// The file on disk hasn't changed, so its saved audio still counts as current.
		expect(settled).toBe(backgroundButtonSpec('regenerate').tooltip);
	});
});

describe('Reader end to end: folders deleted or moved', () => {
	// Audio goes to its own folder, apart from the note's, so each test moves or deletes just one of them.
	beforeEach(() => {
		vault.write('Notes/Note.md', NOTE);
		vault.refreshCache('Notes/Note.md');
		const settings = { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true, saveAudioLocation: 'custom-folder', saveAudioFolderPath: 'Audio' } as NoteNarratorSettings;
		// The vault events wired above call whichever reader is current.
		reader = new Reader(vault.app(), settings);
	});

	async function finishedJobWithAudio(): Promise<string> {
		reader.generateNoteInBackground(vault.view('Notes/Note.md'));
		await settle();
		await finishGenerating();
		const info = await reader.getAudioInfo(vault.file('Notes/Note.md'));
		if (!info) throw new Error('expected saved audio');
		expect(info.audioFile.path.startsWith('Audio/')).toBe(true);
		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done']);
		return info.audioFile.path;
	}

	it('drops the finished card when the folder holding its saved audio is deleted', async () => {
		await finishedJobWithAudio();

		vault.trashFolder('Audio');

		expect(vault.binary.size).toBe(0);
		expect(vault.text.has('Notes/Note.md')).toBe(true);
		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});

	it('drops a job in progress, without saving, when the folder holding its note is deleted', async () => {
		reader.generateNoteInBackground(vault.view('Notes/Note.md'));
		await settle();
		expect(reader.getState().backgroundJobs).toHaveLength(1);

		vault.trashFolder('Notes');
		await finishGenerating();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(vault.binary.size).toBe(0);
		expect(Notice.messages.filter((message) => message.startsWith('Failed'))).toEqual([]);
	});

	it('follows saved audio moved with its folder, so deleting it from there still drops the card', async () => {
		const audioPath = await finishedJobWithAudio();

		vault.renameFolder('Audio', 'Archive/Audio');
		expect(vault.binary.has(`Archive/${audioPath}`)).toBe(true);
		expect(reader.getState().backgroundJobs).toHaveLength(1);

		vault.trashFolder('Archive/Audio');
		expect(vault.text.has('Notes/Note.md')).toBe(true);
		expect(reader.getState().backgroundJobs).toHaveLength(0);
	});

	it('saves audio next to the note at its new place when its folder is moved during generation', async () => {
		// The default location: the note's own folder, read from the note when the save happens.
		reader = new Reader(vault.app(), { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true });
		reader.generateNoteInBackground(vault.view('Notes/Note.md'));
		await settle();

		vault.renameFolder('Notes', 'Archive/Notes');
		await finishGenerating();

		const info = await reader.getAudioInfo(vault.file('Archive/Notes/Note.md'));
		expect(info?.audioFile.path.startsWith('Archive/Notes/')).toBe(true);
		expect(info?.status).toBe('up-to-date');
	});

	it('keeps a job in progress when its note\'s folder is moved, and saves and links its audio', async () => {
		reader.generateNoteInBackground(vault.view('Notes/Note.md'));
		await settle();

		vault.renameFolder('Notes', 'Archive/Notes');
		await finishGenerating();

		expect(reader.getState().backgroundJobs.map((job) => job.status)).toEqual(['done']);
		const info = await reader.getAudioInfo(vault.file('Archive/Notes/Note.md'));
		expect(info?.status).toBe('up-to-date');
		expect(Notice.messages.filter((message) => message.startsWith('Failed'))).toEqual([]);
	});
});

describe('Reader end to end: a note deleted while its audio is being saved', () => {
	async function deleteDuringSave(start: () => void): Promise<void> {
		fakes.holdVoiceLabels = true;
		start();
		await settle();
		await finishGenerating();
		// Every chunk is generated; the save is waiting on the voice name lookup.
		expect(fakes.heldVoiceLabels).toHaveLength(1);

		vault.trash('Note.md');
		for (const release of fakes.heldVoiceLabels.splice(0)) release();
		await settle();
	}

	it('writes no audio file for Auto-generate on open', async () => {
		reader = new Reader(vault.app(), { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true, autoGenerateOnOpen: true });
		vault.onDelete((file) => reader.handleFileDeleted(file.path));

		await deleteDuringSave(() => void reader.autoGenerateIfNeeded(vault.file('Note.md')));

		expect(vault.binary.size).toBe(0);
		expect(Notice.messages.filter((message) => message.startsWith('Failed'))).toEqual([]);
	});

	it('writes no audio file for a read', async () => {
		await deleteDuringSave(() => void reader.readNote(vault.view('Note.md')));

		expect(vault.binary.size).toBe(0);
		expect(Notice.messages.filter((message) => message.startsWith('Failed'))).toEqual([]);
	});

	it('writes no audio file for a background job', async () => {
		await deleteDuringSave(() => reader.generateNoteInBackground(vault.view('Note.md')));

		expect(vault.binary.size).toBe(0);
		expect(Notice.messages.filter((message) => message.startsWith('Failed'))).toEqual([]);
	});
});

describe('Reader end to end: a note deleted while its existing audio is being replaced', () => {
	it('leaves the old audio as it was', async () => {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		const [audioPath, oldAudio] = [...vault.binary.entries()][0]!;
		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]!.id);

		vault.write('Note.md', `${vault.text.get('Note.md') ?? ''}\n\nAn added line.`);
		fakes.holdVoiceLabels = true;
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		expect(fakes.heldVoiceLabels).toHaveLength(1);

		vault.trash('Note.md');
		for (const release of fakes.heldVoiceLabels.splice(0)) release();
		await settle();

		expect([...vault.binary.keys()]).toEqual([audioPath]);
		expect(vault.binary.get(audioPath)).toBe(oldAudio);
		expect(Notice.messages.filter((message) => message.startsWith('Failed'))).toEqual([]);
	});
});

describe('Reader end to end: a note deleted while its audio file is being written', () => {
	async function deleteDuringWrite(start: () => void): Promise<void> {
		vault.holdWrites = true;
		start();
		await settle();
		await finishGenerating();
		vault.trash('Note.md');
		expect(vault.releaseWrites()).toBe(1);
		await settle();
	}

	it('trashes the file Auto-generate on open just wrote', async () => {
		reader = new Reader(vault.app(), { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true, autoGenerateOnOpen: true });
		vault.onDelete((file) => reader.handleFileDeleted(file.path));

		await deleteDuringWrite(() => void reader.autoGenerateIfNeeded(vault.file('Note.md')));

		expect(vault.binary.size).toBe(0);
		expect(Notice.messages.filter((message) => message.startsWith('Failed') || message.startsWith('Saved'))).toEqual([]);
	});

	it('trashes the file a read just wrote', async () => {
		await deleteDuringWrite(() => void reader.readNote(vault.view('Note.md')));

		expect(vault.binary.size).toBe(0);
		expect(Notice.messages.filter((message) => message.startsWith('Failed') || message.startsWith('Saved'))).toEqual([]);
	});

	it('trashes the file a background job just wrote, and leaves no card', async () => {
		await deleteDuringWrite(() => reader.generateNoteInBackground(vault.view('Note.md')));

		expect(vault.binary.size).toBe(0);
		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(Notice.messages.filter((message) => message.startsWith('Failed') || message.startsWith('Saved'))).toEqual([]);
	});

	it('keeps the replaced audio file, without linking the deleted note or reporting a failure', async () => {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		const [audioPath] = [...vault.binary.keys()];
		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]!.id);
		vault.write('Note.md', `${vault.text.get('Note.md') ?? ''}\n\nAn added line.`);
		Notice.messages = [];

		await deleteDuringWrite(() => reader.generateNoteInBackground(vault.view('Note.md')));

		expect([...vault.binary.keys()]).toEqual([audioPath]);
		expect(Notice.messages.filter((message) => message.startsWith('Failed') || message.startsWith('Updated'))).toEqual([]);
	});
});

describe('Reader end to end: the plugin unloading while an audio file is being written', () => {
	const linkedAudio = (): unknown => vault.frontmatter('Note.md')?.[DEFAULT_SETTINGS.audioPathProperty];

	it('keeps and links a new file once the write finishes, since the note still exists', async () => {
		vault.holdWrites = true;
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();

		reader.dispose();
		expect(vault.releaseWrites()).toBe(1);
		await settle();

		expect(vault.binary.size).toBe(1);
		expect(linkedAudio()).toBeTruthy();
		expect(await reader.getAudioStatus(vault.file('Note.md'))).toBe('up-to-date');
	});

	it('keeps and links the file Auto-generate on open was writing when Read takes over the note', async () => {
		reader = new Reader(vault.app(), { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true, autoGenerateOnOpen: true });
		vault.holdWrites = true;
		void reader.autoGenerateIfNeeded(vault.file('Note.md'));
		await settle();
		await finishGenerating();

		void reader.readNote(vault.view('Note.md'));
		await settle();
		vault.holdWrites = false;
		expect(vault.releaseWrites()).toBe(1);
		await settle();

		expect(vault.binary.size).toBe(1);
		expect(linkedAudio()).toBeTruthy();
	});

	it('links a replaced file once the write finishes, so its new audio counts as current', async () => {
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		reader.discardBackgroundJob(reader.getState().backgroundJobs[0]!.id);
		vault.write('Note.md', `${vault.text.get('Note.md') ?? ''}\n\nAn added line.`);
		expect(await reader.getAudioStatus(vault.file('Note.md'))).toBe('outdated');

		vault.holdWrites = true;
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		reader.dispose();
		expect(vault.releaseWrites()).toBe(1);
		await settle();

		expect(vault.binary.size).toBe(1);
		expect(await reader.getAudioStatus(vault.file('Note.md'))).toBe('up-to-date');
	});
});

describe('Reader end to end: saved audio freshness after the narrator changes', () => {
	it('is current once saved, and other-narrator after switching to a profile with another voice', async () => {
		const settings = { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true } as NoteNarratorSettings;
		reader = new Reader(vault.app(), settings);
		const note = vault.file('Note.md');
		expect(await reader.getSavedAudioFreshness(note)).toBeNull();

		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		expect(await reader.getSavedAudioFreshness(note)).toBe('current');

		const profile = settings.profiles[0]!;
		profile.voice = { ...profile.voice, voiceId: `${profile.voice.voiceId}-other` };
		expect(await reader.getSavedAudioFreshness(note)).toBe('other-narrator');
	});
});

describe('Reader end to end: saved audio deleted outside Note Narrator', () => {
	it('cleans up the note\'s audio properties when its freshness is checked', async () => {
		const settings = { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true } as NoteNarratorSettings;
		reader = new Reader(vault.app(), settings);
		reader.generateNoteInBackground(vault.view('Note.md'));
		await settle();
		await finishGenerating();
		const [audioPath] = [...vault.binary.keys()];
		expect(vault.frontmatter('Note.md')?.[settings.audioLinkProperty]).toBeDefined();

		// Gone without a delete event reaching Note Narrator (e.g. removed outside Obsidian).
		vault.binary.delete(audioPath!);
		expect(await reader.getSavedAudioFreshness(vault.file('Note.md'))).toBeNull();
		await settle();

		expect(vault.frontmatter('Note.md')?.[settings.audioLinkProperty]).toBeUndefined();
	});
});
