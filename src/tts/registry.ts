import { App } from 'obsidian';
import type { ProviderEntry, VoiceConfig } from '../profiles';
import { ElevenLabsProvider, getElevenLabsVoiceName } from './elevenlabs-provider';
import { TTSProvider } from './provider';

/*
 * The one place that maps a provider *type* to its implementation. Adding a TTS backend means adding a
 * case to each function here (plus its entry/voice config types in profiles.ts and its settings UI).
 */

/** The provider's API key from Obsidian's secret storage, or null when none is configured. */
export function getProviderApiKey(app: App, provider: ProviderEntry): string | null {
	switch (provider.type) {
		case 'elevenlabs':
			return app.secretStorage.getSecret(provider.apiKeySecretId) || null;
	}
}

export function missingApiKeyMessage(provider: ProviderEntry): string {
	return `Set an API key for the "${provider.name}" provider in the Note Narrator settings.`;
}

/** Builds the synthesizer for a provider and one of its narrator's voice configuration. */
export function createTTSProvider(provider: ProviderEntry, voice: VoiceConfig, apiKey: string, onRateLimited?: () => void): TTSProvider {
	switch (provider.type) {
		case 'elevenlabs':
			if (voice.type !== 'elevenlabs') throw new Error("The narrator's voice configuration doesn't match its provider type.");
			return new ElevenLabsProvider(apiKey, voice, onRateLimited);
	}
}

/** A human-readable name for the voice, e.g. to label a saved audio filename. Falls back to the raw voice ID. */
export async function resolveVoiceLabel(provider: ProviderEntry, voice: VoiceConfig, apiKey: string): Promise<string> {
	switch (provider.type) {
		case 'elevenlabs':
			if (voice.type !== 'elevenlabs') return 'voice';
			try {
				return await getElevenLabsVoiceName(apiKey, voice.voiceId);
			} catch (error) {
				console.error('Note Narrator: failed to resolve voice name for filename', error);
				return voice.voiceId;
			}
	}
}
