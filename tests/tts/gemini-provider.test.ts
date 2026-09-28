import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeminiVoiceConfig } from '../../src/settings/profiles';

// `vi.mock` factories are hoisted above imports, so the mock fn itself must be created via `vi.hoisted`.
const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock('obsidian', () => ({ requestUrl }));

import { decodeGeminiAudio, GeminiProvider } from '../../src/tts/gemini-provider';

/** The shape of the single argument GeminiProvider passes to (mocked) `requestUrl`. */
interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

/** The JSON body GeminiProvider sends, once parsed back out of a captured request. */
interface CapturedRequestBody {
	contents: { parts: { text: string }[] }[];
	generationConfig: {
		responseModalities: string[];
		speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
	};
}

function voice(overrides: Partial<GeminiVoiceConfig> = {}): GeminiVoiceConfig {
	return { type: 'gemini', voiceName: 'Kore', modelId: 'gemini-2.5-flash-preview-tts', stylePrompt: '', ...overrides };
}

/** Mirrors GeminiProvider's own `atob`-based decoding, so tests don't depend on any Node-only APIs. */
function base64Of(bytes: number[]): string {
	return btoa(String.fromCharCode(...bytes));
}

function capturedRequest(callIndex = 0): CapturedRequest {
	return requestUrl.mock.calls[callIndex]?.[0] as CapturedRequest;
}

function capturedBody(callIndex = 0): CapturedRequestBody {
	return JSON.parse(capturedRequest(callIndex).body) as CapturedRequestBody;
}

function jsonResponse(status: number, base64Data: string, mimeType: string) {
	return {
		status,
		text: '',
		json: { candidates: [{ content: { parts: [{ inlineData: { data: base64Data, mimeType } }] } }] },
	};
}

