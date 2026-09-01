import { App, DropdownComponent, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import ObsidianReaderPlugin from './main';
import { listElevenLabsVoices } from './tts/elevenlabs-provider';

export type SaveAudioLocation = 'note-folder' | 'custom-folder';

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
	/** Whether to also save the generated audio as a file in the vault. */
	saveAudioFile: boolean;
	saveAudioLocation: SaveAudioLocation;
	/** Vault-relative folder path used when saveAudioLocation is 'custom-folder'. */
	saveAudioFolderPath: string;
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
	saveAudioFile: false,
	saveAudioLocation: 'note-folder',
	saveAudioFolderPath: 'Reader Audio',
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

		let voiceDropdown: DropdownComponent | undefined;
		new Setting(containerEl)
			.setName('Voice')
			.setDesc('Voices fetched from your ElevenLabs account (first 100). Use the refresh button after adding an API key or creating new voices.')
			.addDropdown((dropdown) => {
				voiceDropdown = dropdown;
				dropdown.addOption(this.plugin.settings.voiceId, this.plugin.settings.voiceId);
				dropdown.setValue(this.plugin.settings.voiceId);
				dropdown.onChange(async (value) => {
					this.plugin.settings.voiceId = value;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon('refresh-cw')
					.setTooltip('Refresh voice list from ElevenLabs')
					.onClick(() => this.refreshVoices(voiceDropdown)),
			);
		void this.refreshVoices(voiceDropdown);

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

		new Setting(containerEl).setName('Save audio').setHeading();

		new Setting(containerEl)
			.setName('Save generated audio to a file')
			.setDesc('When enabled, also saves the audio generated by a read as an .mp3 file in the vault. Disabled by default.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.saveAudioFile).onChange(async (value) => {
					this.plugin.settings.saveAudioFile = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.saveAudioFile) {
			new Setting(containerEl)
				.setName('Save location')
				.setDesc('Where to save the audio file.')
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({ 'note-folder': 'Same folder as the note', 'custom-folder': 'Custom folder' })
						.setValue(this.plugin.settings.saveAudioLocation)
						.onChange(async (value) => {
							this.plugin.settings.saveAudioLocation = value as SaveAudioLocation;
							await this.plugin.saveSettings();
							this.display();
						}),
				);

			if (this.plugin.settings.saveAudioLocation === 'custom-folder') {
				new Setting(containerEl)
					.setName('Custom folder path')
					.setDesc('Vault-relative folder to save audio files in. Created automatically if it doesn\'t exist.')
					.addText((text) =>
						text
							.setPlaceholder(DEFAULT_SETTINGS.saveAudioFolderPath)
							.setValue(this.plugin.settings.saveAudioFolderPath)
							.onChange(async (value) => {
								this.plugin.settings.saveAudioFolderPath = value.trim() || DEFAULT_SETTINGS.saveAudioFolderPath;
								await this.plugin.saveSettings();
							}),
					);
			}
		}
	}

	private async refreshVoices(dropdown: DropdownComponent | undefined): Promise<void> {
		if (!dropdown) return;

		const apiKey = this.app.secretStorage.getSecret(this.plugin.settings.apiKeySecretId);
		if (!apiKey) return;

		try {
			const voices = await listElevenLabsVoices(apiKey);
			const currentValue = this.plugin.settings.voiceId;

			dropdown.selectEl.empty();
			for (const voice of voices) {
				dropdown.addOption(voice.voiceId, voice.name);
			}
			if (!voices.some((voice) => voice.voiceId === currentValue)) {
				dropdown.addOption(currentValue, `${currentValue} (custom)`);
			}
			dropdown.setValue(currentValue);
		} catch (error) {
			console.error('Obsidian Reader: failed to fetch ElevenLabs voices', error);
			new Notice(`Failed to fetch voices: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
