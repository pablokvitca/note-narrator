import { RequestUrlResponse, requestUrl } from 'obsidian';
import type { GeminiVoiceConfig } from '../settings/profiles';
import { readWavFormat, wrapPcmAsWav } from '../engine/wav';
import { GEMINI_NAME } from './gemini-models';
import { AudioFormat, TTSProvider } from './provider';
import { RetryPolicy, requestWithRetry } from './request';

/*
 * Google Gemini text to speech, through `generateContent` with an audio response, as documented (2026-09-28) at
 * https://ai.google.dev/gemini-api/docs/generate-content/speech-generation. The audio comes back base64-encoded
 * in `candidates[0].content.parts[0].inlineData`: 16-bit mono PCM at 24 kHz, its `mimeType` such as
 * `audio/L16;codec=pcm;rate=24000`. Google's own examples also handle it arriving as a whole WAV file, so this
 * does too.
 */

/** The PCM format Gemini documents, used for whatever its `mimeType` doesn't say. */
const GEMINI_PCM = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };

/**
 * Gemini's preview TTS models have much tighter per-minute quotas than ElevenLabs (especially on the free tier),
 * so a rate-limited request may have to wait most of a minute: more retries, and a higher cap.
 */
const RETRY_POLICY: RetryPolicy = { maxRetries: 6, baseBackoffMs: 2000, maxBackoffMs: 60000, requestedDelayMs: geminiRequestedDelayMs };

/** How long Gemini asked to wait before retrying: a rate-limit error may carry a `RetryInfo` detail, such as `"retryDelay": "31s"`. */
export function geminiRequestedDelayMs(response: RequestUrlResponse): number | null {
	try {
		const body = JSON.parse(response.text) as { error?: { details?: { retryDelay?: unknown }[] } };
		for (const detail of body.error?.details ?? []) {
			const match = typeof detail.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay) : null;
			if (match) return Number(match[1]) * 1000;
		}
	} catch {
		// Not JSON: no delay given.
	}
	return null;
}

/** Decodes Gemini's base64 audio into a WAV file, wrapping it in a WAV header unless it already is one. */
export function decodeGeminiAudio(base64Data: string, mimeType: string | undefined): ArrayBuffer {
	const binary = atob(base64Data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	if (readWavFormat(bytes.buffer)) return bytes.buffer;

	const rate = /rate=(\d+)/.exec(mimeType ?? '');
	return wrapPcmAsWav(bytes.buffer, { ...GEMINI_PCM, sampleRate: rate ? Number(rate[1]) : GEMINI_PCM.sampleRate });
}

interface GeminiGenerateContentResponse {
	candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
}

export class GeminiProvider implements TTSProvider {
	readonly outputFormat = AudioFormat.Wav;

	constructor(
		private apiKey: string,
		private voice: GeminiVoiceConfig,
		/** Called (possibly more than once) the moment a 429 is first seen, before any backoff wait. */
		private onRateLimited?: () => void,
	) {}

	async synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer> {
		// Gemini has no voice sliders: it's steered by instructions before the text, as in Google's own
		// examples ("Say cheerfully: Have a wonderful day!").
		const instructions = this.voice.instructions.trim();
		const prompt = instructions ? `${instructions}: ${text}` : text;
		const response = await requestWithRetry(
			GEMINI_NAME,
			() =>
				requestUrl({
					url: `https://generativelanguage.googleapis.com/v1beta/models/${this.voice.modelId}:generateContent`,
					method: 'POST',
					headers: {
						'x-goog-api-key': this.apiKey,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						contents: [{ parts: [{ text: prompt }] }],
						generationConfig: {
							responseModalities: ['AUDIO'],
							speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice.voiceName } } },
						},
					}),
					throw: false,
				}),
			RETRY_POLICY,
			{ isCancelled, onRateLimited: this.onRateLimited },
		);

		const audio = (response.json as GeminiGenerateContentResponse).candidates?.[0]?.content?.parts?.[0]?.inlineData;
		if (!audio?.data) throw new Error("Gemini's response had no audio.");
		return decodeGeminiAudio(audio.data, audio.mimeType);
	}
}
