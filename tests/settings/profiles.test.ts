import { describe, expect, it } from 'vitest';
import {
	createProfile,
	createProvider,
	defaultVoiceConfig,
	ElevenLabsVoiceConfig,
	GeminiVoiceConfig,
	generationWindow,
	getDropdownProfiles,
	migrateProfileSettings,
	normalizeProfileSettings,
	OpenAIVoiceConfig,
	ProfileSettings,
	providerCharLimit,
	resolveNarrator,
	resolveReadingConfig,
	savedVoiceMatches,
	uniqueName,
	voiceFingerprint,
} from '../../src/settings/profiles';

function settingsWith(profileCount: number): ProfileSettings {
	const provider = createProvider('elevenlabs', 'ElevenLabs');
	const profiles = Array.from({ length: profileCount }, (_, i) => createProfile(provider, `Profile ${i + 1}`));
	return { providers: [provider], profiles, activeProfileId: profiles[0]?.id ?? '' };
}

/** Runtime-asserts (and narrows) a voice config to ElevenLabs', for tests that need its ElevenLabs-only fields. */
function asElevenLabs(voice: { type: string }): ElevenLabsVoiceConfig {
	if (voice.type !== 'elevenlabs') throw new Error('Expected an ElevenLabs voice config.');
	return voice as ElevenLabsVoiceConfig;
}

/** Runtime-asserts (and narrows) a voice config to Gemini's, for tests that need its Gemini-only fields. */
function asGemini(voice: { type: string }): GeminiVoiceConfig {
	if (voice.type !== 'gemini') throw new Error('Expected a Gemini voice config.');
	return voice as GeminiVoiceConfig;
}

describe('migrateProfileSettings', () => {
	it('turns legacy flat settings into one provider and one profile', () => {
		const migrated = migrateProfileSettings({
			apiKeySecretId: 'my-key',
			voiceId: 'voice-1',
			modelId: 'eleven_flash_v2_5',
			stability: 0.2,
			similarityBoost: 0.9,
			maxParallelGeneration: 4,
			parallelGenerationEnabled: false,
			maxBackgroundParallelGeneration: 2,
			panelVoiceIds: ['a'],
			playbackRate: 1.5,
		});

		const providers = migrated.providers as ProfileSettings['providers'];
		const profiles = migrated.profiles as ProfileSettings['profiles'];
		expect(providers).toHaveLength(1);
		expect(providers[0]).toMatchObject({ type: 'elevenlabs', apiKeySecretId: 'my-key', maxParallelGeneration: 4, parallelGenerationEnabled: false, maxBackgroundParallelGeneration: 2 });
		expect(profiles).toHaveLength(1);
		expect(profiles[0]?.providerId).toBe(providers[0]?.id);
		expect(profiles[0]?.voice).toMatchObject({ voiceId: 'voice-1', modelId: 'eleven_flash_v2_5', stability: 0.2, similarityBoost: 0.9 });
		expect(migrated.activeProfileId).toBe(profiles[0]?.id);
		expect(migrated.playbackRate).toBe(1.5);
		for (const key of ['apiKeySecretId', 'voiceId', 'modelId', 'stability', 'similarityBoost', 'panelVoiceIds', 'maxParallelGeneration']) {
			expect(migrated).not.toHaveProperty(key);
		}
	});

	it('seeds defaults on a fresh install', () => {
		const migrated = migrateProfileSettings({});
		expect((migrated.providers as unknown[]).length).toBe(1);
		expect((migrated.profiles as unknown[]).length).toBe(1);
	});

	it('leaves already-migrated data alone', () => {
		const first = migrateProfileSettings({});
		const second = migrateProfileSettings(first);
		expect(second.providers).toEqual(first.providers);
		expect(second.profiles).toEqual(first.profiles);
		expect(second.activeProfileId).toBe(first.activeProfileId);
	});

	it('ignores invalid legacy values', () => {
		const migrated = migrateProfileSettings({ voiceId: 42, stability: 'high', maxParallelGeneration: NaN });
		const profile = (migrated.profiles as ProfileSettings['profiles'])[0];
		const provider = (migrated.providers as ProfileSettings['providers'])[0];
		const voice = asElevenLabs(profile!.voice);
		expect(voice.voiceId).toBe('21m00Tcm4TlvDq8ikWAM');
		expect(voice.stability).toBe(0.5);
		expect(provider?.maxParallelGeneration).toBe(2);
	});
});

describe('voiceFingerprint / savedVoiceMatches', () => {
	it('ignores the profile name and dropdown toggle but not voice settings', () => {
		const provider = createProvider('elevenlabs', 'A');
		const a = createProfile(provider, 'One');
		const b = { ...createProfile(provider, 'Two'), showInDropdown: false };
		expect(voiceFingerprint(a.voice)).toBe(voiceFingerprint(b.voice));

		const changedModel = { ...a.voice, modelId: 'eleven_v3' };
		expect(voiceFingerprint(changedModel)).not.toBe(voiceFingerprint(a.voice));
		const changedStability = { ...a.voice, stability: 0.9 };
		expect(voiceFingerprint(changedStability)).not.toBe(voiceFingerprint(a.voice));
	});

	it('treats a legacy raw voice ID as a match for that voice only', () => {
		const provider = createProvider('elevenlabs', 'A');
		const profile = createProfile(provider, 'One');
		expect(savedVoiceMatches(asElevenLabs(profile.voice).voiceId, profile.voice)).toBe(true);
		expect(savedVoiceMatches(voiceFingerprint(profile.voice), profile.voice)).toBe(true);
		expect(savedVoiceMatches('some-other-voice', profile.voice)).toBe(false);
	});
});

