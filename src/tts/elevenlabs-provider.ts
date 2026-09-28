import { requestUrl } from 'obsidian';
import type { ElevenLabsVoiceConfig } from '../settings/profiles';
import { AudioFormat, TTSProvider } from './provider';
import { RetryPolicy, requestFailedError, requestWithRetry } from './request';

export interface ElevenLabsVoice {
	voiceId: string;
	name: string;
}

/** Fetches up to 100 voices available to the account (ElevenLabs' /v2/voices is paginated; MVP fetches the first page only). */
export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
	const response = await requestUrl({
		url: 'https://api.elevenlabs.io/v2/voices?page_size=100',
		method: 'GET',
		headers: { 'xi-api-key': apiKey },
		throw: false,
	});

	if (response.status !== 200) {
		throw requestFailedError('ElevenLabs', response.status, response.text);
	}

	const body = response.json as { voices?: { voice_id: string; name: string }[] };
	return (body.voices ?? []).map((voice) => ({ voiceId: voice.voice_id, name: voice.name }));
}

/** Fetches a single voice's display name by ID, e.g. to label a saved audio filename. */
export async function getElevenLabsVoiceName(apiKey: string, voiceId: string): Promise<string> {
	const response = await requestUrl({
		url: `https://api.elevenlabs.io/v1/voices/${voiceId}`,
		method: 'GET',
		headers: { 'xi-api-key': apiKey },
		throw: false,
	});

	if (response.status !== 200) {
		throw requestFailedError('ElevenLabs', response.status, response.text);
	}

	const body = response.json as { name?: string };
	return body.name ?? voiceId;
}

/**
 * With a high "max parallel chunk generation" setting, many requests can be dispatched at once and hit
 * ElevenLabs' "too many concurrent requests" 429 together -- they don't retry in lockstep (the backoff is
 * jittered), but capacity only frees up as other in-flight requests finish, which can take a while
 * under heavy concurrency. 3 retries at a ~1-4s backoff wasn't enough margin for that to clear: several
 * requests would exhaust their retries and throw before the account's concurrency limit came back down,
 * and `Promise.all` in the caller's worker pool fails the *entire* read the moment any one of them does.
 * A higher retry budget with a longer capped backoff gives real congestion time to actually clear.
 */
const RETRY_POLICY: RetryPolicy = { maxRetries: 8, baseBackoffMs: 1000, maxBackoffMs: 30000 };

export class ElevenLabsProvider implements TTSProvider {
	readonly outputFormat: AudioFormat = 'mp3';

	constructor(
		private apiKey: string,
		private voice: ElevenLabsVoiceConfig,
		/** Called (possibly more than once) the moment a 429 is first seen, before any backoff wait. */
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer> {
		const response = await requestWithRetry(
			'ElevenLabs',
			() =>
				requestUrl({
					url: `https://api.elevenlabs.io/v1/text-to-speech/${this.voice.voiceId}`,
					method: 'POST',
					headers: {
						'xi-api-key': this.apiKey,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						text,
						model_id: this.voice.modelId,
						voice_settings: {
							stability: this.voice.stability,
							similarity_boost: this.voice.similarityBoost,
						},
					}),
					throw: false,
				}),
			RETRY_POLICY,
			{ isCancelled, onRateLimited: this.onRateLimited },
		);
		return response.arrayBuffer;
	}
}
