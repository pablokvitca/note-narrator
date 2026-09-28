import { ChunkerStyle, hashText } from '../text/text-utils';
import { AWS_CHAR_LIMIT, AWSEngine, DEFAULT_AWS_ENGINE, DEFAULT_AWS_REGION, DEFAULT_AWS_VOICE_ID } from '../tts/aws-models';
import { DEFAULT_ELEVENLABS_CHAR_LIMIT, ELEVENLABS_MODEL_CHAR_LIMITS } from '../tts/elevenlabs-models';
import { DEFAULT_GEMINI_CHAR_LIMIT, DEFAULT_GEMINI_MODEL_ID, DEFAULT_GEMINI_VOICE_NAME, GEMINI_MODEL_CHAR_LIMITS } from '../tts/gemini-models';
import { OPENAI_CHAR_LIMIT } from '../tts/openai-models';

/*
 * Providers and narrator profiles. Pure data + helpers (no Obsidian imports) so they can be unit tested.
 *
 * A *provider* is a named connection to a TTS backend: its type, its credentials, and how hard to hit it
 * (parallel generation is per provider, since rate limits belong to the account, not the voice). Several
 * providers can share a type (e.g. two ElevenLabs accounts). A *narrator profile* picks a provider, holds
 * that provider type's voice configuration, and may override the global reading settings.
 */

export type ProviderType = 'elevenlabs' | 'openai' | 'gemini' | 'aws';

export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
	elevenlabs: 'ElevenLabs',
	openai: 'OpenAI',
	gemini: 'Google Gemini',
	aws: 'Amazon Polly',
};

interface ProviderBase {
	id: string;
	name: string;
	/** Whether more than one chunk may generate at once for reads on this provider. */
	parallelGenerationEnabled: boolean;
	/** How many chunks may generate at once while a read on this provider is playing. */
	maxParallelGeneration: number;
	/** How many chunks may generate at once for a note continuing in the background on this provider. */
	maxBackgroundParallelGeneration: number;
}

export interface ElevenLabsProviderEntry extends ProviderBase {
	type: 'elevenlabs';
	/** Name of the secret in Obsidian's SecretStorage holding the ElevenLabs API key. */
	apiKeySecretId: string;
}

export interface OpenAIProviderEntry extends ProviderBase {
	type: 'openai';
	/** Name of the secret in Obsidian's SecretStorage holding the OpenAI API key. */
	apiKeySecretId: string;
}

export interface GeminiProviderEntry extends ProviderBase {
	type: 'gemini';
	/** Name of the secret in Obsidian's SecretStorage holding the Gemini API key. */
	apiKeySecretId: string;
}

/**
 * Amazon Polly needs three credential fields, not one bearer-token API key: an access key ID, a secret
 * access key, and a region (Polly's REST endpoint is regional, and which engines/voices are available can
 * vary by region). The access key ID and secret access key are both held in Obsidian's SecretStorage, like
 * ElevenLabs' single API key; the region isn't a secret, so it's stored directly here instead.
 */
export interface AWSProviderEntry extends ProviderBase {
	type: 'aws';
	/** Name of the secret in Obsidian's SecretStorage holding the AWS access key ID. */
	accessKeyIdSecretId: string;
	/** Name of the secret in Obsidian's SecretStorage holding the AWS secret access key. */
	secretAccessKeySecretId: string;
	region: string;
}

export type ProviderEntry = ElevenLabsProviderEntry | OpenAIProviderEntry | GeminiProviderEntry | AWSProviderEntry;

export interface ElevenLabsVoiceConfig {
	type: 'elevenlabs';
	voiceId: string;
	modelId: string;
	stability: number;
	similarityBoost: number;
}

export interface OpenAIVoiceConfig {
	type: 'openai';
	voice: string;
	model: string;
	/** Playback speed of the generated audio; OpenAI accepts 0.25-4.0, default 1.0. */
	speed: number;
	/** Optional natural-language guidance for tone/accent/pacing (gpt-4o-mini-tts only; ignored by tts-1/tts-1-hd). */
	instructions: string;
}

export interface GeminiVoiceConfig {
	type: 'gemini';
	/** One of Gemini's fixed prebuilt voice names (e.g. "Kore"), used verbatim as the request's `voiceName`. */
	voiceName: string;
	modelId: string;
	/** Optional natural-language style/tone instruction (Gemini has no numeric sliders like ElevenLabs' stability/similarity; style is steered by prepending an instruction to the text instead). */
	stylePrompt: string;
}

