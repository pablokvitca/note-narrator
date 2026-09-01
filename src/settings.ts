import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import ObsidianReaderPlugin from './main';
import { ChunkerStyle } from './text-utils';
import { ElevenLabsVoice, listElevenLabsVoices } from './tts/elevenlabs-provider';

export type SaveAudioLocation = 'note-folder' | 'custom-folder';
export type SaveVersioning = 'replace' | 'keep';

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
	/** Whether to write a link to the saved audio file into the note's frontmatter. */
	linkAudioInNote: boolean;
	/** Frontmatter property the audio link is written to. */
	audioLinkProperty: string;
	/** Frontmatter property the content hash is written to, used to detect staleness. */
	audioHashProperty: string;
	/** Frontmatter property the raw vault path to the audio file is written to, used internally to find it again. */
	audioPathProperty: string;
	/** Frontmatter property the generation timestamp is written to. */
	audioTimestampProperty: string;
	/** Frontmatter property the voice ID used to generate the audio is written to. */
	audioVoiceProperty: string;
	/** Show a "Clear reader files" button in the player view. */
	showClearFilesButton: boolean;
	/** Silently (re)generate and save a note's audio on open if missing or outdated. Requires saveAudioFile and linkAudioInNote. */
	autoGenerateOnOpen: boolean;
	/** Whether regenerating a note's audio replaces the previously linked file or keeps it and creates a new one. Only applies when linkAudioInNote is on. */
	saveVersioning: SaveVersioning;
	/** How to split note text into TTS requests. */
	chunkerStyle: ChunkerStyle;
	/** Headings at or shallower than this depth (1 = H1) start a new section when chunkerStyle is 'markdown-aware'. */
	maxHeadingDepth: number;
	/** Speak the note's title before its content. */
	readTitle: boolean;
	/** Speak "Properties", each frontmatter property and value, then "Content", before the note's content. */
	readProperties: boolean;
	/** Voice IDs shown in the player view's Voice dropdown. Empty means show all fetched voices there. */
	panelVoiceIds: string[];
	/** Start playback as soon as the first chunk is ready, rather than waiting for the whole note to generate. */
	startPlaybackImmediately: boolean;
	/** Generate an artificially short first chunk so playback can start sooner. Only applies when startPlaybackImmediately is on. */
	quickStart: boolean;
	/** Whether to generate more than one chunk at a time ahead of playback. */
	parallelGenerationEnabled: boolean;
	/** How many chunks may be generating at once when parallelGenerationEnabled is on. */
	maxParallelGeneration: number;
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
	linkAudioInNote: false,
	audioLinkProperty: 'reader_audio',
	audioHashProperty: 'reader_audio_hash',
	audioPathProperty: 'reader_audio_path',
	audioTimestampProperty: 'reader_audio_timestamp',
	audioVoiceProperty: 'reader_audio_voice',
	showClearFilesButton: true,
	autoGenerateOnOpen: false,
	saveVersioning: 'replace',
	chunkerStyle: 'markdown-aware',
	maxHeadingDepth: 2,
	readTitle: true,
	readProperties: false,
	panelVoiceIds: [],
	startPlaybackImmediately: true,
	quickStart: true,
	parallelGenerationEnabled: true,
	maxParallelGeneration: 2,
};

