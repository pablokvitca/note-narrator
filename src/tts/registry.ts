import { App } from 'obsidian';
import { ProviderEntry, ProviderType, VoiceConfig } from '../settings/profiles';
import { ElevenLabsProvider, getElevenLabsVoiceName } from './elevenlabs-provider';
import { GeminiProvider } from './gemini-provider';
import { OPENAI_VOICES } from './openai-models';
import { OpenAIProvider } from './openai-provider';
import { AudioFormat, TTSProvider } from './provider';

/*
 * The one place that maps a provider *type* to its implementation. Adding a TTS backend means adding a
 * case to each function here (plus its entry/voice config types in profiles.ts and its settings UI).
 */

/**
 * A provider's credentials, shaped per provider type: most are a single API key, but a provider that signs its
 * requests needs several fields instead of one string. Each provider type adds its own member.
 */
export type ProviderCredentials = { type: ProviderType.ElevenLabs | ProviderType.OpenAI | ProviderType.Gemini; apiKey: string };

/** The provider's credentials from Obsidian's secret storage, or null when they aren't all set. */
export function getProviderCredentials(app: App, provider: ProviderEntry): ProviderCredentials | null {
	switch (provider.type) {
		case ProviderType.ElevenLabs: {
			const apiKey = app.secretStorage.getSecret(provider.apiKeySecretId);
			return apiKey ? { type: ProviderType.ElevenLabs, apiKey } : null;
		}
		case ProviderType.OpenAI: {
			const apiKey = app.secretStorage.getSecret(provider.apiKeySecretId);
			return apiKey ? { type: ProviderType.OpenAI, apiKey } : null;
		}
		case ProviderType.Gemini: {
			const apiKey = app.secretStorage.getSecret(provider.apiKeySecretId);
			return apiKey ? { type: ProviderType.Gemini, apiKey } : null;
		}
	}
}

/** What a provider type's credentials are called, as in "no API key set". */
export function credentialsLabel(type: ProviderType): string {
	switch (type) {
		case ProviderType.ElevenLabs:
		case ProviderType.OpenAI:
		case ProviderType.Gemini:
			return 'API key';
	}
}

export function missingCredentialsMessage(provider: ProviderEntry): string {
	return `Set the ${credentialsLabel(provider.type)} for the "${provider.name}" provider in the Note Narrator settings.`;
}

/** Builds the synthesizer for a provider and one of its narrator's voice configuration. */
export function createTTSProvider(provider: ProviderEntry, voice: VoiceConfig, credentials: ProviderCredentials, onRateLimited?: () => void): TTSProvider {
	switch (provider.type) {
		case ProviderType.ElevenLabs:
			if (voice.type !== ProviderType.ElevenLabs) throw new Error("The narrator's voice configuration doesn't match its provider type.");
			if (credentials.type !== ProviderType.ElevenLabs) throw new Error("The narrator's credentials don't match its provider type.");
			return new ElevenLabsProvider(credentials.apiKey, voice, onRateLimited);
		case ProviderType.OpenAI:
			if (voice.type !== ProviderType.OpenAI) throw new Error("The narrator's voice configuration doesn't match its provider type.");
			if (credentials.type !== ProviderType.OpenAI) throw new Error("The narrator's credentials don't match its provider type.");
			return new OpenAIProvider(credentials.apiKey, voice, onRateLimited);
		case ProviderType.Gemini:
			if (voice.type !== ProviderType.Gemini) throw new Error("The narrator's voice configuration doesn't match its provider type.");
			if (credentials.type !== ProviderType.Gemini) throw new Error("The narrator's credentials don't match its provider type.");
			return new GeminiProvider(credentials.apiKey, voice, onRateLimited);
	}
}

/** A human-readable name for the voice, e.g. to label a saved audio filename. Falls back to the raw voice ID. */
export async function resolveVoiceLabel(provider: ProviderEntry, voice: VoiceConfig, credentials: ProviderCredentials): Promise<string> {
	switch (provider.type) {
		case ProviderType.ElevenLabs:
			if (voice.type !== ProviderType.ElevenLabs) return 'voice';
			if (credentials.type !== ProviderType.ElevenLabs) return 'voice';
			try {
				return await getElevenLabsVoiceName(credentials.apiKey, voice.voiceId);
			} catch (error) {
				console.error('Note Narrator: failed to resolve voice name for filename', error);
				return fallbackVoiceLabel(voice);
			}
		case ProviderType.OpenAI:
			if (voice.type !== ProviderType.OpenAI) return 'voice';
			// A fixed list: nothing to look up.
			return OPENAI_VOICES[voice.voice] ?? voice.voice;
		case ProviderType.Gemini:
			// A fixed list, named by its IDs: nothing to look up.
			return fallbackVoiceLabel(voice);
	}
}

/** A label for the voice when its name can't be looked up (no credentials, or the lookup failed): its ID. */
export function fallbackVoiceLabel(voice: VoiceConfig): string {
	switch (voice.type) {
		case ProviderType.ElevenLabs:
			return voice.voiceId;
		case ProviderType.OpenAI:
			return voice.voice;
		case ProviderType.Gemini:
			return voice.voiceName;
	}
}

/** The audio format a provider type's `synthesize()` returns, for the saved file's extension and playback's MIME type. */
export function providerOutputFormat(type: ProviderType): AudioFormat {
	switch (type) {
		case ProviderType.ElevenLabs:
		case ProviderType.OpenAI:
			return AudioFormat.Mp3;
		case ProviderType.Gemini:
			return AudioFormat.Wav;
	}
}