export interface AWSVoiceConfig {
	type: 'aws';
	voiceId: string;
	engine: AWSEngine;
}

/** A provider type's own voice configuration; the `type` always matches the owning provider's. */
export type VoiceConfig = ElevenLabsVoiceConfig | OpenAIVoiceConfig | GeminiVoiceConfig | AWSVoiceConfig;

/** The reading settings a narrator profile may override; the global values are the defaults. */
export interface ReadingConfig {
	readTitle: boolean;
	readProperties: boolean;
	stripMarkdownComments: boolean;
	stripCommentDelimiters: boolean;
	announceComments: boolean;
	chunkerStyle: ChunkerStyle;
	maxHeadingDepth: number;
	skipSectionHeadingPatterns: string;
}

export const READING_CONFIG_KEYS: (keyof ReadingConfig)[] = [
	'readTitle',
	'readProperties',
	'stripMarkdownComments',
	'stripCommentDelimiters',
	'announceComments',
	'chunkerStyle',
	'maxHeadingDepth',
	'skipSectionHeadingPatterns',
];

/** Only the keys a profile explicitly overrides are present; everything else inherits the global setting. */
export type ReadingOverrides = Partial<ReadingConfig>;

export interface NarratorProfile {
	id: string;
	name: string;
	providerId: string;
	/** Whether the profile is offered in the panel's narrator dropdown. */
	showInDropdown: boolean;
	voice: VoiceConfig;
	readingOverrides: ReadingOverrides;
}

/** The part of the plugin settings this module owns. */
export interface ProfileSettings {
	providers: ProviderEntry[];
	profiles: NarratorProfile[];
	/** The profile used for reads; also what the panel's dropdown selects. */
	activeProfileId: string;
}

/** Everything needed to run a read, resolved from a profile once so a job isn't affected by later edits. */
export interface ResolvedNarrator {
	profile: NarratorProfile;
	provider: ProviderEntry;
	voice: VoiceConfig;
	/** Hash of the voice-defining configuration; what saved audio records to detect a narrator change. */
	fingerprint: string;
}

export const DEFAULT_ELEVENLABS_API_KEY_SECRET_ID = 'elevenlabs-api-key';
export const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
export const DEFAULT_OPENAI_API_KEY_SECRET_ID = 'openai-api-key';
export const DEFAULT_OPENAI_VOICE = 'alloy';
export const DEFAULT_GEMINI_API_KEY_SECRET_ID = 'gemini-api-key';
export const DEFAULT_AWS_ACCESS_KEY_ID_SECRET_ID = 'aws-access-key-id';
export const DEFAULT_AWS_SECRET_ACCESS_KEY_SECRET_ID = 'aws-secret-access-key';

export function newId(prefix: string): string {
	const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
	return `${prefix}-${random}`;
}

export function createProvider(type: ProviderType, name: string): ProviderEntry {
	switch (type) {
		case 'elevenlabs':
			return {
				id: newId('provider'),
				name,
				type,
				apiKeySecretId: DEFAULT_ELEVENLABS_API_KEY_SECRET_ID,
				parallelGenerationEnabled: true,
				maxParallelGeneration: 2,
				maxBackgroundParallelGeneration: 1,
			};
		case 'openai':
			return {
				id: newId('provider'),
				name,
				type,
				apiKeySecretId: DEFAULT_OPENAI_API_KEY_SECRET_ID,
				parallelGenerationEnabled: true,
				maxParallelGeneration: 2,
				maxBackgroundParallelGeneration: 1,
			};
		case 'gemini':
			return {
				id: newId('provider'),
				name,
				type,
				apiKeySecretId: DEFAULT_GEMINI_API_KEY_SECRET_ID,
				parallelGenerationEnabled: true,
				maxParallelGeneration: 2,
				maxBackgroundParallelGeneration: 1,
			};
		case 'aws':
			return {
				id: newId('provider'),
				name,
				type,
				accessKeyIdSecretId: DEFAULT_AWS_ACCESS_KEY_ID_SECRET_ID,
				secretAccessKeySecretId: DEFAULT_AWS_SECRET_ACCESS_KEY_SECRET_ID,
				region: DEFAULT_AWS_REGION,
				parallelGenerationEnabled: true,
				maxParallelGeneration: 2,
				maxBackgroundParallelGeneration: 1,
			};
	}
}

