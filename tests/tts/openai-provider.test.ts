import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderType, OpenAIVoiceConfig } from '../../src/settings/profiles';

interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

const requestUrl = vi.fn<(request: CapturedRequest) => Promise<unknown>>();

vi.mock('obsidian', () => ({ requestUrl }));

/** How long each retry waited. There's no window under Node: the waits are recorded and skipped. */
const waits: number[] = [];
vi.stubGlobal('window', {
	setTimeout: (callback: () => void, ms: number) => {
		waits.push(ms);
		queueMicrotask(callback);
		return 0;
	},
});

// Imported after the mock so the provider picks up the mocked `requestUrl`.
const { OpenAIProvider, openAIRequestedDelayMs } = await import('../../src/tts/openai-provider');

function voiceConfig(overrides: Partial<OpenAIVoiceConfig> = {}): OpenAIVoiceConfig {
	return { type: ProviderType.OpenAI, voice: 'alloy', model: 'gpt-4o-mini-tts', speed: 1, instructions: '', ...overrides };
}

function okResponse(bytes: ArrayBuffer) {
	return { status: 200, headers: {}, arrayBuffer: bytes, json: undefined, text: '' };
}

function rateLimitedResponse(headers: Record<string, string> = {}) {
	return { status: 429, headers, arrayBuffer: new ArrayBuffer(0), json: undefined, text: 'Too many requests' };
}

function errorResponse(status: number, text = 'boom') {
	return { status, headers: {}, arrayBuffer: new ArrayBuffer(0), json: undefined, text };
}

beforeEach(() => {
	requestUrl.mockReset();
	waits.length = 0;
});

describe('OpenAIProvider.synthesize', () => {
	it('returns the audio bytes on a successful request', async () => {
		const audio = new ArrayBuffer(8);
		requestUrl.mockResolvedValueOnce(okResponse(audio));

		const provider = new OpenAIProvider('sk-test', voiceConfig());
		const result = await provider.synthesize('Hello world');

		expect(result).toBe(audio);
		expect(requestUrl).toHaveBeenCalledTimes(1);
		const call = requestUrl.mock.calls[0]![0];
		expect(call.url).toBe('https://api.openai.com/v1/audio/speech');
		expect(call.method).toBe('POST');
		expect(call.headers.Authorization).toBe('Bearer sk-test');
		const body: Record<string, unknown> = JSON.parse(call.body) as Record<string, unknown>;
		expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'Hello world', voice: 'alloy', response_format: 'mp3', speed: 1 });
		expect(body).not.toHaveProperty('instructions');
	});

	it('includes instructions in the request body when set', async () => {
		requestUrl.mockResolvedValueOnce(okResponse(new ArrayBuffer(1)));
		const provider = new OpenAIProvider('sk-test', voiceConfig({ instructions: 'Speak cheerfully.' }));
		await provider.synthesize('Hi');
		const body: Record<string, unknown> = JSON.parse(requestUrl.mock.calls[0]![0].body) as Record<string, unknown>;
		expect(body.instructions).toBe('Speak cheerfully.');
	});

	it('omits instructions when the model is not gpt-4o-mini-tts, even if set', async () => {
		requestUrl.mockResolvedValueOnce(okResponse(new ArrayBuffer(1)));
		const provider = new OpenAIProvider('sk-test', voiceConfig({ model: 'tts-1', instructions: 'Stale instructions from a previous model.' }));
		await provider.synthesize('Hi');
		const body: Record<string, unknown> = JSON.parse(requestUrl.mock.calls[0]![0].body) as Record<string, unknown>;
		expect(body).not.toHaveProperty('instructions');
	});

	it('throws with the status and body text on a non-429 error', async () => {
		requestUrl.mockResolvedValueOnce(errorResponse(401, 'Invalid API key'));
		const provider = new OpenAIProvider('sk-bad', voiceConfig());
		await expect(provider.synthesize('Hello')).rejects.toThrow(/401.*Invalid API key/);
	});

	it('retries on 429, telling the caller, and waits as long as OpenAI asks', async () => {
		const audio = new ArrayBuffer(4);
		requestUrl.mockResolvedValueOnce(rateLimitedResponse({ 'retry-after-ms': '50' })).mockResolvedValueOnce(okResponse(audio));
		const onRateLimited = vi.fn();

		const result = await new OpenAIProvider('sk-test', voiceConfig(), onRateLimited).synthesize('Retry me');

		expect(result).toBe(audio);
		expect(onRateLimited).toHaveBeenCalledTimes(1);
		expect(waits).toEqual([50]);
	});

	it('stops before making a request once cancelled', async () => {
		const provider = new OpenAIProvider('sk-test', voiceConfig());
		await expect(provider.synthesize('Hi', () => true)).rejects.toThrow(/cancelled/i);
		expect(requestUrl).not.toHaveBeenCalled();
	});
});

describe('openAIRequestedDelayMs', () => {
	const response = (headers: Record<string, string>) => rateLimitedResponse(headers);

	it('prefers retry-after-ms, then retry-after in seconds', () => {
		expect(openAIRequestedDelayMs(response({ 'retry-after-ms': '250', 'retry-after': '9' }))).toBe(250);
		expect(openAIRequestedDelayMs(response({ 'Retry-After': '2' }))).toBe(2000);
	});

	it('is null when OpenAI says nothing usable', () => {
		expect(openAIRequestedDelayMs(response({}))).toBeNull();
		expect(openAIRequestedDelayMs(response({ 'retry-after': 'soon' }))).toBeNull();
	});
});
