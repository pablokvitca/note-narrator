import { App, DropdownComponent, Notice } from 'obsidian';
import { ElevenLabsVoice, listElevenLabsVoices } from '../tts/elevenlabs-provider';
import { ProviderEntry } from './profiles';
import { getProviderApiKey } from '../tts/registry';

/** The voices each provider's account offers, loaded on demand for the narrator profile voice dropdown. */
export class VoiceCache {
	readonly voicesByProvider = new Map<string, ElevenLabsVoice[]>();
	private voiceLoads = new Map<string, Promise<void>>();

	constructor(private readonly app: App) {}

	populateVoiceDropdown(dropdown: DropdownComponent, provider: ProviderEntry, currentVoiceId: string): void {
		const voices = this.voicesByProvider.get(provider.id) ?? [];
		dropdown.selectEl.empty();
		if (voices.length === 0) {
			dropdown.addOption(currentVoiceId, currentVoiceId);
		} else {
			for (const voice of voices) dropdown.addOption(voice.voiceId, voice.name);
			if (!voices.some((voice) => voice.voiceId === currentVoiceId)) dropdown.addOption(currentVoiceId, `${currentVoiceId} (custom)`);
		}
		dropdown.setValue(currentVoiceId);
	}

	/** Loads (once, unless `force`) the voices available to a provider, for the profile voice dropdown. */
	ensureVoices(provider: ProviderEntry, notify = false): Promise<void> {
		if (this.voicesByProvider.has(provider.id)) return Promise.resolve();
		const existing = this.voiceLoads.get(provider.id);
		if (existing) return existing;

		const apiKey = getProviderApiKey(this.app, provider);
		if (!apiKey) return Promise.resolve();

		const load = (async () => {
			try {
				this.voicesByProvider.set(provider.id, await listElevenLabsVoices(apiKey));
			} catch (error) {
				console.error('Note Narrator: failed to fetch ElevenLabs voices', error);
				if (notify) new Notice(`Failed to fetch voices: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.voiceLoads.delete(provider.id);
			}
		})();
		this.voiceLoads.set(provider.id, load);
		return load;
	}
}
