import { requestUrl } from 'obsidian';
import type { AWSVoiceConfig } from '../settings/profiles';
import { signAwsRequest } from './aws-sigv4';
import { AudioFormat, TTSProvider } from './provider';

/**
 * With a high "max parallel chunk generation" setting, many requests can be dispatched at once and hit
 * Polly's per-second rate limit together (its documented `SynthesizeSpeech` quotas are as low as 8
 * requests/second for the neural/long-form/generative engines) -- they don't retry in lockstep (backoff is
 * jittered below), but capacity only frees up on AWS's side as the current one-second window rolls over.
 * Mirrors ElevenLabs' provider (see its own comment) with the same shape, tuned down since Polly's window
 * is much shorter-lived than ElevenLabs' concurrent-request congestion.
 */
const MAX_RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_BASE_BACKOFF_MS = 500;
const RATE_LIMIT_MAX_BACKOFF_MS = 15000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Whether a failed Polly response is a throttling error worth retrying. AWS's JSON-protocol services (Polly
 * included) signal throttling with a recognized error code (`ThrottlingException` and friends) rather than a
 * single dedicated HTTP status -- Polly itself has been observed returning throttling as HTTP 400, but AWS's
 * general guidance classifies throttling by error code first and 429/5xx status only as a fallback. See
 * https://docs.aws.amazon.com/general/latest/gr/api-retries.html (verified 2026-09-28).
 */
function isThrottlingResponse(status: number, bodyText: string): boolean {
	if (status === 429) return true;
	if (status !== 400) return false;
	return /throttl|too\s*many\s*requests|rate\s*exceeded|slow\s*down/i.test(bodyText);
}

export class AWSProvider implements TTSProvider {
	readonly outputFormat: AudioFormat = 'mp3';

	constructor(
		private accessKeyId: string,
		private secretAccessKey: string,
		private region: string,
		private voice: AWSVoiceConfig,
		/** Called (possibly more than once) the moment a throttling response is first seen, before any backoff wait. */
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer> {
		const url = `https://polly.${this.region}.amazonaws.com/v1/speech`;
		const body = JSON.stringify({
			Engine: this.voice.engine,
			OutputFormat: 'mp3',
			Text: text,
			VoiceId: this.voice.voiceId,
		});

		for (let attempt = 0; ; attempt++) {
			if (isCancelled?.()) throw new Error('Generation was cancelled.');

			const headers = await signAwsRequest({
				method: 'POST',
				url,
				region: this.region,
				service: 'polly',
				credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
				headers: { 'content-type': 'application/json' },
				body,
			});

			const response = await requestUrl({ url, method: 'POST', headers, body, throw: false });

			if (response.status === 200) return response.arrayBuffer;

			if (isThrottlingResponse(response.status, response.text) && attempt < MAX_RATE_LIMIT_RETRIES) {
				this.onRateLimited?.();
				const backoff = Math.min(RATE_LIMIT_BASE_BACKOFF_MS * 2 ** attempt, RATE_LIMIT_MAX_BACKOFF_MS);
				// +/-20% jitter so many requests throttled at the same moment (a high parallel-generation
				// setting) don't all retry in lockstep and collide again.
				await sleep(backoff * (0.8 + Math.random() * 0.4));
				continue;
			}

			throw new Error(`Amazon Polly request failed (${response.status}): ${response.text}`);
		}
	}
}