describe('Gemini provider type', () => {
	it('creates a Gemini provider and its default voice configuration', () => {
		const provider = createProvider('gemini', 'Gemini');
		expect(provider).toMatchObject({ type: 'gemini', parallelGenerationEnabled: true, maxParallelGeneration: 2, maxBackgroundParallelGeneration: 1 });
		if (provider.type !== 'gemini') throw new Error('expected a Gemini provider');
		expect(provider.apiKeySecretId).toBeTruthy();

		const voice = asGemini(defaultVoiceConfig('gemini'));
		expect(voice).toMatchObject({ type: 'gemini', voiceName: 'Kore', modelId: 'gemini-2.5-flash-preview-tts', stylePrompt: '' });
	});

	it('fingerprints Gemini voices by voice name, model, and style prompt (not the legacy ElevenLabs voiceId fallback)', () => {
		const provider = createProvider('gemini', 'A');
		const profile = createProfile(provider, 'One');
		const other = createProfile(provider, 'Two');
		expect(voiceFingerprint(profile.voice)).toBe(voiceFingerprint(other.voice));

		const changedVoice = { ...asGemini(profile.voice), voiceName: 'Puck' };
		expect(voiceFingerprint(changedVoice)).not.toBe(voiceFingerprint(profile.voice));
		const changedStyle = { ...asGemini(profile.voice), stylePrompt: 'Say cheerfully' };
		expect(voiceFingerprint(changedStyle)).not.toBe(voiceFingerprint(profile.voice));

		// Gemini never had a pre-profile era, so there's no legacy raw-id fallback to match against.
		expect(savedVoiceMatches('Kore', profile.voice)).toBe(false);
		expect(savedVoiceMatches(voiceFingerprint(profile.voice), profile.voice)).toBe(true);
	});

	it('looks up the Gemini model character limit, falling back for an unknown model', () => {
		const provider = createProvider('gemini', 'A');
		const profile = createProfile(provider, 'One');
		expect(providerCharLimit(profile.voice)).toBe(5000);
		expect(providerCharLimit({ ...asGemini(profile.voice), modelId: 'unknown' })).toBe(5000);
	});
});

describe('resolveReadingConfig', () => {
	const global = {
		readTitle: true,
		readProperties: false,
		stripMarkdownComments: true,
		stripCommentDelimiters: true,
		announceComments: true,
		chunkerStyle: 'markdown-aware' as const,
		maxHeadingDepth: 2,
		skipSectionHeadingPatterns: '',
	};

	it('applies only the overridden keys', () => {
		const resolved = resolveReadingConfig(global, { readProperties: true, maxHeadingDepth: 4 });
		expect(resolved).toEqual({ ...global, readProperties: true, maxHeadingDepth: 4 });
	});

	it('lets false override a true global', () => {
		expect(resolveReadingConfig(global, { readTitle: false }).readTitle).toBe(false);
	});

	it('ignores explicitly undefined overrides', () => {
		expect(resolveReadingConfig(global, { readTitle: undefined }).readTitle).toBe(true);
	});
});

describe('resolveNarrator / dropdown / normalize', () => {
	it('resolves the active profile with its provider', () => {
		const settings = settingsWith(2);
		const narrator = resolveNarrator(settings);
		expect(narrator?.profile.id).toBe(settings.profiles[0]?.id);
		expect(narrator?.provider.id).toBe(settings.providers[0]?.id);
	});

	it('returns null when the provider is missing', () => {
		const settings = settingsWith(1);
		settings.providers = [];
		expect(resolveNarrator(settings)).toBeNull();
	});

	it('always includes the active profile in the dropdown, even if hidden', () => {
		const settings = settingsWith(3);
		settings.profiles[0]!.showInDropdown = false;
		settings.profiles[1]!.showInDropdown = false;
		settings.activeProfileId = settings.profiles[0]!.id;
		expect(getDropdownProfiles(settings).map((p) => p.name)).toEqual(['Profile 1', 'Profile 3']);
	});

	it('repairs dangling provider and active profile references', () => {
		const settings = settingsWith(2);
		settings.profiles[1]!.providerId = 'gone';
		settings.activeProfileId = 'gone';
		normalizeProfileSettings(settings);
		expect(settings.profiles[1]!.providerId).toBe(settings.providers[0]!.id);
		expect(settings.activeProfileId).toBe(settings.profiles[0]!.id);
	});
});

