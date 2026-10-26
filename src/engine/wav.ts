/*
 * Minimal WAV (RIFF/WAVE, PCM) reading and writing, for providers that return WAV audio. Pure, no Obsidian
 * imports, so it can be unit tested.
 */

/** The IDs of the RIFF/WAVE chunks this reads and writes. */
enum RiffId {
	Riff = 'RIFF',
	Wave = 'WAVE',
	Format = 'fmt ',
	Data = 'data',
}

/** Each {@link RiffId} by its text. */
const RIFF_IDS = new Map<string, RiffId>(Object.values(RiffId).map((id) => [id, id]));

/** The chunk ID at `offset`, or null for one this doesn't use. */
function riffId(view: DataView, offset: number): RiffId | null {
	return RIFF_IDS.get(ascii(view, offset, 4)) ?? null;
}

/** The size of the header {@link wrapPcmAsWav} writes: RIFF, a 16-byte `fmt ` chunk and the `data` chunk's header. */
export const WAV_HEADER_BYTES = 44;

/** The sample format of PCM audio. */
export interface WavFormat {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
}

function ascii(view: DataView, offset: number, length: number): string {
	let text = '';
	for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
	return text;
}

/** The byte range of `data`'s `fmt ` and `data` chunks, or null if it isn't a RIFF/WAVE file. */
function findChunks(data: ArrayBuffer): { fmt: number | null; dataStart: number; dataLength: number } | null {
	const view = new DataView(data);
	if (data.byteLength < 12 || riffId(view, 0) !== RiffId.Riff || riffId(view, 8) !== RiffId.Wave) return null;

	let fmt: number | null = null;
	let offset = 12;
	while (offset + 8 <= data.byteLength) {
		const id = riffId(view, offset);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === RiffId.Format && size >= 16) fmt = body;
		if (id === RiffId.Data) {
			// Streamed WAVs may give the data size as 0 or 0xFFFFFFFF; the data then runs to the end of the file.
			const dataLength = size === 0 || body + size > data.byteLength ? data.byteLength - body : size;
			return { fmt, dataStart: body, dataLength };
		}
		// Chunks are padded to an even length.
		offset = body + size + (size % 2);
	}
	return null;
}

/** The sample format of a PCM WAV file, or null if `data` isn't one. */
export function readWavFormat(data: ArrayBuffer): WavFormat | null {
	const chunks = findChunks(data);
	if (!chunks || chunks.fmt === null) return null;
	const view = new DataView(data);
	// 1 is integer PCM; 0xFFFE (extensible) is also PCM when, as here, only its basic fields are used.
	const audioFormat = view.getUint16(chunks.fmt, true);
	if (audioFormat !== 1 && audioFormat !== 0xfffe) return null;
	return {
		channels: view.getUint16(chunks.fmt + 2, true),
		sampleRate: view.getUint32(chunks.fmt + 4, true),
		bitsPerSample: view.getUint16(chunks.fmt + 14, true),
	};
}

/** A WAV file's PCM samples (its `data` chunk). Throws if `data` isn't a WAV file. */
export function wavPcmData(data: ArrayBuffer): ArrayBuffer {
	const chunks = findChunks(data);
	if (!chunks) throw new Error('The audio is not a valid WAV file.');
	return data.slice(chunks.dataStart, chunks.dataStart + chunks.dataLength);
}

/** Wraps PCM samples in a WAV file with the canonical {@link WAV_HEADER_BYTES}-byte header. */
export function wrapPcmAsWav(pcm: ArrayBuffer, format: WavFormat): ArrayBuffer {
	const blockAlign = (format.channels * format.bitsPerSample) / 8;
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcm.byteLength);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	writeAscii(0, RiffId.Riff);
	view.setUint32(4, WAV_HEADER_BYTES - 8 + pcm.byteLength, true);
	writeAscii(8, RiffId.Wave);
	writeAscii(12, RiffId.Format);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, format.channels, true);
	view.setUint32(24, format.sampleRate, true);
	view.setUint32(28, format.sampleRate * blockAlign, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, format.bitsPerSample, true);
	writeAscii(36, RiffId.Data);
	view.setUint32(40, pcm.byteLength, true);
	new Uint8Array(buffer, WAV_HEADER_BYTES).set(new Uint8Array(pcm));
	return buffer;
}