export function defaultVoiceConfig(type: ProviderType): VoiceConfig {
	switch (type) {
		case 'elevenlabs':
			return { type, voiceId: DEFAULT_ELEVENLABS_VOICE_ID, modelId: 'eleven_multilingual_v2', stability: 0.5, similarityBoost: 0.75 };
		case 'openai':
			return { type, voice: DEFAULT_OPENAI_VOICE, model: 'gpt-4o-mini-tts', speed: 1, instructions: '' };
		case 'gemini':
			return { type, voiceName: DEFAULT_GEMINI_VOICE_NAME, modelId: DEFAULT_GEMINI_MODEL_ID, stylePrompt: '' };
		case 'aws':
			return { type, voiceId: DEFAULT_AWS_VOICE_ID, engine: DEFAULT_AWS_ENGINE };
	}
}

export function createProfile(provider: ProviderEntry, name: string): NarratorProfile {
	return {
		id: newId('profile'),
		name,
		providerId: provider.id,
		showInDropdown: true,
		voice: defaultVoiceConfig(provider.type),
		readingOverrides: {},
	};
}

/** Returns `base`, or `base 2`, `base 3`, ... — the first name not already in `taken`. */
export function uniqueName(base: string, taken: string[]): string {
	if (!taken.includes(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base} ${n}`;
		if (!taken.includes(candidate)) return candidate;
	}
}

export function getProvider(settings: ProfileSettings, providerId: string): ProviderEntry | undefined {
	return settings.providers.find((provider) => provider.id === providerId);
}

export function getActiveProfile(settings: ProfileSettings): NarratorProfile | undefined {
	return settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0];
}

/** Profiles offered in the panel dropdown: the ones toggled on, plus the active one even if toggled off so the dropdown can always show it. */
export function getDropdownProfiles(settings: ProfileSettings): NarratorProfile[] {
	const active = getActiveProfile(settings);
	return settings.profiles.filter((profile) => profile.showInDropdown || profile.id === active?.id);
}

/**
 * Hash of what makes a narrator *sound* different: provider type plus that type's voice configuration.
 * The profile's name, dropdown toggle, provider entry (which account) and reading overrides are left out --
 * renaming a profile or moving it to another account with the same voice must not look like a new narrator.
 */
export function voiceFingerprint(voice: VoiceConfig): string {
	switch (voice.type) {
		case 'elevenlabs':
			return hashText(JSON.stringify([voice.type, voice.voiceId, voice.modelId, voice.stability, voice.similarityBoost]));
		case 'openai':
			return hashText(JSON.stringify([voice.type, voice.voice, voice.model, voice.speed, voice.instructions]));
		case 'gemini':
			return hashText(JSON.stringify([voice.type, voice.voiceName, voice.modelId, voice.stylePrompt]));
		case 'aws':
			return hashText(JSON.stringify([voice.type, voice.voiceId, voice.engine]));
	}
}

/**
 * Whether a saved audio file's recorded narrator matches the profile now selected. Audio saved before
 * profiles existed recorded the raw ElevenLabs voice ID (the only provider that existed pre-profiles), so
 * that still counts as a match for the same voice.
 */
export function savedVoiceMatches(stored: string, voice: VoiceConfig): boolean {
	// The raw-voice-ID fallback predates provider types other than ElevenLabs, so it only applies to it.
	return stored === voiceFingerprint(voice) || (voice.type === 'elevenlabs' && stored === voice.voiceId);
}

export function resolveNarrator(settings: ProfileSettings, profile: NarratorProfile | undefined = getActiveProfile(settings)): ResolvedNarrator | null {
	if (!profile) return null;
	const provider = getProvider(settings, profile.providerId);
	if (!provider) return null;
	return { profile, provider, voice: profile.voice, fingerprint: voiceFingerprint(profile.voice) };
}

/** Global reading settings with a profile's overrides applied on top. */
export function resolveReadingConfig(global: ReadingConfig, overrides: ReadingOverrides | undefined): ReadingConfig {
	const resolved: ReadingConfig = { ...global };
	if (!overrides) return resolved;
	// Assigned per key so an explicitly-undefined override (e.g. from hand-edited data.json) can't blank a global value.
	for (const key of READING_CONFIG_KEYS) {
		const value = overrides[key];
		if (value !== undefined) (resolved as unknown as Record<string, unknown>)[key] = value;
	}
	return resolved;
}

export function providerCharLimit(voice: VoiceConfig | undefined): number {
	if (voice?.type === 'elevenlabs') return ELEVENLABS_MODEL_CHAR_LIMITS[voice.modelId] ?? DEFAULT_ELEVENLABS_CHAR_LIMIT;
	if (voice?.type === 'openai') return OPENAI_CHAR_LIMIT;
	if (voice?.type === 'gemini') return GEMINI_MODEL_CHAR_LIMITS[voice.modelId] ?? DEFAULT_GEMINI_CHAR_LIMIT;
	if (voice?.type === 'aws') return AWS_CHAR_LIMIT;
	return DEFAULT_ELEVENLABS_CHAR_LIMIT;
}

/** How many chunks may generate at once for a read (foreground) or a background job on `provider`. */
export function generationWindow(provider: ProviderEntry, background: boolean): number {
	if (background) return Math.max(1, provider.maxBackgroundParallelGeneration);
	return provider.parallelGenerationEnabled ? Math.max(1, provider.maxParallelGeneration) : 1;
}

const LEGACY_KEYS = [
	'apiKeySecretId',
	'voiceId',
	'modelId',
	'stability',
	'similarityBoost',
	'panelVoiceIds',
	'parallelGenerationEnabled',
	'maxParallelGeneration',
	'maxBackgroundParallelGeneration',
];

function pick<T>(value: unknown, fallback: T, valid: (v: unknown) => boolean): T {
	return valid(value) ? (value as T) : fallback;
}

/**
 * One-time upgrade of pre-profile settings (flat `voiceId`/`modelId`/`apiKeySecretId`/parallel settings) into
 * a provider plus a profile, so existing installs keep reading with exactly what they had. Also runs on a
 * fresh install (no saved data) to seed a usable default provider and profile. Idempotent: data that already
 * has `providers` is only normalised. Returns a new object; the input is not mutated.
 */
export function migrateProfileSettings(raw: Record<string, unknown>): Record<string, unknown> {
	const data: Record<string, unknown> = { ...raw };

	if (!Array.isArray(data.providers) || data.providers.length === 0) {
		const provider = createProvider('elevenlabs', 'ElevenLabs') as ElevenLabsProviderEntry;
		provider.apiKeySecretId = pick(data.apiKeySecretId, provider.apiKeySecretId, (v) => typeof v === 'string' && v.length > 0);
		provider.parallelGenerationEnabled = pick(data.parallelGenerationEnabled, provider.parallelGenerationEnabled, (v) => typeof v === 'boolean');
		provider.maxParallelGeneration = pick(data.maxParallelGeneration, provider.maxParallelGeneration, (v) => typeof v === 'number' && Number.isFinite(v));
		provider.maxBackgroundParallelGeneration = pick(
			data.maxBackgroundParallelGeneration,
			provider.maxBackgroundParallelGeneration,
			(v) => typeof v === 'number' && Number.isFinite(v),
		);

		const profile = createProfile(provider, 'Default');
		if (profile.voice.type === 'elevenlabs') {
			profile.voice.voiceId = pick(data.voiceId, profile.voice.voiceId, (v) => typeof v === 'string' && v.length > 0);
			profile.voice.modelId = pick(data.modelId, profile.voice.modelId, (v) => typeof v === 'string' && v.length > 0);
			profile.voice.stability = pick(data.stability, profile.voice.stability, (v) => typeof v === 'number');
			profile.voice.similarityBoost = pick(data.similarityBoost, profile.voice.similarityBoost, (v) => typeof v === 'number');
		}

		data.providers = [provider];
		data.profiles = [profile];
		data.activeProfileId = profile.id;
	}

	for (const key of LEGACY_KEYS) delete data[key];
	return data;
}

/** Repairs dangling references after edits or a hand-edited data.json: a profile pointing at a missing provider, or an active profile that no longer exists. Mutates `settings`. */
export function normalizeProfileSettings(settings: ProfileSettings): void {
	const fallbackProvider = settings.providers[0];
	if (fallbackProvider) {
		for (const profile of settings.profiles) {
			if (!getProvider(settings, profile.providerId)) profile.providerId = fallbackProvider.id;
		}
	}
	if (!settings.profiles.some((profile) => profile.id === settings.activeProfileId)) {
		settings.activeProfileId = settings.profiles[0]?.id ?? '';
	}
}
