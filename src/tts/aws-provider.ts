import { RequestUrlResponse, requestUrl } from 'obsidian';
import type { AWSVoiceConfig } from '../settings/profiles';
import { signAwsRequest } from './aws-sigv4';
import { AudioFormat, TTSProvider } from './provider';
import { RetryPolicy, requestWithRetry } from './request';

/**
 * Polly's documented SynthesizeSpeech quotas are as low as 8 requests a second for the neural, long-form and
 * generative engines, and they reset every second, so the backoff starts and stays shorter than ElevenLabs'.
 */
const RETRY_POLICY: RetryPolicy = { maxRetries: 6, baseBackoffMs: 500, maxBackoffMs: 15000, isRateLimited: isThrottlingResponse };

/**
 * Whether a failed Polly response is throttling, worth retrying. AWS's JSON services report throttling by error
 * code (`ThrottlingException` and the like) more than by a dedicated status, and Polly has been seen sending it
 * as a 400. See https://docs.aws.amazon.com/general/latest/gr/api-retries.html (2026-09-28).
 */
export function isThrottlingResponse(response: RequestUrlResponse): boolean {
	if (response.status === 429) return true;
	if (response.status !== 400) return false;
	return /throttl|too\s*many\s*requests|rate\s*exceeded|slow\s*down/i.test(response.text);
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
		const body = JSON.stringify({ Engine: this.voice.engine, OutputFormat: 'mp3', Text: text, VoiceId: this.voice.voiceId });
		const response = await requestWithRetry(
			'Amazon Polly',
			async () => {
				// Signed again for every attempt: a signature carries the time it was made.
				const headers = await signAwsRequest({
					method: 'POST',
					url,
					region: this.region,
					service: 'polly',
					credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
					headers: { 'content-type': 'application/json' },
					body,
				});
				return requestUrl({ url, method: 'POST', headers, body, throw: false });
			},
			RETRY_POLICY,
			{ isCancelled, onRateLimited: this.onRateLimited },
		);
		return response.arrayBuffer;
	}
}
