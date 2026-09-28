import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { AWSProvider } = await import('../../src/tts/aws-provider');

function jsonResponse(status: number, body: unknown): StubResponse {
	return { status, text: JSON.stringify(body), json: body, arrayBuffer: new ArrayBuffer(0) };
}

function audioResponse(bytes: number[]): StubResponse {
	return { status: 200, text: '', json: {}, arrayBuffer: new Uint8Array(bytes).buffer };
}

/**
 * Node's test environment has no `window` (unlike Obsidian's Electron/mobile-webview runtimes), and the
 * provider deliberately calls `window.setTimeout`/`clearTimeout` (an Obsidian lint rule,
 * `obsidianmd/prefer-window-timers`, requires this for popout window compatibility). The wrappers here
 * resolve the bare `setTimeout`/`clearTimeout` identifiers at *call* time, so `stubImmediateSetTimeout()`
 * below -- which stubs those bare globals, not a fixed copy of them -- still takes effect through `window`.
 */
function stubWindow(): void {
	vi.stubGlobal('window', {
		setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
	});
}

/**
 * Stubs `setTimeout` to fire immediately instead of scheduling, so backoff waits don't add real wall-clock
 * delay to the retry tests below. Vitest's `vi.useFakeTimers()` was tried first, but it deadlocks here: this
 * provider's `sleep()` calls interleave with `signAwsRequest()`'s multiple chained `crypto.subtle` calls
 * (Node's WebCrypto implementation resolves those off the main thread, independently of JS-level fake
 * timers), and advancing fake time never unblocks that combination. Stubbing `setTimeout` directly sidesteps
 * the interaction entirely -- it never touches `crypto.subtle` at all.
 */
function stubImmediateSetTimeout(): void {
	vi.stubGlobal('setTimeout', (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
		fn(...args);
		return 0 as unknown as ReturnType<typeof setTimeout>;
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
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: 'aws', voiceId: 'Joanna', engine: 'neural' });

		const result = await provider.synthesize('Hello world');

		expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
		expect(requestUrl).toHaveBeenCalledTimes(1);
		const call = requestUrl.mock.calls[0]![0];
		expect(call.method).toBe('POST');
		expect(call.url).toBe('https://polly.us-east-1.amazonaws.com/v1/speech');
		expect(JSON.parse(call.body)).toEqual({ Engine: 'neural', OutputFormat: 'mp3', Text: 'Hello world', VoiceId: 'Joanna' });
		expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
		expect(call.headers.host).toBe('polly.us-east-1.amazonaws.com');
	});

	it('uses a different region in the request URL and signature scope', async () => {
		requestUrl.mockResolvedValueOnce(audioResponse([9]));
		const provider = new AWSProvider('AKID', 'secret', 'eu-west-1', { type: 'aws', voiceId: 'Amy', engine: 'standard' });

		await provider.synthesize('Bonjour');

		const call = requestUrl.mock.calls[0]![0];
		expect(call.url).toBe('https://polly.eu-west-1.amazonaws.com/v1/speech');
		expect(call.headers.authorization).toContain('/eu-west-1/polly/aws4_request');
	});

	it('retries on a throttling error and eventually succeeds', async () => {
		stubImmediateSetTimeout();
		requestUrl
			.mockResolvedValueOnce(jsonResponse(400, { __type: 'ThrottlingException', message: 'Rate exceeded' }))
			.mockResolvedValueOnce(jsonResponse(400, { __type: 'ThrottlingException', message: 'Rate exceeded' }))
			.mockResolvedValueOnce(audioResponse([7, 8]));
		const onRateLimited = vi.fn();
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: 'aws', voiceId: 'Joanna', engine: 'neural' }, onRateLimited);

		const result = await provider.synthesize('Retry me');

		expect(new Uint8Array(result)).toEqual(new Uint8Array([7, 8]));
		expect(requestUrl).toHaveBeenCalledTimes(3);
		expect(onRateLimited).toHaveBeenCalledTimes(2);
	});

	it('gives up and throws after exhausting its retry budget on sustained throttling', async () => {
		stubImmediateSetTimeout();
		requestUrl.mockResolvedValue(jsonResponse(400, { __type: 'ThrottlingException', message: 'Rate exceeded' }));
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: 'aws', voiceId: 'Joanna', engine: 'neural' });

		await expect(provider.synthesize('Always throttled')).rejects.toThrow(/Amazon Polly request failed \(400\)/);
		// One initial attempt plus every retry (MAX_RATE_LIMIT_RETRIES = 6).
		expect(requestUrl).toHaveBeenCalledTimes(7);
	});

	it('does not retry a non-throttling error', async () => {
		requestUrl.mockResolvedValueOnce(jsonResponse(400, { __type: 'ValidationException', message: 'Invalid voice' }));
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: 'aws', voiceId: 'Joanna', engine: 'neural' });

		await expect(provider.synthesize('Bad request')).rejects.toThrow(/Amazon Polly request failed \(400\)/);
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it('checks isCancelled before each attempt and never calls requestUrl once cancelled', async () => {
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: 'aws', voiceId: 'Joanna', engine: 'neural' });

		await expect(provider.synthesize('Text', () => true)).rejects.toThrow('Generation was cancelled.');
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it('stops retrying once cancelled mid-backoff', async () => {
		requestUrl.mockResolvedValue(jsonResponse(400, { __type: 'ThrottlingException', message: 'Rate exceeded' }));
		let cancelled = false;
		// Cancels right after the setTimeout for the first attempt's backoff is scheduled, so the loop's
		// *next* isCancelled() check (before its second attempt) is the one that catches it.
		vi.stubGlobal('setTimeout', (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
			cancelled = true;
			fn(...args);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		});
		const provider = new AWSProvider('AKID', 'secret', 'us-east-1', { type: 'aws', voiceId: 'Joanna', engine: 'neural' });

		await expect(provider.synthesize('Text', () => cancelled)).rejects.toThrow('Generation was cancelled.');
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});
});
