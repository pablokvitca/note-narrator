import { requestUrl } from 'obsidian';
import type { ElevenLabsVoiceConfig } from '../settings/profiles';
import { TTSProvider } from './provider';

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
		throw new Error(`ElevenLabs request failed (${response.status}): ${response.text}`);
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
		throw new Error(`ElevenLabs request failed (${response.status}): ${response.text}`);
	}

	const body = response.json as { name?: string };
	return body.name ?? voiceId;
}

/**
 * With a high "max parallel chunk generation" setting, many requests can be dispatched at once and hit
 * ElevenLabs' "too many concurrent requests" 429 together -- they don't retry in lockstep (backoff is
 * jittered below), but capacity only frees up as other in-flight requests finish, which can take a while
 * under heavy concurrency. 3 retries at a ~1-4s backoff wasn't enough margin for that to clear: several
 * requests would exhaust their retries and throw before the account's concurrency limit came back down,
 * and `Promise.all` in the caller's worker pool fails the *entire* read the moment any one of them does.
 * A higher retry budget with a longer capped backoff gives real congestion time to actually clear.
 */
const MAX_RATE_LIMIT_RETRIES = 8;
const RATE_LIMIT_BASE_BACKOFF_MS = 1000;
const RATE_LIMIT_MAX_BACKOFF_MS = 30000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class ElevenLabsProvider implements TTSProvider {
	constructor(
		private apiKey: string,
		private voice: ElevenLabsVoiceConfig,
		/** Called (possibly more than once) the moment a 429 is first seen, before any backoff wait. */
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string): Promise<ArrayBuffer> {
		for (let attempt = 0; ; attempt++) {
			const response = await requestUrl({
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
			});

			if (response.status === 200) return response.arrayBuffer;

			if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
				this.onRateLimited?.();
				const backoff = Math.min(RATE_LIMIT_BASE_BACKOFF_MS * 2 ** attempt, RATE_LIMIT_MAX_BACKOFF_MS);
				// +/-20% jitter so many requests rate-limited at the same moment (a high parallel-generation
				// setting) don't all retry in lockstep and collide again.
				await sleep(backoff * (0.8 + Math.random() * 0.4));
				continue;
			}

			throw new Error(`ElevenLabs request failed (${response.status}): ${response.text}`);
		}
	}
}
