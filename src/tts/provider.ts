/** The audio format a provider's synthesized bytes come back in. */
export type AudioFormat = 'mp3' | 'wav';

export interface TTSProvider {
	/** The format `synthesize()`'s bytes are in, for the playback Blob's MIME type and the saved file's extension. */
	readonly outputFormat: AudioFormat;
	/** Converts text to speech audio and returns the encoded audio bytes (e.g. MPEG). `isCancelled` lets a provider stop retrying once its caller gave up (e.g. the plugin unloaded). */
	synthesize(text: string, isCancelled?: () => boolean): Promise<ArrayBuffer>;
}
