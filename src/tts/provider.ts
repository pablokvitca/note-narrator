/** The audio container format a provider's synthesized bytes come back in. */
export type AudioFormat = 'mp3' | 'wav';

export interface TTSProvider {
	/** The container format `synthesize()`'s bytes are encoded in (e.g. to pick a save extension or a Blob MIME type). */
	readonly outputFormat: AudioFormat;
	/** Converts text to speech audio and returns the encoded audio bytes (e.g. MPEG). `isCancelled` lets a provider stop retrying once its caller gave up (e.g. the plugin unloaded). */
	synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer>;
}
