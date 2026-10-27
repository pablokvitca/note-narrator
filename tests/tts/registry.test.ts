import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

// registry.ts pulls in elevenlabs-provider.ts, which imports `requestUrl` from 'obsidian' at module scope.
// The real 'obsidian' package ships types only (no runtime `main`), so it can't be resolved under vitest --
// stub just enough of it for that import to succeed; nothing here calls requestUrl.
vi.mock('obsidian', () => ({ requestUrl: vi.fn() }));

const { credentialsLabel, fallbackVoiceLabel, getProviderCredentials, missingCredentialsMessage, providerOutputFormat } = await import('../../src/tts/registry');
const { ProviderType, createProvider } = await import('../../src/settings/profiles');

/** A minimal fake of the one App surface getProviderCredentials() touches. */
function appWithSecret(id: string, secret: string | null): App {
	return {
		secretStorage: {
			getSecret: (secretId: string) => (secretId === id ? secret : null),
		},
	} as unknown as App;
}

describe('getProviderCredentials', () => {
	it('returns elevenlabs credentials when the secret is set', () => {
		const provider = createProvider(ProviderType.ElevenLabs, 'ElevenLabs');
		const app = appWithSecret(provider.apiKeySecretId, 'my-api-key');

		expect(getProviderCredentials(app, provider)).toEqual({ type: ProviderType.ElevenLabs, apiKey: 'my-api-key' });
	});

	it('returns null when no secret is stored', () => {
		const provider = createProvider(ProviderType.ElevenLabs, 'ElevenLabs');
		const app = appWithSecret(provider.apiKeySecretId, null);

		expect(getProviderCredentials(app, provider)).toBeNull();
	});

	it('returns null when the stored secret is empty', () => {
		const provider = createProvider(ProviderType.ElevenLabs, 'ElevenLabs');
		const app = appWithSecret(provider.apiKeySecretId, '');

		expect(getProviderCredentials(app, provider)).toBeNull();
	});
});

describe('providerOutputFormat', () => {
	it('is mp3 for elevenlabs', () => {
		expect(providerOutputFormat(ProviderType.ElevenLabs)).toBe('mp3');
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
