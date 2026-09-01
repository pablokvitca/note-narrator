import { MarkdownView, Plugin, TFile } from 'obsidian';
import { PlayerView, READER_VIEW_TYPE } from './player-view';
import { Reader } from './reader';
import { DEFAULT_SETTINGS, ReaderSettings, ReaderSettingTab } from './settings';

export default class ObsidianReaderPlugin extends Plugin {
	settings!: ReaderSettings;
	reader!: Reader;

	private patchedViews = new WeakSet<MarkdownView>();

	async onload() {
		await this.loadSettings();
		this.reader = new Reader(this.app, this.settings);

		this.registerView(READER_VIEW_TYPE, (leaf) => new PlayerView(leaf, this));

		this.addRibbonIcon('audio-lines', 'Read note aloud', () => {
			void this.activateView();
			void this.reader.readNote();
		});

		this.app.workspace.onLayoutReady(() => this.patchOpenMarkdownViews());
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.patchOpenMarkdownViews()));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.patchOpenMarkdownViews()));
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file instanceof TFile) void this.reader.autoGenerateIfNeeded(file);
			}),
		);

		this.addCommand({
			id: 'read-note-aloud',
			name: 'Read note aloud',
			callback: () => {
				void this.activateView();
				void this.reader.readNote();
			},
		});

		this.addCommand({
			id: 'stop-reading',
			name: 'Stop reading',
			callback: () => this.reader.stop(),
		});

		this.addSettingTab(new ReaderSettingTab(this.app, this));
	}

	onunload() {
		this.reader?.stop();
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(READER_VIEW_TYPE)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: READER_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
	}

	private patchOpenMarkdownViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView) this.patchMarkdownView(leaf.view);
		}
	}

	private patchMarkdownView(view: MarkdownView): void {
		if (this.patchedViews.has(view)) return;
		this.patchedViews.add(view);
		view.addAction('audio-lines', 'Read note aloud', () => {
			void this.activateView();
			void this.reader.readNote(view);
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ReaderSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