beforeEach(() => {
	requestUrl.mockReset();
	// GeminiProvider's backoff sleep uses `window.setTimeout` (matching ElevenLabsProvider's pattern), but
	// vitest's default "node" test environment has no `window`. Aliasing it to `globalThis` lets
	// `vi.useFakeTimers()` (which patches the real global's timer functions) control it in the retry tests
	// below. (The `no-global-this` lint rule below is about app code preferring Obsidian's `window`/
	// `activeWindow` for popout-window compatibility; it doesn't apply to this test-only environment shim,
	// but isn't disableable, so it's left as the one intentional warning here.)
	vi.stubGlobal('window', globalThis);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('decodeGeminiAudio', () => {
	it('returns the bytes unchanged when they already carry a RIFF/WAV header', () => {
		const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 1, 2, 3];
		const result = decodeGeminiAudio(base64Of(riff), 'audio/wav');
		expect(Array.from(new Uint8Array(result))).toEqual(riff);
	});

	it('wraps headerless PCM bytes in a WAV container, honoring the mimeType sample rate', () => {
		const pcm = [1, 2, 3, 4, 5, 6];
		const result = decodeGeminiAudio(base64Of(pcm), 'audio/L16;codec=pcm;rate=16000');
		const view = new DataView(result);

		expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
		expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE');
		expect(view.getUint16(20, true)).toBe(1); // PCM format
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(16000); // sample rate from the mimeType
		expect(view.getUint16(34, true)).toBe(16); // 16-bit samples
		expect(view.getUint32(40, true)).toBe(pcm.length); // data chunk size
		expect(Array.from(new Uint8Array(result, 44))).toEqual(pcm);
		expect(result.byteLength).toBe(44 + pcm.length);
	});

	it('defaults to 24kHz when the mimeType has no rate hint', () => {
		const result = decodeGeminiAudio(base64Of([9, 9]), undefined);
		expect(new DataView(result).getUint32(24, true)).toBe(24000);
	});
});

describe('GeminiProvider.synthesize', () => {
	it('sends the documented request shape and decodes a successful response', async () => {
		const pcm = [10, 20, 30, 40];
		requestUrl.mockResolvedValueOnce(jsonResponse(200, base64Of(pcm), 'audio/L16;rate=24000'));

		const provider = new GeminiProvider('api-key', voice({ stylePrompt: 'Say cheerfully' }));
		const result = await provider.synthesize('Hello there');

		expect(requestUrl).toHaveBeenCalledTimes(1);
		const call = capturedRequest();
		expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent');
		expect(call.method).toBe('POST');
		expect(call.headers['x-goog-api-key']).toBe('api-key');

		const body = capturedBody();
		// The style prompt is prepended to the transcript (Gemini has no numeric sliders to carry it instead).
		expect(body.contents[0]?.parts[0]?.text).toBe('Say cheerfully: Hello there');
		expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
		expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');

		expect(Array.from(new Uint8Array(result, 44))).toEqual(pcm);
	});

	it('omits the style prefix when no style prompt is set', async () => {
		requestUrl.mockResolvedValueOnce(jsonResponse(200, base64Of([1]), 'audio/L16;rate=24000'));
		await new GeminiProvider('api-key', voice()).synthesize('Plain text');
		expect(capturedBody().contents[0]?.parts[0]?.text).toBe('Plain text');
	});

	it('retries on 429 with backoff, notifying the rate-limit callback, and eventually succeeds', async () => {
		vi.useFakeTimers();
		const onRateLimited = vi.fn();
		requestUrl
			.mockResolvedValueOnce({ status: 429, text: 'rate limited', json: {} })
			.mockResolvedValueOnce({ status: 429, text: 'rate limited', json: {} })
			.mockResolvedValueOnce(jsonResponse(200, base64Of([1, 2]), 'audio/L16;rate=24000'));

		const provider = new GeminiProvider('api-key', voice(), onRateLimited);
		const promise = provider.synthesize('hi');
		await vi.runAllTimersAsync();
		const result = await promise;

		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(onRateLimited).toHaveBeenCalledTimes(2);
		expect(result.byteLength).toBeGreaterThan(0);
	});

	it('throws once retries are exhausted against a persistent 429', async () => {
		vi.useFakeTimers();
		requestUrl.mockResolvedValue({ status: 429, text: 'still rate limited', json: {} });

		const provider = new GeminiProvider('api-key', voice());
		const outcome = provider.synthesize('hi').then(
			() => 'resolved',
			(error: unknown) => error,
		);
		await vi.runAllTimersAsync();
		const result = await outcome;

		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toMatch(/Gemini request failed \(429\)/);
		// MAX_RATE_LIMIT_RETRIES (6) retries after the first attempt = 7 requests total.
		expect(requestUrl).toHaveBeenCalledTimes(7);
	});

	it('throws a descriptive error for a non-429 failure without retrying', async () => {
		requestUrl.mockResolvedValueOnce({ status: 400, text: 'invalid voice', json: {} });
		const provider = new GeminiProvider('api-key', voice());
		await expect(provider.synthesize('hi')).rejects.toThrow(/Gemini request failed \(400\): invalid voice/);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it('throws when the 200 response has no audio data, instead of returning empty audio', async () => {
		requestUrl.mockResolvedValueOnce({ status: 200, text: '', json: { candidates: [{ content: { parts: [{}] } }] } });
		const provider = new GeminiProvider('api-key', voice());
		await expect(provider.synthesize('hi')).rejects.toThrow('Gemini response did not include audio data.');
	});

	it('checks cancellation before ever calling requestUrl', async () => {
		const provider = new GeminiProvider('api-key', voice());
		await expect(provider.synthesize('hi', () => true)).rejects.toThrow('Generation was cancelled.');
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it('stops retrying once cancelled mid-backoff, instead of waiting out the full retry budget', async () => {
		vi.useFakeTimers();
		let cancelled = false;
		requestUrl.mockResolvedValue({ status: 429, text: 'rate limited', json: {} });

		const provider = new GeminiProvider('api-key', voice());
		const outcome = provider.synthesize('hi', () => cancelled).then(
			() => 'resolved',
			(error: unknown) => error,
		);
		cancelled = true;
		await vi.runAllTimersAsync();
		const result = await outcome;

		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe('Generation was cancelled.');
		// Cancellation is checked at the top of the next attempt, so only the one in-flight request went out.
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});
});
