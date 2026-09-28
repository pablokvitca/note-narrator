import { requestUrl } from 'obsidian';
import type { OpenAIVoiceConfig } from '../settings/profiles';
import { AudioFormat, TTSProvider } from './provider';

/**
 * With a high "max parallel chunk generation" setting, many requests can be dispatched at once and hit
 * OpenAI's rate limit together -- they don't retry in lockstep (backoff is jittered below), but capacity
 * only frees up as the account's per-minute request/token budget refills. A modest retry budget with a
 * capped backoff gives that a chance to clear without a caller's worker pool (which fails the whole read
 * the moment any one parallel request throws) giving up too early.
 */
const MAX_RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_BASE_BACKOFF_MS = 1000;
const RATE_LIMIT_MAX_BACKOFF_MS = 20000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Case-insensitive header lookup: Obsidian's `requestUrl` doesn't normalize header casing for us. */
function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
	return key ? headers[key] : undefined;
}

/**
 * How long to wait before the next retry. OpenAI's rate-limit responses may include a `retry-after-ms`
 * (milliseconds) or `retry-after` (seconds) header telling the client exactly how long until it has
 * budget again; that's used when present, since it's more accurate than a blind backoff. Otherwise falls
 * back to jittered capped-exponential backoff, same pattern as the ElevenLabs provider.
 */
function backoffMs(headers: Record<string, string>, attempt: number): number {
	const retryAfterMs = Number(getHeader(headers, 'retry-after-ms'));
	if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;

	const retryAfterSeconds = Number(getHeader(headers, 'retry-after'));
	if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return retryAfterSeconds * 1000;

	const backoff = Math.min(RATE_LIMIT_BASE_BACKOFF_MS * 2 ** attempt, RATE_LIMIT_MAX_BACKOFF_MS);
	// +/-20% jitter so many requests rate-limited at the same moment (a high parallel-generation setting)
	// don't all retry in lockstep and collide again.
	return backoff * (0.8 + Math.random() * 0.4);
}

export class OpenAIProvider implements TTSProvider {
	readonly outputFormat: AudioFormat = 'mp3';

	constructor(
		private apiKey: string,
		private voice: OpenAIVoiceConfig,
		/** Called (possibly more than once) the moment a 429 is first seen, before any backoff wait. */
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer> {
		for (let attempt = 0; ; attempt++) {
			if (isCancelled?.()) throw new Error('Generation was cancelled.');
			const response = await requestUrl({
				url: 'https://api.openai.com/v1/audio/speech',
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: this.voice.model,
					input: text,
					voice: this.voice.voice,
					// Note Narrator saves/plays whatever bytes synthesize() returns as an `.mp3`-extensioned
					// file; mp3 is OpenAI's default response_format too, but it's set explicitly so that
					// stays true even if that default ever changes.
					response_format: 'mp3',
					speed: this.voice.speed,
					// Only gpt-4o-mini-tts supports style instructions; tts-1/tts-1-hd don't, so a stale
					// value left over from switching models away from gpt-4o-mini-tts (the settings UI
					// disables, but doesn't clear, that field) must not be sent to them.
					...(this.voice.model === 'gpt-4o-mini-tts' && this.voice.instructions ? { instructions: this.voice.instructions } : {}),
				}),
				throw: false,
			});

			if (response.status === 200) return response.arrayBuffer;

			if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
				this.onRateLimited?.();
				await sleep(backoffMs(response.headers, attempt));
				continue;
			}

			throw new Error(`OpenAI request failed (${response.status}): ${response.text}`);
		}
	}
}
