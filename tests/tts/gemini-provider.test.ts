import type { RequestUrlResponse } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderType, GeminiVoiceConfig } from '../../src/settings/profiles';
import { readWavFormat, wavPcmData, wrapPcmAsWav } from '../../src/engine/wav';

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
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

const { GeminiProvider, decodeGeminiAudio, geminiRequestedDelayMs } = await import('../../src/tts/gemini-provider');

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

interface CapturedBody {
	contents: { parts: { text: string }[] }[];
	generationConfig: { responseModalities: string[]; speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } };
}

function voice(overrides: Partial<GeminiVoiceConfig> = {}): GeminiVoiceConfig {
	return { type: ProviderType.Gemini, voiceName: 'Kore', modelId: 'gemini-2.5-flash-preview-tts', instructions: '', ...overrides };
}

function base64Of(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function audioResponse(bytes: number[], mimeType = 'audio/L16;codec=pcm;rate=24000') {
	return { status: 200, text: '', headers: {}, json: { candidates: [{ content: { parts: [{ inlineData: { data: base64Of(new Uint8Array(bytes)), mimeType } }] } }] } };
}

function errorResponse(status: number, text: string) {
	return { status, text, headers: {}, json: undefined };
}

function captured(index = 0): { request: CapturedRequest; body: CapturedBody } {
	const request = requestUrl.mock.calls[index]?.[0] as CapturedRequest;
	return { request, body: JSON.parse(request.body) as CapturedBody };
}

beforeEach(() => {
	requestUrl.mockReset();
	waits.length = 0;
});

describe('decodeGeminiAudio', () => {
	it('wraps PCM in a WAV header, at the rate the mimeType gives', () => {
		const wav = decodeGeminiAudio(base64Of(new Uint8Array([1, 2, 3, 4])), 'audio/L16;codec=pcm;rate=16000');
		expect(readWavFormat(wav)).toEqual({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
		expect([...new Uint8Array(wavPcmData(wav))]).toEqual([1, 2, 3, 4]);
	});

	it('assumes 24 kHz when the mimeType has no rate', () => {
		expect(readWavFormat(decodeGeminiAudio(base64Of(new Uint8Array([1, 2])), 'audio/L16'))?.sampleRate).toBe(24000);
	});

	it('keeps audio that is already a WAV file as it is', () => {
		const original = new Uint8Array(wrapPcmAsWav(new Uint8Array([9, 8]).buffer, { sampleRate: 44100, channels: 2, bitsPerSample: 16 }));
		expect(new Uint8Array(decodeGeminiAudio(base64Of(original), 'audio/wav'))).toEqual(original);
	});
});

describe('GeminiProvider.synthesize', () => {
	it('sends the documented request and returns WAV audio', async () => {
		requestUrl.mockResolvedValueOnce(audioResponse([1, 2, 3, 4]));

		const result = await new GeminiProvider('key', voice()).synthesize('Hello');

		const { request, body } = captured();
		expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent');
		expect(request.headers['x-goog-api-key']).toBe('key');
		expect(body.contents[0]?.parts[0]?.text).toBe('Hello');
		expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
		expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
		expect([...new Uint8Array(wavPcmData(result))]).toEqual([1, 2, 3, 4]);
	});

	it('puts the instructions before the text', async () => {
		requestUrl.mockResolvedValueOnce(audioResponse([0, 0]));
		await new GeminiProvider('key', voice({ instructions: ' Say cheerfully ' })).synthesize('Hello');
		expect(captured().body.contents[0]?.parts[0]?.text).toBe('Say cheerfully: Hello');
	});

	it('retries a rate-limited request, waiting as long as Gemini asks', async () => {
		const rateLimited = errorResponse(429, JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' }] } }));
		requestUrl.mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(audioResponse([0, 0]));
		const onRateLimited = vi.fn();

		await new GeminiProvider('key', voice(), onRateLimited).synthesize('Hello');

		expect(onRateLimited).toHaveBeenCalledTimes(1);
		expect(waits).toEqual([31000]);
	});

	it('fails with a short error for other failures, without retrying', async () => {
		requestUrl.mockResolvedValueOnce(errorResponse(400, 'API key not valid'));
		await expect(new GeminiProvider('key', voice()).synthesize('Hello')).rejects.toThrow('Google Gemini request failed (400): API key not valid');
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it('fails when the response has no audio, rather than returning silence', async () => {
		requestUrl.mockResolvedValueOnce({ status: 200, text: '', headers: {}, json: { candidates: [] } });
		await expect(new GeminiProvider('key', voice()).synthesize('Hello')).rejects.toThrow('no audio');
	});
});

describe('geminiRequestedDelayMs', () => {
	const response = (text: string) => errorResponse(429, text) as unknown as RequestUrlResponse;

	it('reads the RetryInfo delay', () => {
		expect(geminiRequestedDelayMs(response(JSON.stringify({ error: { details: [{}, { retryDelay: '2.5s' }] } })))).toBe(2500);
	});

	it('is null without one, or for a body that is not JSON', () => {
		expect(geminiRequestedDelayMs(response(JSON.stringify({ error: { details: [] } })))).toBeNull();
		expect(geminiRequestedDelayMs(response('Too many requests'))).toBeNull();
	});
});
