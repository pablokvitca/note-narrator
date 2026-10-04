import { debounce, MarkdownView, Plugin, setIcon, TFile } from 'obsidian';
import { createHighlightExtension } from './ui/highlight-extension';
import { migrateProfileSettings, normalizeProfileSettings } from './settings/profiles';
import { registerCustomIcons, SAVED_TOOLBAR_ICON_ID } from './ui/icons';
import { PlayerView, NOTE_NARRATOR_VIEW_TYPE } from './ui/player-view';
import { Reader } from './engine/reader';
import { DEFAULT_SETTINGS, NoteNarratorSettings } from './settings/settings';
import { NoteNarratorSettingTab } from './settings/setting-tab';
import { initTouchTooltipSupport } from './ui/touch-tooltip';

export default class NoteNarratorPlugin extends Plugin {
	settings!: NoteNarratorSettings;
	reader!: Reader;

	private patchedViews = new WeakMap<MarkdownView, HTMLElement>();
	// MarkdownView instances (and their DOM) survive a plugin reload/update; track the action
	// buttons we add so onunload can remove them and a fresh load doesn't duplicate them.
	private actionButtons: HTMLElement[] = [];

	async onload() {
		registerCustomIcons();
		initTouchTooltipSupport(this);
		await this.loadSettings();
		this.reader = new Reader(this.app, this.settings);

		this.registerView(NOTE_NARRATOR_VIEW_TYPE, (leaf) => new PlayerView(leaf, this));
		this.registerEditorExtension(createHighlightExtension(this));

		this.addRibbonIcon('audio-lines', 'Read note aloud', () => {
			void this.activateView();
		});

		this.app.workspace.onLayoutReady(() => this.patchOpenMarkdownViews());
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.patchOpenMarkdownViews()));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.patchOpenMarkdownViews()));
		// The saved-audio state can change from a frontmatter update (audio linked/unlinked), a content
		// edit (up to date -> outdated), or the Note Narrator panel saving audio; refresh the toolbar icons for
		// all of those. Content edits are debounced since each refresh re-hashes the note.
		const refreshIcons = debounce(() => void this.refreshActionIcons(), 1000, true);
		this.registerEvent(this.app.metadataCache.on('changed', refreshIcons));
		this.registerEvent(this.app.vault.on('modify', refreshIcons));
		// The linked audio file being deleted or moved (from the file explorer or outside Obsidian) changes the status too.
		this.registerEvent(this.app.vault.on('delete', refreshIcons));
		this.registerEvent(this.app.vault.on('rename', refreshIcons));
		// A note's link/hash actually changed (audio saved, or cleared from the panel): refresh right away.
		this.registerEvent(this.reader.on('audio-status-change', () => void this.refreshActionIcons()));
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				// The toolbar button belongs to the view, which is reused when the tab switches notes.
				void this.refreshActionIcons();
				if (file instanceof TFile) void this.reader.autoGenerateIfNeeded(file);
			}),
		);

		this.addCommand({
			id: 'read-note-aloud',
			name: 'Read note aloud',
			// Only available while a note is open, so the command doesn't open an empty panel plus a notice.
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (!checking) {
					void this.activateView();
					void this.reader.readNote(view);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'generate-note-in-background',
			name: 'Generate note audio in background',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (!checking) this.reader.generateNoteInBackground(view);
				return true;
			},
		});

		this.addCommand({
			id: 'stop-reading',
			name: 'Stop reading',
			callback: () => this.reader.stop(),
		});

		this.addSettingTab(new NoteNarratorSettingTab(this.app, this));
	}

	onunload() {
		this.reader?.dispose();
		for (const button of this.actionButtons) {
			button.remove();
		}
		this.actionButtons = [];
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(NOTE_NARRATOR_VIEW_TYPE)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: NOTE_NARRATOR_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
	}

	private patchOpenMarkdownViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView) this.patchMarkdownView(leaf.view);
		}
	}

	private patchMarkdownView(view: MarkdownView): void {
		if (this.patchedViews.has(view)) return;
		const button = view.addAction('audio-lines', 'Read note aloud', () => {
			void this.activateView();
		});
		this.patchedViews.set(view, button);
		this.actionButtons.push(button);
		void this.refreshActionIcon(view);
	}

	private async refreshActionIcons(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (!(leaf.view instanceof MarkdownView)) continue;
			// One note failing (e.g. unreadable, or odd Note Narrator properties) mustn't stop the rest refreshing.
			try {
				await this.refreshActionIcon(leaf.view);
			} catch (error) {
				console.error('Note Narrator: failed to refresh the toolbar icon', error);
			}
		}
	}

	/** Swaps the in-note toolbar icon to a "saved" variant while the view's note has up-to-date saved audio. */
	private async refreshActionIcon(view: MarkdownView): Promise<void> {
		const button = this.patchedViews.get(view);
		const file = view.file;
		if (!button || !file) return;

		const saved = (await this.reader.getAudioStatus(file)) === 'up-to-date';
		// The view may have moved to another note while the status was being computed.
		if (view.file !== file) return;

		const state = saved ? 'saved' : 'default';
		if (button.dataset.readerState === state) return;
		button.dataset.readerState = state;
		setIcon(button, saved ? SAVED_TOOLBAR_ICON_ID : 'audio-lines');
		button.setAttribute('aria-label', saved ? 'Read note aloud (saved audio is up to date)' : 'Read note aloud');
	}

	async loadSettings() {
		const saved = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		// Pre-profile settings (flat voice/model/API key) become a provider + narrator profile; a fresh
		// install gets a default pair. Saved back right away so the upgrade only ever runs once.
		const needsMigration = !Array.isArray(saved.providers) || saved.providers.length === 0;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, migrateProfileSettings(saved));
		normalizeProfileSettings(this.settings);
		if (needsMigration) await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshPanels();
	}

	/** Re-renders any open player panel so it reflects settings changed elsewhere (profiles added, renamed or edited). */
	refreshPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(NOTE_NARRATOR_VIEW_TYPE)) {
			if (leaf.view instanceof PlayerView) leaf.view.refresh();
		}
	}
}
