import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenAIVoiceConfig } from '../../src/settings/profiles';

interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

const requestUrl = vi.fn<(request: CapturedRequest) => Promise<unknown>>();

vi.mock('obsidian', () => ({ requestUrl }));

// The provider calls `window.setTimeout` (always present inside Obsidian's renderer); polyfill it for
// this Node test environment.
vi.stubGlobal('window', globalThis);

// Imported after the mock so the provider picks up the mocked `requestUrl`.
const { OpenAIProvider } = await import('../../src/tts/openai-provider');

function voiceConfig(overrides: Partial<OpenAIVoiceConfig> = {}): OpenAIVoiceConfig {
	return { type: 'openai', voice: 'alloy', model: 'gpt-4o-mini-tts', speed: 1, instructions: '', ...overrides };
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
	vi.useRealTimers();
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

	it('retries on 429 and eventually succeeds, calling onRateLimited', async () => {
		vi.useFakeTimers();
		const audio = new ArrayBuffer(4);
		requestUrl.mockResolvedValueOnce(rateLimitedResponse()).mockResolvedValueOnce(rateLimitedResponse()).mockResolvedValueOnce(okResponse(audio));
		const onRateLimited = vi.fn();

		const provider = new OpenAIProvider('sk-test', voiceConfig(), onRateLimited);
		const promise = provider.synthesize('Retry me');

		// Two 429s must be retried before the third call succeeds.
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(result).toBe(audio);
		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(onRateLimited).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it('honors a retry-after-ms header instead of falling back to backoff', async () => {
		vi.useFakeTimers();
		const audio = new ArrayBuffer(4);
		requestUrl.mockResolvedValueOnce(rateLimitedResponse({ 'retry-after-ms': '50' })).mockResolvedValueOnce(okResponse(audio));

		const provider = new OpenAIProvider('sk-test', voiceConfig());
		const promise = provider.synthesize('Hi');
		await vi.advanceTimersByTimeAsync(50);
		const result = await promise;

		expect(result).toBe(audio);
		expect(requestUrl).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it('gives up after exhausting its retry budget on repeated 429s', async () => {
		vi.useFakeTimers();
		requestUrl.mockResolvedValue(rateLimitedResponse());

		const provider = new OpenAIProvider('sk-test', voiceConfig());
		const promise = provider.synthesize('Hi');
		const assertion = expect(promise).rejects.toThrow(/429/);
		await vi.runAllTimersAsync();
		await assertion;
		vi.useRealTimers();
	});

	it('stops before making a request once cancelled', async () => {
		const provider = new OpenAIProvider('sk-test', voiceConfig());
		await expect(provider.synthesize('Hi', () => true)).rejects.toThrow(/cancelled/i);
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it('stops retrying once cancelled mid-backoff', async () => {
		vi.useFakeTimers();
		requestUrl.mockResolvedValue(rateLimitedResponse());
		let cancelled = false;

		const provider = new OpenAIProvider('sk-test', voiceConfig());
		const promise = provider.synthesize('Hi', () => cancelled);
		// Let the first attempt happen, then cancel before the retry's backoff finishes.
		await Promise.resolve();
		cancelled = true;
		const assertion = expect(promise).rejects.toThrow(/cancelled/i);
		await vi.runAllTimersAsync();
		await assertion;
		vi.useRealTimers();
	});
});
