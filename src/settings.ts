import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import ObsidianReaderPlugin from './main';

export interface ReaderSettings {
	/** Name of the secret in Obsidian's SecretStorage holding the ElevenLabs API key. */
	apiKeySecretId: string;
	voiceId: string;
	modelId: string;
	stability: number;
	similarityBoost: number;
	readSelectionIfPresent: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	apiKeySecretId: 'elevenlabs-api-key',
	voiceId: '21m00Tcm4TlvDq8ikWAM',
	modelId: 'eleven_multilingual_v2',
	stability: 0.5,
	similarityBoost: 0.75,
	readSelectionIfPresent: true,
};

export const ELEVENLABS_MODELS: Record<string, string> = {
	eleven_multilingual_v2: 'Eleven Multilingual v2',
	eleven_turbo_v2_5: 'Eleven Turbo v2.5',
	eleven_flash_v2_5: 'Eleven Flash v2.5',
};

export class ReaderSettingTab extends PluginSettingTab {
	plugin: ObsidianReaderPlugin;

	constructor(app: App, plugin: ObsidianReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('ElevenLabs').setHeading();

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Stored in Obsidian\'s secret storage, not in this plugin\'s settings file.')
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(this.plugin.settings.apiKeySecretId).onChange(async (value) => {
					this.plugin.settings.apiKeySecretId = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Voice ID')
			.setDesc('The ElevenLabs voice ID to use. Find voice IDs in your ElevenLabs voice library.')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.voiceId)
					.setValue(this.plugin.settings.voiceId)
					.onChange(async (value) => {
						this.plugin.settings.voiceId = value.trim() || DEFAULT_SETTINGS.voiceId;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Model')
			.setDesc('The ElevenLabs text-to-speech model to use.')
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(ELEVENLABS_MODELS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.modelId).onChange(async (value) => {
					this.plugin.settings.modelId = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Stability')
			.setDesc('Lower values sound more expressive and varied; higher values sound steadier.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.stability)
					.onChange(async (value) => {
						this.plugin.settings.stability = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Similarity boost')
			.setDesc('How closely the output should match the original voice.')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.similarityBoost)
					.onChange(async (value) => {
						this.plugin.settings.similarityBoost = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Reading').setHeading();

		new Setting(containerEl)
			.setName('Read selection instead of whole note')
			.setDesc('When enabled, reading a note with an active text selection reads only the selection.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.readSelectionIfPresent).onChange(async (value) => {
					this.plugin.settings.readSelectionIfPresent = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
