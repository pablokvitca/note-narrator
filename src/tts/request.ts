import { RequestUrlResponse } from 'obsidian';

/*
 * What every provider's requests share: the error for a failed request, and retrying a rate-limited one.
 */

/** How much of an error response's body goes into the error message (and so into notices and the console). */
const MAX_ERROR_BODY_CHARS = 200;

/** The error for a failed request to `service`: its status plus the start of its body, so an unexpectedly large or odd response can't flood a notice or the console. */
export function requestFailedError(service: string, status: number, body: string): Error {
	const trimmed = body.trim();
	const shown = trimmed.length > MAX_ERROR_BODY_CHARS ? `${trimmed.slice(0, MAX_ERROR_BODY_CHARS)}…` : trimmed;
	return new Error(shown ? `${service} request failed (${status}): ${shown}` : `${service} request failed (${status})`);
}

/** How a provider retries a rate-limited request. */
export interface RetryPolicy {
	maxRetries: number;
	baseBackoffMs: number;
	maxBackoffMs: number;
	/** Whether a failed response means "rate-limited, try again later". Default: a 429. */
	isRateLimited?: (response: RequestUrlResponse) => boolean;
	/** The wait the service asked for, if its response says (for example a `retry-after` header). */
	requestedDelayMs?: (response: RequestUrlResponse) => number | null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** A header's value, whatever the case of its name: `requestUrl` doesn't normalize it. */
export function getHeader(response: RequestUrlResponse, name: string): string | undefined {
	const key = Object.keys(response.headers).find((k) => k.toLowerCase() === name.toLowerCase());
	return key ? response.headers[key] : undefined;
}

/**
 * Sends a request until it succeeds (a 200), retrying while it's rate-limited, and throws
 * {@link requestFailedError} once it fails otherwise or runs out of retries.
 *
 * The backoff is capped-exponential with +/-20% jitter, so many requests rate-limited at the same moment (a
 * high parallel-generation setting) don't all retry in lockstep and collide again. `onRateLimited` is called
 * (possibly more than once) the moment a rate limit is seen, before the wait. `isCancelled` stops retrying once
 * the caller gave up (for example the plugin unloaded).
 */
export async function requestWithRetry(
	service: string,
	send: () => Promise<RequestUrlResponse>,
	policy: RetryPolicy,
	options: { isCancelled?: () => boolean; onRateLimited?: () => void } = {},
): Promise<RequestUrlResponse> {
	const isRateLimited = policy.isRateLimited ?? ((response: RequestUrlResponse) => response.status === 429);
	for (let attempt = 0; ; attempt++) {
		if (options.isCancelled?.()) throw new Error('Generation was cancelled.');
		const response = await send();
		if (response.status === 200) return response;

		if (attempt < policy.maxRetries && isRateLimited(response)) {
			options.onRateLimited?.();
			// A wait the service asks for is capped too, so an unusually long one can't hold a timer (and
			// this read) long after the plugin is disabled.
			const requested = policy.requestedDelayMs?.(response);
			const backoff = Math.min(policy.baseBackoffMs * 2 ** attempt, policy.maxBackoffMs);
			await sleep(requested != null ? Math.min(requested, policy.maxBackoffMs) : backoff * (0.8 + Math.random() * 0.4));
			continue;
		}

		throw requestFailedError(service, response.status, response.text);
	}
}
