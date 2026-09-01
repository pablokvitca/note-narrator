import { requestUrl } from 'obsidian';
import { ReaderSettings } from '../settings';
import { TTSProvider } from './provider';

export class ElevenLabsProvider implements TTSProvider {
	constructor(
		private apiKey: string,
		private settings: ReaderSettings,
	) {}

	async synthesize(text: string): Promise<ArrayBuffer> {
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

		if (response.status !== 200) {
			throw new Error(`ElevenLabs request failed (${response.status}): ${response.text}`);
		}

		return response.arrayBuffer;
	}
}
