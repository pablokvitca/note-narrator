import type { RequestUrlResponse } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHeader, requestFailedError, requestWithRetry } from '../../src/tts/request';

describe('requestFailedError', () => {
	it('includes the status and a short body as is', () => {
		expect(requestFailedError('ElevenLabs', 401, ' {"detail":"invalid_api_key"} ').message).toBe('ElevenLabs request failed (401): {"detail":"invalid_api_key"}');
	});

	it('cuts a long body to its first 200 characters', () => {
		const message = requestFailedError('ElevenLabs', 500, 'x'.repeat(5000)).message;
		expect(message).toBe(`ElevenLabs request failed (500): ${'x'.repeat(200)}…`);
	});

	it('cuts only bodies longer than 200 characters', () => {
		expect(requestFailedError('ElevenLabs', 500, 'x'.repeat(200)).message).toBe(`ElevenLabs request failed (500): ${'x'.repeat(200)}`);
		expect(requestFailedError('ElevenLabs', 500, 'x'.repeat(201)).message).toBe(`ElevenLabs request failed (500): ${'x'.repeat(200)}…`);
	});

	it('leaves out an empty body', () => {
		expect(requestFailedError('ElevenLabs', 502, '  ').message).toBe('ElevenLabs request failed (502)');
	});
});

describe('requestWithRetry', () => {
	const response = (status: number, headers: Record<string, string> = {}) => ({ status, headers, text: `status ${status}` }) as unknown as RequestUrlResponse;
	const POLICY = { maxRetries: 2, baseBackoffMs: 1000, maxBackoffMs: 30000 };
	/** How long each retry waited. */
	let waits: number[];

	beforeEach(() => {
		waits = [];
		// There's no window under Node. The waits are recorded and skipped.
		vi.stubGlobal('window', {
			setTimeout: (callback: () => void, ms: number) => {
				waits.push(ms);
				queueMicrotask(callback);
				return 0;
			},
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('retries a rate-limited request with a jittered, growing backoff, telling the caller, until it succeeds', async () => {
		const send = vi.fn().mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response(200));
		const onRateLimited = vi.fn();
		expect((await requestWithRetry('Service', send, POLICY, { onRateLimited })).status).toBe(200);
		expect(send).toHaveBeenCalledTimes(3);
		expect(onRateLimited).toHaveBeenCalledTimes(2);
		expect(waits[0]).toBeGreaterThanOrEqual(800);
		expect(waits[0]).toBeLessThanOrEqual(1200);
		expect(waits[1]).toBeGreaterThanOrEqual(1600);
		expect(waits[1]).toBeLessThanOrEqual(2400);
	});

	it('gives up after its retries, with the last response as the error', async () => {
		const send = vi.fn().mockResolvedValue(response(429));
		await expect(requestWithRetry('Service', send, POLICY)).rejects.toThrow('Service request failed (429): status 429');
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("doesn't retry other failures", async () => {
		const send = vi.fn().mockResolvedValue(response(401));
		await expect(requestWithRetry('Service', send, POLICY)).rejects.toThrow('Service request failed (401)');
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('waits as long as the service asks, when it says', async () => {
		const send = vi.fn().mockResolvedValueOnce(response(429, { 'Retry-After': '5' })).mockResolvedValueOnce(response(200));
		await requestWithRetry('Service', send, { ...POLICY, requestedDelayMs: (r) => Number(getHeader(r, 'retry-after')) * 1000 });
		expect(waits).toEqual([5000]);
	});

	it('uses its own test for a rate limit when it has one', async () => {
		const send = vi.fn().mockResolvedValueOnce(response(400)).mockResolvedValueOnce(response(200));
		expect((await requestWithRetry('Service', send, { ...POLICY, isRateLimited: (r) => r.status === 400 })).status).toBe(200);
	});

	it('stops once the caller gives up', async () => {
		const send = vi.fn().mockResolvedValue(response(429));
		let cancelled = false;
		await expect(requestWithRetry('Service', send, POLICY, { isCancelled: () => cancelled, onRateLimited: () => (cancelled = true) })).rejects.toThrow('cancelled');
		expect(send).toHaveBeenCalledTimes(1);
	});
});
