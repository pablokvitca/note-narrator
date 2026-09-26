/** Concatenates raw MPEG chunks into a single buffer; ElevenLabs' output has no mid-stream headers, so naive concatenation plays back correctly. */
export function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
	const totalLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const buffer of buffers) {
		result.set(new Uint8Array(buffer), offset);
		offset += buffer.byteLength;
	}
	return result.buffer;
}

/** Strips characters invalid in filenames on common filesystems. */
export function sanitizeFilenameComponent(text: string): string {
	return text.replace(/[\\/:*?"<>|]/g, '').trim();
}

/** Decodes a generated chunk's audio duration (seconds) without playing it, for whole-read time totals. */
export function decodeAudioDuration(buffer: ArrayBuffer): Promise<number> {
	return new Promise((resolve) => {
		const blob = new Blob([buffer], { type: 'audio/mpeg' });
		const url = URL.createObjectURL(blob);
		const audio = new Audio(url);
		const finish = (duration: number) => {
			audio.removeEventListener('loadedmetadata', onLoaded);
			audio.removeEventListener('error', onError);
			URL.revokeObjectURL(url);
			resolve(duration);
		};
		const onLoaded = () => finish(audio.duration || 0);
		const onError = () => finish(0);
		audio.addEventListener('loadedmetadata', onLoaded);
		audio.addEventListener('error', onError);
	});
}

/** Splits a saved file's bytes back into its original per-chunk buffers, in order. Null if the lengths don't add up to the file's actual size -- stale or corrupted metadata, not safe to slice by. */
export function sliceIntoChunks(data: ArrayBuffer, byteLengths: number[]): ArrayBuffer[] | null {
	const total = byteLengths.reduce((sum, length) => sum + length, 0);
	if (total !== data.byteLength) return null;

	const buffers: ArrayBuffer[] = [];
	let offset = 0;
	for (const length of byteLengths) {
		buffers.push(data.slice(offset, offset + length));
		offset += length;
	}
	return buffers;
}