describe('helpers', () => {
	it('generates unique names', () => {
		expect(uniqueName('ElevenLabs', [])).toBe('ElevenLabs');
		expect(uniqueName('ElevenLabs', ['ElevenLabs'])).toBe('ElevenLabs 2');
		expect(uniqueName('ElevenLabs', ['ElevenLabs', 'ElevenLabs 2'])).toBe('ElevenLabs 3');
	});

	it('computes the generation window per provider', () => {
		const provider = createProvider('elevenlabs', 'A');
		provider.maxParallelGeneration = 5;
		provider.maxBackgroundParallelGeneration = 2;
		expect(generationWindow(provider, false)).toBe(5);
		expect(generationWindow(provider, true)).toBe(2);
		provider.parallelGenerationEnabled = false;
		expect(generationWindow(provider, false)).toBe(1);
		expect(generationWindow(provider, true)).toBe(2);
	});

	it('looks up the model character limit', () => {
		const provider = createProvider('elevenlabs', 'A');
		const profile = createProfile(provider, 'One');
		const voice = profile.voice as ElevenLabsVoiceConfig;
		expect(providerCharLimit(voice)).toBe(10000);
		expect(providerCharLimit({ ...voice, modelId: 'eleven_flash_v2_5' })).toBe(40000);
		expect(providerCharLimit({ ...voice, modelId: 'unknown' })).toBe(5000);
	});

	it('uses the OpenAI character limit for an OpenAI voice', () => {
		expect(providerCharLimit(defaultVoiceConfig('openai'))).toBe(4096);
	});

	it('looks up the AWS character limit regardless of engine', () => {
		const provider = createProvider('aws', 'A');
		const profile = createProfile(provider, 'One');
		expect(providerCharLimit(profile.voice)).toBe(3000);
	});
});

describe('openai provider/voice defaults', () => {
	it('creates an OpenAI provider with sensible defaults', () => {
		const provider = createProvider('openai', 'OpenAI');
		expect(provider).toMatchObject({
			type: 'openai',
			name: 'OpenAI',
			parallelGenerationEnabled: true,
			maxParallelGeneration: 2,
			maxBackgroundParallelGeneration: 1,
		});
		expect(provider).toHaveProperty('apiKeySecretId');
	});

	it('creates a default OpenAI voice configuration', () => {
		const voice = defaultVoiceConfig('openai') as OpenAIVoiceConfig;
		expect(voice).toMatchObject({ type: 'openai', voice: 'alloy', model: 'gpt-4o-mini-tts', speed: 1, instructions: '' });
	});

	it('gives an OpenAI profile a fingerprint that changes with its voice settings', () => {
		const provider = createProvider('openai', 'OpenAI');
		const a = createProfile(provider, 'One');
		const b = createProfile(provider, 'Two');
		expect(voiceFingerprint(a.voice)).toBe(voiceFingerprint(b.voice));

		const changedVoice = { ...(a.voice as OpenAIVoiceConfig), voice: 'nova' };
		expect(voiceFingerprint(changedVoice)).not.toBe(voiceFingerprint(a.voice));
		const changedSpeed = { ...(a.voice as OpenAIVoiceConfig), speed: 1.5 };
		expect(voiceFingerprint(changedSpeed)).not.toBe(voiceFingerprint(a.voice));
	});

	it('does not match a stale ElevenLabs raw voice ID against an OpenAI voice', () => {
		const provider = createProvider('openai', 'OpenAI');
		const profile = createProfile(provider, 'One');
		expect(savedVoiceMatches('21m00Tcm4TlvDq8ikWAM', profile.voice)).toBe(false);
		expect(savedVoiceMatches(voiceFingerprint(profile.voice), profile.voice)).toBe(true);
	});
});

describe('AWS provider/voice defaults', () => {
	it('creates an AWS provider with two credential secrets and a region', () => {
		const provider = createProvider('aws', 'Polly');
		if (provider.type !== 'aws') throw new Error('expected an AWS provider');
		expect(provider.accessKeyIdSecretId).toBeTruthy();
		expect(provider.secretAccessKeySecretId).toBeTruthy();
		expect(provider.accessKeyIdSecretId).not.toBe(provider.secretAccessKeySecretId);
		expect(provider.region).toBeTruthy();
	});

	it('defaults to a voice/engine pair that actually supports that engine', () => {
		const voice = defaultVoiceConfig('aws');
		if (voice.type !== 'aws') throw new Error('expected an AWS voice config');
		expect(voice.voiceId).toBeTruthy();
		expect(voice.engine).toBeTruthy();
	});

	it('fingerprints an AWS voice by voice ID and engine, not by provider or profile identity', () => {
		const provider = createProvider('aws', 'A');
		const a = createProfile(provider, 'One');
		const b = createProfile(provider, 'Two');
		expect(voiceFingerprint(a.voice)).toBe(voiceFingerprint(b.voice));

		if (a.voice.type !== 'aws') throw new Error('expected an AWS voice');
		const changedEngine = { ...a.voice, engine: 'standard' as const };
		expect(voiceFingerprint(changedEngine)).not.toBe(voiceFingerprint(a.voice));
	});
});
