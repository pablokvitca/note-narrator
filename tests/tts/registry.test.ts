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

describe('getProviderCredentials', () => {
	it('returns elevenlabs credentials when the secret is set', () => {
		const provider = createProvider('elevenlabs', 'ElevenLabs');
		const app = appWithSecret(provider.apiKeySecretId, 'my-api-key');

		expect(getProviderCredentials(app, provider)).toEqual({ type: 'elevenlabs', apiKey: 'my-api-key' });
	});

	it('returns null when no secret is stored', () => {
		const provider = createProvider('elevenlabs', 'ElevenLabs');
		const app = appWithSecret(provider.apiKeySecretId, null);

		expect(getProviderCredentials(app, provider)).toBeNull();
	});

	it('returns null when the stored secret is empty', () => {
		const provider = createProvider('elevenlabs', 'ElevenLabs');
		const app = appWithSecret(provider.apiKeySecretId, '');

		expect(getProviderCredentials(app, provider)).toBeNull();
	});
});

describe('providerOutputFormat', () => {
	it('is mp3 for elevenlabs', () => {
		expect(providerOutputFormat('elevenlabs')).toBe('mp3');
	});
});
