import { requestUrl } from 'obsidian';
import { ReaderSettings } from '../settings';
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

const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class ElevenLabsProvider implements TTSProvider {
	constructor(
		private apiKey: string,
		private settings: ReaderSettings,
		/** Called (possibly more than once) the moment a 429 is first seen, before any backoff wait. */
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string): Promise<ArrayBuffer> {
		for (let attempt = 0; ; attempt++) {
			const response = await requestUrl({
				url: `https://api.elevenlabs.io/v1/text-to-speech/${this.settings.voiceId}`,
				method: 'POST',
				headers: {
					'xi-api-key': this.apiKey,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					text,
					model_id: this.settings.modelId,
					voice_settings: {
						stability: this.settings.stability,
						similarity_boost: this.settings.similarityBoost,
					},
				}),
				throw: false,
			});

			if (response.status === 200) return response.arrayBuffer;

			if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
				this.onRateLimited?.();
				await sleep(RATE_LIMIT_BASE_BACKOFF_MS * 2 ** attempt);
				continue;
			}

			throw new Error(`ElevenLabs request failed (${response.status}): ${response.text}`);
		}
	}
}
