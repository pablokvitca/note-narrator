import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, MarkdownView, TFile } from 'obsidian';
import { Notice, TFile as StubTFile, parseYaml } from '../stubs/obsidian';
import { Reader } from '../../src/engine/reader';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from '../../src/settings/settings';
import { migrateProfileSettings } from '../../src/settings/profiles';
import { extractFrontmatterYaml } from '../../src/text/text-utils';

/**
 * Reader with its real collaborators (NoteText, SavedAudio, profiles, text chunking) against an in-memory
 * vault that behaves like Obsidian's where it matters here: processFrontMatter rewrites the note's YAML,
 * the editor shows the file's current text, and the metadata cache is the parsed frontmatter. Only the TTS
 * provider (every chunk becomes an 8-byte buffer) and audio decoding are faked, so no network or audio.
 * Complements reader.test.ts, which fakes those collaborators to control timing precisely.
 */

const CHUNK_BYTES = 8;

const fakes = vi.hoisted(() => ({ synthCalls: [] as { text: string; resolve: () => void }[] }));

vi.mock('../../src/tts/registry', () => ({
	getProviderApiKey: () => 'key',
	missingApiKeyMessage: () => 'No API key.',
	resolveVoiceLabel: () => Promise.resolve('Voice'),
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

	file(path: string): TFile {
		return fake<TFile>(Object.assign(new StubTFile(), { path, basename: path.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), extension: path.split('.').pop() }));
	}

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
				createBinary: (path: string, data: ArrayBuffer) => {
					this.binary.set(path, data);
					return Promise.resolve(this.file(path));
				},
				modifyBinary: (f: TFile, data: ArrayBuffer) => {
					this.binary.set(f.path, data);
					return Promise.resolve();
				},
				createFolder: () => Promise.resolve(),
				getAbstractFileByPath: (path: string) => (this.text.has(path) || this.binary.has(path) ? this.file(path) : null),
			},
			metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: this.frontmatter(f.path) }), on: () => ({}), offref: () => {} },
			fileManager: {
				generateMarkdownLink: (f: TFile) => `[[${f.path}]]`,
				// Like Obsidian: hands over the parsed frontmatter, then writes it back as YAML above the body.
				processFrontMatter: (f: TFile, update: (frontmatter: Record<string, unknown>) => void) => {
					const data = this.frontmatter(f.path) ?? {};
					update(data);
					const body = (this.text.get(f.path) ?? '').replace(/^---\n[\s\S]*?\n---(\n|$)/, '');
					const yaml = Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
					this.text.set(f.path, `---\n${yaml}\n---\n${body}`);
					return Promise.resolve();
				},
			},
			workspace: { getActiveViewOfType: () => null },
		});
	}

	/** A Markdown view of the note that, like the real editor, always shows the file's current text. */
	view(path: string): MarkdownView {
		return fake<MarkdownView>({ file: this.file(path), editor: { getValue: () => this.text.get(path) ?? '', getSelection: () => '' } });
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
	FakeAudio.instances = [];
	Notice.messages = [];
	vault = new FakeVault();
	vault.text.set('Note.md', NOTE);
	const settings = { ...DEFAULT_SETTINGS, ...migrateProfileSettings({}), saveAudioFile: true, linkAudioInNote: true } as NoteNarratorSettings;
	reader = new Reader(vault.app(), settings);
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

		vault.text.set('Note.md', `${vault.text.get('Note.md') ?? ''}\n\nAn added line.`);
		expect(await reader.getAudioStatus(vault.file('Note.md'))).toBe('outdated');

		// Not awaited: a fresh read only resolves once it has played to the end.
		void reader.readNote(vault.view('Note.md'));
		await settle();

		expect(reader.getState().backgroundJobs).toHaveLength(0);
		expect(reader.getState().status).toBe('generating');
		expect(fakes.synthCalls.length).toBeGreaterThan(0);
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
		vault.text.set('Note.md', `${vault.text.get('Note.md') ?? ''}\n\n# Third\n\nA new section.`);

		void reader.playSavedFile(audio, note);
		await settle();

		const state = reader.getState();
		expect(state.status).toBe('playing');
		expect(state.chunkCount).toBe(1);
	});
});
