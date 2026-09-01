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
	/** HTMLAudioElement.playbackRate applied to the generated audio during playback. */
	playbackRate: number;
	/** Seconds the skip-forward/rewind buttons in the player view jump by. */
	skipSeconds: number;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	apiKeySecretId: 'elevenlabs-api-key',
	voiceId: '21m00Tcm4TlvDq8ikWAM',
	modelId: 'eleven_multilingual_v2',
	stability: 0.5,
	similarityBoost: 0.75,
	readSelectionIfPresent: true,
	playbackRate: 1,
	skipSeconds: 15,
};

export const ELEVENLABS_MODELS: Record<string, string> = {
	eleven_v3: 'Eleven v3 (research preview)',
	eleven_multilingual_v2: 'Eleven Multilingual v2',
	eleven_flash_v2_5: 'Eleven Flash v2.5',
};

/** ElevenLabs' documented per-request character limit for each model. */
export const ELEVENLABS_MODEL_CHAR_LIMITS: Record<string, number> = {
	eleven_v3: 5000,
	eleven_multilingual_v2: 10000,
	eleven_flash_v2_5: 40000,
};

export const DEFAULT_ELEVENLABS_CHAR_LIMIT = 5000;

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
			.setDesc(
				'Lower values sound more expressive and varied; higher values sound steadier. ' +
					"On Eleven v3, this maps to ElevenLabs' Creative (low) / Natural (middle) / Robust (high) presets.",
			)
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

		new Setting(containerEl)
			.setName('Playback speed')
			.setDesc(
				'Speed of the generated audio during playback. Applied on the audio player, so it works regardless of TTS provider or voice. Also adjustable live from the player view.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 2, 0.05)
					.setValue(this.plugin.settings.playbackRate)
					.onChange(async (value) => {
						this.plugin.reader.setPlaybackRate(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Skip amount')
			.setDesc('How many seconds the skip-forward and rewind buttons in the player view jump by.')
			.addSlider((slider) =>
				slider
					.setLimits(5, 60, 5)
					.setValue(this.plugin.settings.skipSeconds)
					.onChange(async (value) => {
						this.plugin.settings.skipSeconds = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
