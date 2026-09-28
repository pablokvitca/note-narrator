import { App } from 'obsidian';
import type { ProviderEntry, ProviderType, VoiceConfig } from '../settings/profiles';
import { ElevenLabsProvider, getElevenLabsVoiceName } from './elevenlabs-provider';
import { GEMINI_VOICES } from './gemini-models';
import { GeminiProvider } from './gemini-provider';
import { OPENAI_VOICES } from './openai-models';
import { OpenAIProvider } from './openai-provider';
import { AudioFormat, TTSProvider } from './provider';

/*
 * The one place that maps a provider *type* to its implementation. Adding a TTS backend means adding a
 * case to each function here (plus its entry/voice config types in profiles.ts and its settings UI).
 */

/**
 * A provider's credentials, shaped per provider type -- most providers are a single API key, but some (e.g.
 * a request-signing backend) need several distinct fields instead of one opaque string. Only the `elevenlabs`
 * case is actually constructed while `ProviderEntry` itself only has that one variant; the others exist so
 * each provider's own branch can add its case without reshaping this type.
 */
export type ProviderCredentials =
	| { type: 'elevenlabs'; apiKey: string }
	| { type: 'openai'; apiKey: string }
	| { type: 'gemini'; apiKey: string }
	| { type: 'aws'; accessKeyId: string; secretAccessKey: string; region: string };

/** The provider's credentials from Obsidian's secret storage, or null when none are (fully) configured. */
export function getProviderCredentials(app: App, provider: ProviderEntry): ProviderCredentials | null {
	switch (provider.type) {
		case 'elevenlabs': {
			const apiKey = app.secretStorage.getSecret(provider.apiKeySecretId);
			return apiKey ? { type: 'elevenlabs', apiKey } : null;
		}
		case 'openai': {
			const apiKey = app.secretStorage.getSecret(provider.apiKeySecretId);
			return apiKey ? { type: 'openai', apiKey } : null;
		}
		case 'gemini': {
			const apiKey = app.secretStorage.getSecret(provider.apiKeySecretId);
			return apiKey ? { type: 'gemini', apiKey } : null;
		}
	}
}

export function missingApiKeyMessage(provider: ProviderEntry): string {
	return `Set an API key for the "${provider.name}" provider in the Note Narrator settings.`;
}

/** Builds the synthesizer for a provider and one of its narrator's voice configuration. */
export function createTTSProvider(provider: ProviderEntry, voice: VoiceConfig, credentials: ProviderCredentials, onRateLimited?: () => void): TTSProvider {
	switch (provider.type) {
		case 'elevenlabs':
			if (voice.type !== 'elevenlabs') throw new Error("The narrator's voice configuration doesn't match its provider type.");
			if (credentials.type !== 'elevenlabs') throw new Error("The narrator's credentials don't match its provider type.");
			return new ElevenLabsProvider(credentials.apiKey, voice, onRateLimited);
		case 'openai':
			if (voice.type !== 'openai') throw new Error("The narrator's voice configuration doesn't match its provider type.");
			if (credentials.type !== 'openai') throw new Error("The narrator's credentials don't match its provider type.");
			return new OpenAIProvider(credentials.apiKey, voice, onRateLimited);
		case 'gemini':
			if (voice.type !== 'gemini') throw new Error("The narrator's voice configuration doesn't match its provider type.");
			if (credentials.type !== 'gemini') throw new Error("The narrator's credentials don't match its provider type.");
			return new GeminiProvider(credentials.apiKey, voice, onRateLimited);
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
				return voice.voiceId;
			}
		case 'openai':
			// OpenAI's voices are a fixed, named list (no per-account lookup needed).
			if (voice.type !== 'openai') return 'voice';
			return OPENAI_VOICES[voice.voice] ?? voice.voice;
		case 'gemini':
			// Gemini's voices are a fixed, static set (not fetched per-account), so there's no network call needed.
			if (voice.type !== 'gemini') return 'voice';
			return GEMINI_VOICES[voice.voiceName] ?? voice.voiceName;
	}
}

/** The audio container format a provider type's `synthesize()` returns, e.g. to pick a save extension or a Blob MIME type. */
export function providerOutputFormat(type: ProviderType): AudioFormat {
	switch (type) {
		case 'elevenlabs':
			return 'mp3';
		case 'openai':
			return 'mp3';
		case 'gemini':
			return 'wav';
	}
}
