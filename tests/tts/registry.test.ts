import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ProviderType } from '../../src/settings/profiles';

// registry.ts pulls in elevenlabs-provider.ts, which imports `requestUrl` from 'obsidian' at module scope.
// The real 'obsidian' package ships types only (no runtime `main`), so it can't be resolved under vitest --
// stub just enough of it for that import to succeed; nothing here calls requestUrl.
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

const { credentialsLabel, fallbackVoiceLabel, getProviderCredentials, missingCredentialsMessage, providerOutputFormat } = await import('../../src/tts/registry');
const { createProvider } = await import('../../src/settings/profiles');

/** A minimal fake of the one App surface getProviderCredentials() touches. */
function appWithSecret(id: string, secret: string | null): App {
	return {
		secretStorage: {
			getSecret: (secretId: string) => (secretId === id ? secret : null),
		},
	} as unknown as App;
}

/** Runtime-asserts (and narrows) `createProvider(ProviderType.ElevenLabs, ...)`'s result to its ElevenLabs entry type. */
function asElevenLabsEntry(provider: { type: ProviderType; apiKeySecretId?: string }): { apiKeySecretId: string } {
	if (provider.type !== ProviderType.ElevenLabs || provider.apiKeySecretId === undefined) throw new Error('expected an ElevenLabs provider');
	return provider as { apiKeySecretId: string };
}

describe('getProviderCredentials', () => {
	it('returns elevenlabs credentials when the secret is set', () => {
		const provider = createProvider(ProviderType.ElevenLabs, 'ElevenLabs');
		const app = appWithSecret(asElevenLabsEntry(provider).apiKeySecretId, 'my-api-key');

		expect(getProviderCredentials(app, provider)).toEqual({ type: ProviderType.ElevenLabs, apiKey: 'my-api-key' });
	});

	it('returns null when no secret is stored', () => {
		const provider = createProvider(ProviderType.ElevenLabs, 'ElevenLabs');
		const app = appWithSecret(asElevenLabsEntry(provider).apiKeySecretId, null);

		expect(getProviderCredentials(app, provider)).toBeNull();
	});

	it('returns null when the stored secret is empty', () => {
		const provider = createProvider(ProviderType.ElevenLabs, 'ElevenLabs');
		const app = appWithSecret(asElevenLabsEntry(provider).apiKeySecretId, '');

		expect(getProviderCredentials(app, provider)).toBeNull();
	});

	it('returns aws credentials only once access key, secret key, and region are all set', () => {
		const provider = createProvider(ProviderType.AWS, 'Polly');
		if (provider.type !== ProviderType.AWS) throw new Error('expected an AWS provider');

		const app = {
			secretStorage: {
				getSecret: (id: string) => {
					if (id === provider.accessKeyIdSecretId) return 'access-key-id';
					if (id === provider.secretAccessKeySecretId) return 'secret-access-key';
					return null;
				},
			},
		} as unknown as App;

		expect(getProviderCredentials(app, provider)).toEqual({
			type: ProviderType.AWS,
			accessKeyId: 'access-key-id',
			secretAccessKey: 'secret-access-key',
			region: provider.region,
		});
	});

	it('returns null for aws when a secret is missing even if the region is set', () => {
		const provider = createProvider(ProviderType.AWS, 'Polly');
		if (provider.type !== ProviderType.AWS) throw new Error('expected an AWS provider');

		const app = {
			secretStorage: {
				getSecret: (id: string) => (id === provider.accessKeyIdSecretId ? 'access-key-id' : null),
			},
		} as unknown as App;

		expect(getProviderCredentials(app, provider)).toBeNull();
	});
});

describe('providerOutputFormat', () => {
	it('is mp3 for elevenlabs, openai, and aws, and wav for gemini', () => {
		expect(providerOutputFormat(ProviderType.ElevenLabs)).toBe('mp3');
		expect(providerOutputFormat(ProviderType.OpenAI)).toBe('mp3');
		expect(providerOutputFormat(ProviderType.Gemini)).toBe('wav');
		expect(providerOutputFormat(ProviderType.AWS)).toBe('mp3');
	});
});

describe('credential and voice labels', () => {
	it('names an ElevenLabs provider\'s missing API key', () => {
		const provider = createProvider(ProviderType.ElevenLabs, 'Work');
		expect(credentialsLabel(ProviderType.ElevenLabs)).toBe('API key');
		expect(missingCredentialsMessage(provider)).toBe('Set the API key for the "Work" provider in the Note Narrator settings.');
	});

	it('falls back to the voice ID', () => {
		expect(fallbackVoiceLabel({ type: ProviderType.ElevenLabs, voiceId: 'abc', modelId: 'm', stability: 0.5, similarityBoost: 0.75 })).toBe('abc');
	});
});
