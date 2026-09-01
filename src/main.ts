import { Plugin } from 'obsidian';
import { Reader } from './reader';
import { DEFAULT_SETTINGS, ReaderSettings, ReaderSettingTab } from './settings';

export default class ObsidianReaderPlugin extends Plugin {
	settings!: ReaderSettings;
	reader!: Reader;

	async onload() {
		await this.loadSettings();
		this.reader = new Reader(this.app, this.settings);

		this.addRibbonIcon('audio-lines', 'Read note aloud', () => {
			void this.reader.readActiveNote();
		});

		this.addCommand({
			id: 'read-note-aloud',
			name: 'Read note aloud',
			callback: () => void this.reader.readActiveNote(),
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ReaderSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
