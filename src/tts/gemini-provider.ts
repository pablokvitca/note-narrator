import { requestUrl } from 'obsidian';
import type { GeminiVoiceConfig } from '../settings/profiles';
import { AudioFormat, TTSProvider } from './provider';

/*
 * Google Gemini text-to-speech, via the `generateContent` REST endpoint with an audio response modality.
 * Researched against Google's own docs and cookbook (2026-09-28):
 *   https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
 *   https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-preview-tts
 *   https://github.com/google-gemini/cookbook (quickstarts/Get_started_TTS.ipynb)
 *
 * A NOTE ON SOURCES: Google's docs site currently labels the `generateContent`-based TTS page "(Legacy)",
 * pointing at a newer "Interactions API" (`POST .../v1beta/interactions`) as the forward-looking way to call
 * Gemini models generally. Fetches of that newer surface were inconsistent across repeated tries (a model id
 * that never appeared outside of AI-generated page summaries, response-shape claims that flatly contradicted
 * each other between two fetches of nominally the same doc), which smells like an AI summarizer hallucinating
 * plausible-sounding specifics for a topic it doesn't actually have grounded content for, rather than a real,
 * stable API surface. The `generateContent` + `responseModalities: ["AUDIO"]` shape below, by contrast, is
 * corroborated consistently: it matches real published request/response examples, and it's what every
 * community integration of Gemini TTS (as of this plugin's research) actually uses. It's simpler besides --
 * one request, one response, no session/interaction state -- which fits this provider's synchronous
 * `synthesize()` contract far better than a stateful "interaction" API would. This is a deliberate choice to
 * implement the well-documented, verifiable surface over an unverified newer one; flagged here (and in the
 * PR description) in case the reviewing session has stronger evidence the newer API is in fact live and
 * necessary.
 *
 * AUDIO FORMAT: unary (non-streaming) `generateContent` calls return, in
 * `candidates[0].content.parts[0].inlineData`, base64-encoded audio and a `mimeType`. Google's own examples
 * are inconsistent about whether that payload is already a complete WAV file (RIFF header included) or
 * headerless raw PCM (16-bit signed little-endian, mono, typically 24kHz) -- the cookbook's own helper
 * checks for a `RIFF` magic number and only builds a WAV header itself when one isn't already present. This
 * provider does the same: it inspects the decoded bytes for a `RIFF` header and only wraps them in one if
 * they're missing, so the returned ArrayBuffer is always a playable `.wav` file either way. If Gemini's
 * `mimeType` string carries an explicit sample rate (`audio/L16;rate=24000`-style), that rate is used;
 * otherwise this falls back to 24000 Hz, mono, 16-bit -- the rate every source agreed on.
 *
 * CAVEAT FOR CALLERS (flagged for the reviewing session, not fixed here -- out of this provider's scope):
 * Note Narrator's engine (`engine/audio-utils.ts#concatArrayBuffers`, `engine/saved-audio.ts`) assumes a
 * provider's chunks are headerless frames that concatenate byte-for-byte into one playable file (true for
 * ElevenLabs' MP3 output) and always saves/serves audio as `.mp3` / `audio/mpeg`. A WAV file has one header
 * describing the *whole* file's length, so naively concatenating multiple Gemini chunks the way ElevenLabs'
 * MP3 chunks are concatenated will NOT produce a valid multi-chunk WAV file -- only the first chunk (or none,
 * depending on the player) will play back correctly for multi-chunk reads. Saving also always writes a
 * `.mp3` extension regardless of the actual bytes. Making Gemini audio fully correct for saved files and
 * multi-chunk playback needs changes to that shared engine code (e.g. per-provider container/extension
 * awareness, or transcoding/re-muxing chunks), which is exactly the kind of cross-cutting change this task
 * asked to flag rather than make unilaterally alongside three more providers landing soon.
 */

export interface GeminiSynthesizeOptions {
	/** Called (possibly more than once) the moment a 429/quota error is first seen, before any backoff wait. */
	onRateLimited?: () => void;
}

/**
 * Gemini's preview TTS models have much tighter per-minute quotas than ElevenLabs (particularly on the free
 * tier), so a rate-limited request may need to wait close to a full quota window before it clears, not just
 * a few seconds. The retry budget and cap are set higher than ElevenLabs' accordingly; the jittered
 * exponential-backoff *pattern* is the same and for the same reason -- with parallel chunk generation
 * enabled, several requests can get rate-limited in the same instant and must not all retry in lockstep.
 */