/** Target size for the artificially short first chunk when quickStart is on. */
export const QUICK_START_CHUNK_CHARS = 400;

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
	private voices: ElevenLabsVoice[] = [];
	private voicesLoaded = false;

	constructor(app: App, plugin: ObsidianReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		if (!this.voicesLoaded) {
			this.voicesLoaded = true;
			void this.loadVoices();
		}

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

		const currentVoiceId = this.plugin.settings.voiceId;
		new Setting(containerEl)
			.setName('Voice')
			.setDesc('Voices fetched from your ElevenLabs account (first 100). Use the refresh button after adding an API key or creating new voices.')
			.addDropdown((dropdown) => {
				if (this.voices.length === 0) {
					dropdown.addOption(currentVoiceId, currentVoiceId);
				} else {
					for (const voice of this.voices) {
						dropdown.addOption(voice.voiceId, voice.name);
					}
					if (!this.voices.some((voice) => voice.voiceId === currentVoiceId)) {
						dropdown.addOption(currentVoiceId, `${currentVoiceId} (custom)`);
					}
				}
				dropdown.setValue(currentVoiceId);
				dropdown.onChange(async (value) => {
					this.plugin.settings.voiceId = value;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon('refresh-cw')
					.setTooltip('Refresh voice list from ElevenLabs')
					.onClick(() => this.loadVoices()),
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

		new Setting(containerEl).setName('Panel voices').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: "Choose a short list of voices to show in the player view's Voice dropdown, instead of your whole account list. Leave none selected to show all voices there.",
		});

		if (this.voices.length === 0) {
			containerEl.createEl('p', { cls: 'setting-item-description', text: 'Voices not loaded yet — set an API key and use the refresh button above.' });
		} else {
			for (const voice of this.voices) {
				new Setting(containerEl).setName(voice.name).addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.panelVoiceIds.includes(voice.voiceId)).onChange(async (value) => {
						const ids = new Set(this.plugin.settings.panelVoiceIds);
						if (value) ids.add(voice.voiceId);
						else ids.delete(voice.voiceId);
						this.plugin.settings.panelVoiceIds = Array.from(ids);
						await this.plugin.saveSettings();
					}),
				);
			}
		}

		new Setting(containerEl).setName('Reading').setHeading();

		new Setting(containerEl)
			.setName('Read note title')
			.setDesc('Speak the note\'s title before its content.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.readTitle).onChange(async (value) => {
					this.plugin.settings.readTitle = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Read note properties')
			.setDesc('Speak "Properties", each frontmatter property and value, then "Content", before the note\'s content. Does not apply when reading a selection.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.readProperties).onChange(async (value) => {
					this.plugin.settings.readProperties = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Text chunker')
			.setDesc(
				'How to split note text into TTS requests. Markdown-aware splits by heading section first, then by sentence within each section. Sentence-only ignores headings and packs sentences up to the character limit.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ 'markdown-aware': 'Markdown-aware (default)', sentence: 'Sentence-only' })
					.setValue(this.plugin.settings.chunkerStyle)
					.onChange(async (value) => {
						this.plugin.settings.chunkerStyle = value as ChunkerStyle;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.chunkerStyle === 'markdown-aware') {
			new Setting(containerEl)
				.setName('Max heading depth for sections')
				.setDesc('Headings at or shallower than this depth (1 = #, 2 = ## and shallower, etc.) start a new section. Deeper headings stay within their enclosing section.')
				.addSlider((slider) =>
					slider
						.setLimits(1, 6, 1)
						.setValue(this.plugin.settings.maxHeadingDepth)
						.onChange(async (value) => {
							this.plugin.settings.maxHeadingDepth = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl).setName('Performance').setHeading();

		new Setting(containerEl)
			.setName('Start playback immediately')
			.setDesc('Start playing as soon as the first chunk is ready, instead of waiting for the whole note to finish generating first.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.startPlaybackImmediately).onChange(async (value) => {
					this.plugin.settings.startPlaybackImmediately = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.startPlaybackImmediately) {
			new Setting(containerEl)
				.setName('Quick start')
				.setDesc(
					`Generate an artificially short first chunk (~${QUICK_START_CHUNK_CHARS} characters) so playback can start sooner, especially on long notes.`,
				)
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.quickStart).onChange(async (value) => {
						this.plugin.settings.quickStart = value;
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName('Generate chunks in parallel')
			.setDesc('Generate more than one chunk ahead of playback at once, instead of strictly one at a time.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.parallelGenerationEnabled).onChange(async (value) => {
					this.plugin.settings.parallelGenerationEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.parallelGenerationEnabled) {
			new Setting(containerEl)
				.setName('Max parallel chunk generation')
				.setDesc('How many chunks may be generating at the same time. Higher can finish long notes faster but makes more simultaneous ElevenLabs requests.')
				.addSlider((slider) =>
					slider
						.setLimits(2, 5, 1)
						.setValue(this.plugin.settings.maxParallelGeneration)
						.onChange(async (value) => {
							this.plugin.settings.maxParallelGeneration = value;
							await this.plugin.saveSettings();
						}),
				);
		}

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
			.setName('Default playback speed')
			.setDesc(
				'Starting speed for each read. The player view has its own speed slider to adjust playback live without changing this default.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 3, 0.05)
					.setValue(this.plugin.settings.playbackRate)
					.onChange(async (value) => {
						this.plugin.settings.playbackRate = value;
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

			new Setting(containerEl)
				.setName('Link saved audio in the note')
				.setDesc(
					'When enabled, writes a link to the saved audio file into a frontmatter property on the note, and tracks whether the note has changed since — shown in the player view.',
				)
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.linkAudioInNote).onChange(async (value) => {
						this.plugin.settings.linkAudioInNote = value;
						await this.plugin.saveSettings();
						this.display();
					}),
				);

			if (this.plugin.settings.linkAudioInNote) {
				this.renderPropertyField(containerEl, 'Link property', 'Frontmatter property the audio link is written to.', 'audioLinkProperty');
				this.renderPropertyField(
					containerEl,
					'Hash property',
					'Frontmatter property the content hash is written to, used to detect staleness.',
					'audioHashProperty',
				);
				this.renderPropertyField(
					containerEl,
					'Path property',
					'Frontmatter property the raw vault path to the audio file is written to (used internally to find it again).',
					'audioPathProperty',
				);
				this.renderPropertyField(
					containerEl,
					'Timestamp property',
					'Frontmatter property the generation timestamp is written to.',
					'audioTimestampProperty',
				);
				this.renderPropertyField(
					containerEl,
					'Voice property',
					'Frontmatter property the voice ID used to generate the audio is written to. Used to detect when the selected voice differs from the saved audio\'s voice.',
					'audioVoiceProperty',
				);

				new Setting(containerEl)
					.setName('On regenerate')
					.setDesc(
						'What to do when a note\'s audio already exists and is regenerated: replace the previously linked file, or keep it and create a new one.',
					)
					.addDropdown((dropdown) =>
						dropdown
							.addOptions({ replace: 'Replace existing file', keep: 'Keep old versions' })
							.setValue(this.plugin.settings.saveVersioning)
							.onChange(async (value) => {
								this.plugin.settings.saveVersioning = value as SaveVersioning;
								await this.plugin.saveSettings();
							}),
					);

				new Setting(containerEl)
					.setName('Auto-generate on open')
					.setDesc(
						'When enabled, opening a note silently (re)generates and saves its audio in the background if missing or outdated — without playing it or interrupting anything currently playing.',
					)
					.addToggle((toggle) =>
						toggle.setValue(this.plugin.settings.autoGenerateOnOpen).onChange(async (value) => {
							this.plugin.settings.autoGenerateOnOpen = value;
							await this.plugin.saveSettings();
						}),
					);

				new Setting(containerEl)
					.setName('Show "Clear reader files" button')
					.setDesc('Show a button in the player view that deletes a note\'s linked audio file and removes the properties above, after confirming.')
					.addToggle((toggle) =>
						toggle.setValue(this.plugin.settings.showClearFilesButton).onChange(async (value) => {
							this.plugin.settings.showClearFilesButton = value;
							await this.plugin.saveSettings();
						}),
					);
			}
		}
	}

	private renderPropertyField(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: 'audioLinkProperty' | 'audioHashProperty' | 'audioPathProperty' | 'audioTimestampProperty' | 'audioVoiceProperty',
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS[key])
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value.trim() || DEFAULT_SETTINGS[key];
						await this.plugin.saveSettings();
					}),
			);
	}

	private async loadVoices(): Promise<void> {
		const apiKey = this.app.secretStorage.getSecret(this.plugin.settings.apiKeySecretId);
		if (!apiKey) return;

		try {
			this.voices = await listElevenLabsVoices(apiKey);
			this.display();
		} catch (error) {
			console.error('Obsidian Reader: failed to fetch ElevenLabs voices', error);
			new Notice(`Failed to fetch voices: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
