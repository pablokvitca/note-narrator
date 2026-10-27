import { RequestUrlResponse, requestUrl } from 'obsidian';
import type { OpenAIVoiceConfig } from '../settings/profiles';
import { OPENAI_INSTRUCTION_MODELS, OPENAI_NAME } from './openai-models';
import { AudioFormat, TTSProvider } from './provider';
import { RetryPolicy, getHeader, requestWithRetry } from './request';

/**
 * How long OpenAI asked to wait before retrying: its rate-limit responses may say, in milliseconds
 * (`retry-after-ms`) or seconds (`retry-after`). That's more accurate than a blind backoff.
 */
export function openAIRequestedDelayMs(response: RequestUrlResponse): number | null {
	const ms = Number(getHeader(response, 'retry-after-ms'));
	if (Number.isFinite(ms) && ms > 0) return ms;
	const seconds = Number(getHeader(response, 'retry-after'));
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	return null;
}

/** Rate limits clear as the account's per-minute budget refills, so the backoff is capped lower than ElevenLabs'. */
const RETRY_POLICY: RetryPolicy = { maxRetries: 6, baseBackoffMs: 1000, maxBackoffMs: 20000, requestedDelayMs: openAIRequestedDelayMs };

export class OpenAIProvider implements TTSProvider {
	readonly outputFormat = AudioFormat.Mp3;

	constructor(
		private apiKey: string,
		private voice: OpenAIVoiceConfig,
		/** Called (possibly more than once) the moment a 429 is first seen, before any backoff wait. */
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer> {
		// Instructions left over from switching to a model that doesn't take them aren't sent: the settings
		// disable that field for such a model but keep its text.
		const instructions = OPENAI_INSTRUCTION_MODELS.has(this.voice.model) ? this.voice.instructions.trim() : '';
		const response = await requestWithRetry(
			OPENAI_NAME,
			() =>
				requestUrl({
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
						// MP3 is OpenAI's default too, but set so outputFormat stays true if that ever changes.
						response_format: 'mp3',
						speed: this.voice.speed,
						...(instructions ? { instructions } : {}),
					}),
					throw: false,
				}),
			RETRY_POLICY,
			{ isCancelled, onRateLimited: this.onRateLimited },
		);
		return response.arrayBuffer;
	}
}