const MAX_RATE_LIMIT_RETRIES = 6;
const RATE_LIMIT_BASE_BACKOFF_MS = 2000;
const RATE_LIMIT_MAX_BACKOFF_MS = 60000;

const DEFAULT_SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Decodes a base64 string (as returned by Gemini's `inlineData.data`) into raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function hasRiffHeader(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // "RIFF"
}

/** Reads a `rate=NNNN` hint out of a mimeType like `audio/L16;codec=pcm;rate=24000`, else the documented default. */
function sampleRateFromMimeType(mimeType: string | undefined): number {
	const match = mimeType?.match(/rate=(\d+)/);
	return match ? Number(match[1]) : DEFAULT_SAMPLE_RATE;
}

/** Wraps headerless 16-bit PCM samples in a minimal 44-byte canonical WAV (RIFF) header. */
function wrapPcmAsWav(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
	const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
	const byteRate = sampleRate * blockAlign;
	const buffer = new ArrayBuffer(44 + pcm.byteLength);
	const view = new DataView(buffer);

	const writeString = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	writeString(0, 'RIFF');
	view.setUint32(4, 36 + pcm.byteLength, true);
	writeString(8, 'WAVE');
	writeString(12, 'fmt ');
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, CHANNELS, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);
	writeString(36, 'data');
	view.setUint32(40, pcm.byteLength, true);
	new Uint8Array(buffer, 44).set(pcm);

	return buffer;
}

/** Decodes Gemini's `inlineData` payload into a playable `.wav` ArrayBuffer, wrapping raw PCM only if it isn't already a WAV file. */
export function decodeGeminiAudio(base64Data: string, mimeType: string | undefined): ArrayBuffer {
	const bytes = base64ToBytes(base64Data);
	if (hasRiffHeader(bytes)) {
		const copy = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(copy).set(bytes);
		return copy;
	}
	return wrapPcmAsWav(bytes, sampleRateFromMimeType(mimeType));
}

interface GeminiGenerateContentResponse {
	candidates?: {
		content?: {
			parts?: { inlineData?: { data?: string; mimeType?: string } }[];
		};
	}[];
}

export class GeminiProvider implements TTSProvider {
	readonly outputFormat: AudioFormat = 'wav';

	constructor(
		private apiKey: string,
		private voice: GeminiVoiceConfig,
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer> {
		// Gemini's TTS voices have no numeric stability/similarity sliders; style is steered with a short
		// natural-language instruction prepended to the transcript instead (Google's own examples: e.g.
		// "Say cheerfully: Have a wonderful day!").
		const promptText = this.voice.stylePrompt.trim() ? `${this.voice.stylePrompt.trim()}: ${text}` : text;

		for (let attempt = 0; ; attempt++) {
			if (isCancelled?.()) throw new Error('Generation was cancelled.');

			const response = await requestUrl({
				url: `https://generativelanguage.googleapis.com/v1beta/models/${this.voice.modelId}:generateContent`,
				method: 'POST',
				headers: {
					'x-goog-api-key': this.apiKey,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					contents: [{ parts: [{ text: promptText }] }],
					generationConfig: {
						responseModalities: ['AUDIO'],
						speechConfig: {
							voiceConfig: {
								prebuiltVoiceConfig: { voiceName: this.voice.voiceName },
							},
						},
					},
				}),
				throw: false,
			});

			if (response.status === 200) {
				const body = response.json as GeminiGenerateContentResponse;
				const part = body.candidates?.[0]?.content?.parts?.[0]?.inlineData;
				if (!part?.data) throw new Error('Gemini response did not include audio data.');
				return decodeGeminiAudio(part.data, part.mimeType);
			}

			if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
				this.onRateLimited?.();
				const backoff = Math.min(RATE_LIMIT_BASE_BACKOFF_MS * 2 ** attempt, RATE_LIMIT_MAX_BACKOFF_MS);
				// +/-20% jitter so many requests rate-limited at the same moment (a high parallel-generation
				// setting) don't all retry in lockstep and collide again.
				await sleep(backoff * (0.8 + Math.random() * 0.4));
				continue;
			}

			throw new Error(`Gemini request failed (${response.status}): ${response.text}`);
		}
	}
}
