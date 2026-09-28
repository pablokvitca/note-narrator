import { App, DropdownComponent, Notice } from 'obsidian';
import { ElevenLabsVoice, listElevenLabsVoices } from '../tts/elevenlabs-provider';
import { ProviderEntry } from './profiles';
import { getProviderCredentials } from '../tts/registry';

/**
 * The voices each ElevenLabs provider's account offers, loaded on demand for the narrator profile voice
 * dropdown. AWS providers don't use this cache: Polly's voice list is static (see `aws-models.ts`), so its
 * settings UI reads `AWS_POLLY_VOICES` directly instead of going through here. Generalizing this cache to
 * cover both shapes (one fetched per-account, one static) is a separate decision -- left alone for now.
 */
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

	/** Loads (once, unless `force`) the voices available to an ElevenLabs provider, for the profile voice dropdown. */
	ensureVoices(provider: ProviderEntry, notify = false): Promise<void> {
		if (provider.type !== 'elevenlabs') return Promise.resolve();
		if (this.voicesByProvider.has(provider.id)) return Promise.resolve();
		const existing = this.voiceLoads.get(provider.id);
		if (existing) return existing;

		const credentials = getProviderCredentials(this.app, provider);
		// VoiceCache is ElevenLabs-only today (see the class doc); a provider whose credentials aren't the
		// single-API-key elevenlabs shape has no voice list to fetch here.
		if (!credentials || credentials.type !== 'elevenlabs') return Promise.resolve();

		const load = (async () => {
			try {
				this.voicesByProvider.set(provider.id, await listElevenLabsVoices(credentials.apiKey));
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
