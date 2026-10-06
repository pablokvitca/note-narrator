export type TimeDisplayMode = 'full' | 'current' | 'both';

function pad(n: number, width = 2): string {
	return n.toString().padStart(width, '0');
}

/** e.g. "2026-09-27 143005" -- for a fallback saved-audio filename when the note has no title. Local time. */
export function formatTimestampForFilename(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * ISO 8601 with the local UTC offset kept (e.g. "2026-09-27T14:30:05.123-04:00"), not the `Z`-suffixed UTC
 * form `Date.prototype.toISOString()` gives. Written to frontmatter as the generation timestamp, where local
 * time is more useful to a reader than UTC. A small hand-rolled replacement for `moment().toISOString(true)`,
 * to avoid depending on the `moment` package (bundled only for its Obsidian-re-exported types) for two calls.
 */
export function toLocalISOString(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? '+' : '-';
	const abs = Math.abs(offsetMinutes);
	const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${offset}`;
}

export function formatTime(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.floor(totalSeconds % 60);
	return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export interface FullReadTimesInput {
	chunkCount: number;
	chunkIndex: number;
	/** Known duration (seconds) of each chunk's audio, once decoded -- undefined for chunks not yet generated. */
	chunkDurations: (number | undefined)[];
	/** Playback position (seconds) within the currently active chunk. */
	currentTime: number;
	/** Live duration (seconds) of the currently active chunk, or undefined if not yet known (e.g. still generating). */
	currentDuration: number | undefined;
}

export interface FullReadTimes {
	/** Cumulative playback position across every chunk with a known duration, raw (unscaled by playback rate) seconds. */
	elapsed: number;
	/** Cumulative duration across every chunk with a known duration, raw seconds. */
	total: number;
	/** Number of chunks (besides the current one) whose duration isn't known yet because they haven't finished generating. */
	missingParts: number;
}

/**
 * Cumulative whole-read elapsed/total, computed only from chunks whose audio duration is actually known
 * (already generated, or the currently-playing one). Chunks beyond that are counted in `missingParts`
 * instead of guessed at, so the totals never silently under-report a note that isn't fully generated yet.
 */
export function computeFullReadTimes(input: FullReadTimesInput): FullReadTimes {
	const { chunkCount, chunkIndex, chunkDurations, currentTime, currentDuration } = input;
	let elapsed = 0;
	let total = 0;
	let missingParts = 0;

	for (let i = 0; i < chunkCount; i++) {
		const isCurrent = i === chunkIndex;
		const duration = isCurrent ? currentDuration : chunkDurations[i];
		if (duration === undefined) {
			missingParts++;
			continue;
		}
		total += duration;
		if (i < chunkIndex) elapsed += duration;
		else if (isCurrent) elapsed += Math.min(currentTime, duration);
	}

	return { elapsed, total, missingParts };
}

function missingPartsSuffix(missingParts: number): string {
	return missingParts > 0 ? ` (+${missingParts} part${missingParts === 1 ? '' : 's'})` : '';
}

/** e.g. "0:42 / 1:30 (+3 parts) - 0:48 (+3 parts) remaining". */
export function formatFullReadTimeText(times: FullReadTimes, playbackRate: number): string {
	const suffix = missingPartsSuffix(times.missingParts);
	const remaining = Math.max(0, times.total - times.elapsed) / (playbackRate || 1);
	return `${formatTime(times.elapsed)} / ${formatTime(times.total)}${suffix} - ${formatTime(remaining)}${suffix} remaining`;
}

/** e.g. "0:05 / 0:20 · 0:15 remaining" -- today's per-chunk-only readout. */
export function formatCurrentPartTimeText(currentTime: number, duration: number, playbackRate: number): string {
	const remaining = Math.max(0, duration - currentTime) / (playbackRate || 1);
	return `${formatTime(currentTime)} / ${formatTime(duration)} · ${formatTime(remaining)} remaining`;
}

/** Renders the panel's time readout per the "Time display" setting. */
export function formatTimeDisplay(
	mode: TimeDisplayMode,
	times: FullReadTimes,
	current: { currentTime: number; duration: number },
	playbackRate: number,
): string {
	const fullText = formatFullReadTimeText(times, playbackRate);
	if (mode === 'full') return fullText;

	const currentText = formatCurrentPartTimeText(current.currentTime, current.duration, playbackRate);
	if (mode === 'current') return currentText;

	return `${fullText} (current part: ${currentText})`;
}
