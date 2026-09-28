import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

// registry.ts pulls in elevenlabs-provider.ts, which imports `requestUrl` from 'obsidian' at module scope.
// The real 'obsidian' package ships types only (no runtime `main`), so it can't be resolved under vitest --
// stub just enough of it for that import to succeed; nothing here calls requestUrl.
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

const { getProviderCredentials, providerOutputFormat } = await import('../../src/tts/registry');
const { createProvider } = await import('../../src/settings/profiles');

/** A minimal fake of the one App surface getProviderCredentials() touches. */
function appWithSecret(id: string, secret: string | null): App {
	return {
		secretStorage: {
			getSecret: (secretId: string) => (secretId === id ? secret : null),
		},
	} as unknown as App;
}

/** Runtime-asserts (and narrows) `createProvider('elevenlabs', ...)`'s result to its ElevenLabs entry type. */
function asElevenLabsEntry(provider: { type: string; apiKeySecretId?: string }): { apiKeySecretId: string } {
	if (provider.type !== 'elevenlabs' || provider.apiKeySecretId === undefined) throw new Error('expected an ElevenLabs provider');
	return provider as { apiKeySecretId: string };
}

describe('getProviderCredentials', () => {
	it('returns elevenlabs credentials when the secret is set', () => {
		const provider = createProvider('elevenlabs', 'ElevenLabs');
		const app = appWithSecret(asElevenLabsEntry(provider).apiKeySecretId, 'my-api-key');

		expect(getProviderCredentials(app, provider)).toEqual({ type: 'elevenlabs', apiKey: 'my-api-key' });
	});

	it('returns null when no secret is stored', () => {
		const provider = createProvider('elevenlabs', 'ElevenLabs');
		const app = appWithSecret(asElevenLabsEntry(provider).apiKeySecretId, null);

		expect(getProviderCredentials(app, provider)).toBeNull();
	});

	it('returns null when the stored secret is empty', () => {
		const provider = createProvider('elevenlabs', 'ElevenLabs');
		const app = appWithSecret(asElevenLabsEntry(provider).apiKeySecretId, '');

		expect(getProviderCredentials(app, provider)).toBeNull();
	});

	it('returns aws credentials only once access key, secret key, and region are all set', () => {
		const provider = createProvider('aws', 'Polly');
		if (provider.type !== 'aws') throw new Error('expected an AWS provider');

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
			type: 'aws',
			accessKeyId: 'access-key-id',
			secretAccessKey: 'secret-access-key',
			region: provider.region,
		});
	});

	it('returns null for aws when a secret is missing even if the region is set', () => {
		const provider = createProvider('aws', 'Polly');
		if (provider.type !== 'aws') throw new Error('expected an AWS provider');

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
		expect(providerOutputFormat('elevenlabs')).toBe('mp3');
		expect(providerOutputFormat('openai')).toBe('mp3');
		expect(providerOutputFormat('gemini')).toBe('wav');
		expect(providerOutputFormat('aws')).toBe('mp3');
	});
});
