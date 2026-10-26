import type { RequestUrlResponse } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderType } from '../../src/settings/profiles';

/**
 * A request as `requestUrl` receives it -- just the fields this provider (and these tests) care about,
 * not Obsidian's whole `RequestUrlParam` shape.
 */
interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}

interface StubResponse {
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}

/*
 * The `obsidian` package ships types only (no runtime module -- see its package.json's empty `main`), so
 * `requestUrl` is mocked here rather than imported for real. This is the same approach the rest of the
 * engine/reader layer would need for any test that touches Obsidian's network client.
 */
const requestUrl = vi.fn<(request: CapturedRequest) => Promise<StubResponse>>();
vi.mock('obsidian', () => ({ requestUrl: (request: CapturedRequest) => requestUrl(request) }));

// Imported after the mock is registered so aws-provider.ts's `import { requestUrl } from 'obsidian'` binds to it.
const { AWSProvider, isThrottlingResponse } = await import('../../src/tts/aws-provider');

function jsonResponse(status: number, body: unknown): StubResponse {
	return { status, text: JSON.stringify(body), json: body, arrayBuffer: new ArrayBuffer(0) };
}

function audioResponse(bytes: number[]): StubResponse {
	return { status: 200, text: '', json: {}, arrayBuffer: new Uint8Array(bytes).buffer };
}

/** There's no window under Node: retry waits are skipped. */
function stubWindow(): void {
	vi.stubGlobal('window', {
		setTimeout: (callback: () => void) => {
			queueMicrotask(callback);
			return 0;
		},
	});
}

describe('AWSProvider.synthesize', () => {
	beforeEach(() => {
		requestUrl.mockReset();
		stubWindow();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('signs and sends the request, returning the audio bytes on success', async () => {
		requestUrl.mockResolvedValueOnce(audioResponse([1, 2, 3]));
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: ProviderType.AWS, voiceId: 'Joanna', engine: 'neural' });

		const result = await provider.synthesize('Hello world');

		expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
		expect(requestUrl).toHaveBeenCalledTimes(1);
		const call = requestUrl.mock.calls[0]![0];
		expect(call.method).toBe('POST');
		expect(call.url).toBe('https://polly.us-east-1.amazonaws.com/v1/speech');
		expect(JSON.parse(call.body)).toEqual({ Engine: 'neural', OutputFormat: 'mp3', Text: 'Hello world', VoiceId: 'Joanna' });
		expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
		// Signed, but left for the browser to set: Chromium refuses a request that sets Host.
		expect(call.headers.authorization).toMatch(/SignedHeaders=[^,]*host/);
		expect(call.headers).not.toHaveProperty('host');
	});

	it('uses a different region in the request URL and signature scope', async () => {
		requestUrl.mockResolvedValueOnce(audioResponse([9]));
		const provider = new AWSProvider('AKID', 'secret', 'eu-west-1', { type: ProviderType.AWS, voiceId: 'Amy', engine: 'standard' });

		await provider.synthesize('Bonjour');

		const call = requestUrl.mock.calls[0]![0];
		expect(call.url).toBe('https://polly.eu-west-1.amazonaws.com/v1/speech');
		expect(call.headers.authorization).toContain('/eu-west-1/polly/aws4_request');
	});

	it('retries on a throttling error and eventually succeeds', async () => {
		requestUrl
			.mockResolvedValueOnce(jsonResponse(400, { __type: 'ThrottlingException', message: 'Rate exceeded' }))
			.mockResolvedValueOnce(jsonResponse(400, { __type: 'ThrottlingException', message: 'Rate exceeded' }))
			.mockResolvedValueOnce(audioResponse([7, 8]));
		const onRateLimited = vi.fn();
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: ProviderType.AWS, voiceId: 'Joanna', engine: 'neural' }, onRateLimited);

		const result = await provider.synthesize('Retry me');

		expect(new Uint8Array(result)).toEqual(new Uint8Array([7, 8]));
		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(onRateLimited).toHaveBeenCalledTimes(2);
	});

	it('does not retry a non-throttling error', async () => {
		requestUrl.mockResolvedValueOnce(jsonResponse(400, { __type: 'ValidationException', message: 'Invalid voice' }));
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: ProviderType.AWS, voiceId: 'Joanna', engine: 'neural' });

		await expect(provider.synthesize('Bad request')).rejects.toThrow(/Amazon Polly request failed \(400\)/);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it('checks isCancelled before each attempt and never calls requestUrl once cancelled', async () => {
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: ProviderType.AWS, voiceId: 'Joanna', engine: 'neural' });

		await expect(provider.synthesize('Text', () => true)).rejects.toThrow('Generation was cancelled.');
		expect(requestUrl).not.toHaveBeenCalled();
	});
});

describe('isThrottlingResponse', () => {
	const response = (status: number, body: unknown) => jsonResponse(status, body) as unknown as RequestUrlResponse;

	it('counts a 429, and a 400 that says it is throttling', () => {
		expect(isThrottlingResponse(response(429, {}))).toBe(true);
		expect(isThrottlingResponse(response(400, { __type: 'ThrottlingException', message: 'Rate exceeded' }))).toBe(true);
	});

	it('leaves other failures alone', () => {
		expect(isThrottlingResponse(response(400, { __type: 'ValidationException', message: 'Invalid voice' }))).toBe(false);
		expect(isThrottlingResponse(response(403, { message: 'Rate exceeded' }))).toBe(false);
	});
});
