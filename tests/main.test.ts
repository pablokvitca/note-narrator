import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { debouncers, MarkdownView, StubCommand, TFile } from './stubs/obsidian';
import NoteNarratorPlugin from '../src/main';

/**
 * The plugin's wiring in main.ts: which vault and workspace events reach the Reader, what its commands do, and
 * that unloading stops the Reader. The Reader and the UI modules are replaced with stand-ins; their own
 * behaviour is tested elsewhere.
 */

const fakes = vi.hoisted(() => ({ reader: null as null | Record<string, ReturnType<typeof vi.fn>> }));

vi.mock('../src/engine/reader', () => ({
	Reader: class {
		handleFileDeleted = vi.fn();
		handleFileRenamed = vi.fn();
		readNote = vi.fn(() => Promise.resolve());
		generateNoteInBackground = vi.fn();
		stop = vi.fn();
		dispose = vi.fn();
		autoGenerateIfNeeded = vi.fn(() => Promise.resolve());
		getSavedAudioFreshness = vi.fn(() => Promise.resolve('unknown'));
		on = vi.fn(() => ({}));
		constructor() {
			fakes.reader = this as unknown as Record<string, ReturnType<typeof vi.fn>>;
		}
	},
}));
vi.mock('../src/ui/player-view', () => ({ NOTE_NARRATOR_VIEW_TYPE: 'note-narrator-player', PlayerView: class {} }));
vi.mock('../src/ui/highlight-extension', () => ({ createHighlightExtension: () => [] }));
vi.mock('../src/ui/icons', () => ({ registerCustomIcons: () => {}, SAVED_TOOLBAR_ICON_ID: 'saved' }));
vi.mock('../src/ui/touch-tooltip', () => ({ initTouchTooltipSupport: () => {} }));
vi.mock('../src/settings/setting-tab', () => ({ NoteNarratorSettingTab: class {} }));

type Handler = (...args: unknown[]) => unknown;

/** An app whose vault and workspace record event handlers, so a test can fire them like Obsidian does. */
class FakeApp {
	readonly handlers = new Map<string, Handler[]>();
	activeView: MarkdownView | null = null;
	private readonly events = { on: (name: string, handler: Handler) => this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]) };

	fire(name: string, ...args: unknown[]): void {
		for (const handler of this.handlers.get(name) ?? []) handler(...args);
	}

	app(): App {
		return {
			vault: { on: this.events.on },
			metadataCache: { on: this.events.on },
			workspace: {
				on: this.events.on,
				onLayoutReady: () => {},
				getActiveViewOfType: () => this.activeView,
				getLeavesOfType: () => [],
				getRightLeaf: () => null,
			},
		} as unknown as App;
	}
}

function file(path: string): TFile {
	return Object.assign(new TFile(), { path });
}

function markdownView(path: string): MarkdownView {
	return Object.assign(new MarkdownView(), { file: file(path) });
}

let app: FakeApp;
let plugin: NoteNarratorPlugin;

function reader(): Record<string, ReturnType<typeof vi.fn>> {
	if (!fakes.reader) throw new Error('the plugin has not created its Reader');
	return fakes.reader;
}

function command(id: string): StubCommand {
	const found = (plugin as unknown as { commands: StubCommand[] }).commands.find((c) => c.id === id);
	if (!found) throw new Error(`no command ${id}`);
	return found;
}

beforeEach(async () => {
	fakes.reader = null;
	debouncers.length = 0;
	app = new FakeApp();
	plugin = new NoteNarratorPlugin(app.app(), {} as PluginManifest);
	await plugin.onload();
});

describe('NoteNarratorPlugin: vault events', () => {
	it('tells the Reader when a file is deleted', () => {
		app.fire('delete', file('Folder/Note.md'));

		expect(reader().handleFileDeleted).toHaveBeenCalledWith('Folder/Note.md');
	});

	it('tells the Reader when a file is renamed or moved, with its new and old paths', () => {
		app.fire('rename', file('Archive/Note.mp3'), 'Audio/Note.mp3');

		expect(reader().handleFileRenamed).toHaveBeenCalledWith('Archive/Note.mp3', 'Audio/Note.mp3');
	});

	it('auto-generates a note when it is opened, but not when the tab is left with no file', () => {
		app.fire('file-open', file('Note.md'));
		app.fire('file-open', null);

		expect(reader().autoGenerateIfNeeded).toHaveBeenCalledTimes(1);
		expect(reader().autoGenerateIfNeeded).toHaveBeenCalledWith(expect.objectContaining({ path: 'Note.md' }));
	});
});

describe('NoteNarratorPlugin: commands', () => {
	it('offers Read note aloud only while a note is open', () => {
		expect(command('read-note-aloud').checkCallback?.(true)).toBe(false);

		app.activeView = markdownView('Note.md');
		expect(command('read-note-aloud').checkCallback?.(true)).toBe(true);
		expect(reader().readNote).not.toHaveBeenCalled();
	});

	it('opens the panel and reads the open note when Read note aloud runs', () => {
		const activateView = vi.spyOn(plugin, 'activateView');
		const view = markdownView('Note.md');
		app.activeView = view;

		command('read-note-aloud').checkCallback?.(false);

		expect(activateView).toHaveBeenCalledTimes(1);
		expect(reader().readNote).toHaveBeenCalledWith(view);
	});

	it('offers Generate note audio in background only while a note is open, and generates it when run', () => {
		expect(command('generate-note-in-background').checkCallback?.(true)).toBe(false);

		const view = markdownView('Note.md');
		app.activeView = view;
		expect(command('generate-note-in-background').checkCallback?.(true)).toBe(true);
		expect(reader().generateNoteInBackground).not.toHaveBeenCalled();

		command('generate-note-in-background').checkCallback?.(false);
		expect(reader().generateNoteInBackground).toHaveBeenCalledWith(view);
	});

	it('stops the Reader with Stop reading', () => {
		command('stop-reading').callback?.();

		expect(reader().stop).toHaveBeenCalled();
	});
});

describe('NoteNarratorPlugin: unloading', () => {
	it('disposes the Reader', () => {
		plugin.unload();

		expect(reader().dispose).toHaveBeenCalledTimes(1);
	});

	it('cancels a pending toolbar icon refresh', () => {
		plugin.unload();

		expect(debouncers.length).toBeGreaterThan(0);
		expect(debouncers.every((debouncer) => debouncer.cancelled)).toBe(true);
	});
});
