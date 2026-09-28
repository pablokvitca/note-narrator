import { App } from 'obsidian';
import type { ProviderEntry, ProviderType, VoiceConfig } from '../settings/profiles';
import { ElevenLabsProvider, getElevenLabsVoiceName } from './elevenlabs-provider';
import { AudioFormat, TTSProvider } from './provider';

/*
 * The one place that maps a provider *type* to its implementation. Adding a TTS backend means adding a
 * case to each function here (plus its entry/voice config types in profiles.ts and its settings UI).
 */

/**
 * A provider's credentials, shaped per provider type: most are a single API key, but a provider that signs its
 * requests needs several fields instead of one string. Each provider type adds its own member.
 */
export type ProviderCredentials = { type: 'elevenlabs'; apiKey: string };

/** The provider's credentials from Obsidian's secret storage, or null when they aren't all set. */
export function getProviderCredentials(app: App, provider: ProviderEntry): ProviderCredentials | null {
	switch (provider.type) {
		case 'elevenlabs': {
			const apiKey = app.secretStorage.getSecret(provider.apiKeySecretId);
			return apiKey ? { type: 'elevenlabs', apiKey } : null;
		}
	}
}

/** What a provider type's credentials are called, as in "no API key set". */
export function credentialsLabel(type: ProviderType): string {
	switch (type) {
		case 'elevenlabs':
			return 'API key';
	}
}

export function missingCredentialsMessage(provider: ProviderEntry): string {
	return `Set the ${credentialsLabel(provider.type)} for the "${provider.name}" provider in the Note Narrator settings.`;
}

/** Builds the synthesizer for a provider and one of its narrator's voice configuration. */
export function createTTSProvider(provider: ProviderEntry, voice: VoiceConfig, credentials: ProviderCredentials, onRateLimited?: () => void): TTSProvider {
	switch (provider.type) {
		case 'elevenlabs':
			if (voice.type !== 'elevenlabs') throw new Error("The narrator's voice configuration doesn't match its provider type.");
			if (credentials.type !== 'elevenlabs') throw new Error("The narrator's credentials don't match its provider type.");
			return new ElevenLabsProvider(credentials.apiKey, voice, onRateLimited);
	}
}

/** A human-readable name for the voice, e.g. to label a saved audio filename. Falls back to the raw voice ID. */
export async function resolveVoiceLabel(provider: ProviderEntry, voice: VoiceConfig, credentials: ProviderCredentials): Promise<string> {
	switch (provider.type) {
		case 'elevenlabs':
			if (voice.type !== 'elevenlabs') return 'voice';
			if (credentials.type !== 'elevenlabs') return 'voice';
			try {
				return await getElevenLabsVoiceName(credentials.apiKey, voice.voiceId);
			} catch (error) {
				console.error('Note Narrator: failed to resolve voice name for filename', error);
				return fallbackVoiceLabel(voice);
			}
	}
}

/** A label for the voice when its name can't be looked up (no credentials, or the lookup failed): its ID. */
export function fallbackVoiceLabel(voice: VoiceConfig): string {
	switch (voice.type) {
		case 'elevenlabs':
			return voice.voiceId;
	}
}

/** The audio format a provider type's `synthesize()` returns, for the saved file's extension and playback's MIME type. */
export function providerOutputFormat(type: ProviderType): AudioFormat {
	switch (type) {
		case 'elevenlabs':
			return 'mp3';
	}
}
