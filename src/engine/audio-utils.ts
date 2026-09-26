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
