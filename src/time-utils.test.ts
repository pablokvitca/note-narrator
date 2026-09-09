import { describe, expect, it } from 'vitest';
import { computeFullReadTimes, formatCurrentPartTimeText, formatFullReadTimeText, formatTime, formatTimeDisplay } from './time-utils';

describe('formatTime', () => {
	it('formats whole minutes and seconds with zero-padded seconds', () => {
		expect(formatTime(0)).toBe('0:00');
		expect(formatTime(5)).toBe('0:05');
		expect(formatTime(65)).toBe('1:05');
		expect(formatTime(600)).toBe('10:00');
	});

	it('floors fractional seconds', () => {
		expect(formatTime(59.9)).toBe('0:59');
	});

	it('clamps invalid input to zero', () => {
		expect(formatTime(-5)).toBe('0:00');
		expect(formatTime(NaN)).toBe('0:00');
		expect(formatTime(Infinity)).toBe('0:00');
	});
});

describe('computeFullReadTimes', () => {
	it('sums only chunks with known durations and reports the rest as missing', () => {
		// 3-chunk read: chunk 0 fully played (30s), chunk 1 is current (10s into a 20s chunk),
		// chunk 2 hasn't generated yet.
		const times = computeFullReadTimes({
			chunkCount: 3,
			chunkIndex: 1,
			chunkDurations: [30, undefined, undefined],
			currentTime: 10,
			currentDuration: 20,
		});
		expect(times.elapsed).toBe(40); // 30 (chunk 0) + 10 (into chunk 1)
		expect(times.total).toBe(50); // 30 + 20 known so far
		expect(times.missingParts).toBe(1); // chunk 2
	});

	it('reports every chunk as missing before any have generated', () => {
		const times = computeFullReadTimes({
			chunkCount: 4,
			chunkIndex: 0,
			chunkDurations: [undefined, undefined, undefined, undefined],
			currentTime: 0,
			currentDuration: undefined,
		});
		expect(times).toEqual({ elapsed: 0, total: 0, missingParts: 4 });
	});

	it('never lets elapsed exceed a chunk-in-progress duration', () => {
		// currentTime beyond currentDuration shouldn't happen in practice, but must not corrupt totals.
		const times = computeFullReadTimes({
			chunkCount: 1,
			chunkIndex: 0,
			chunkDurations: [undefined],
			currentTime: 999,
			currentDuration: 20,
		});
		expect(times.elapsed).toBe(20);
		expect(times.total).toBe(20);
	});

	it('treats a fully generated read with no missing parts', () => {
		const times = computeFullReadTimes({
			chunkCount: 2,
			chunkIndex: 1,
			chunkDurations: [15, undefined],
			currentTime: 5,
			currentDuration: 25,
		});
		expect(times).toEqual({ elapsed: 20, total: 40, missingParts: 0 });
	});
});

describe('formatFullReadTimeText', () => {
	it('matches the spec example format with missing parts', () => {
		// 0:42 elapsed / 1:30 known-total, 3 parts not generated yet, 0:48 remaining at 1x.
		const text = formatFullReadTimeText({ elapsed: 42, total: 90, missingParts: 3 }, 1);
		expect(text).toBe('0:42 / 1:30 (+3 parts) - 0:48 (+3 parts) remaining');
	});

	it('uses singular "part" for exactly one missing part', () => {
		const text = formatFullReadTimeText({ elapsed: 0, total: 10, missingParts: 1 }, 1);
		expect(text).toContain('(+1 part)');
		expect(text).not.toContain('(+1 parts)');
	});

	it('omits the suffix entirely once nothing is missing', () => {
		const text = formatFullReadTimeText({ elapsed: 10, total: 20, missingParts: 0 }, 1);
		expect(text).toBe('0:10 / 0:20 - 0:10 remaining');
	});

	it('divides only the remaining time by the playback rate', () => {
		const text = formatFullReadTimeText({ elapsed: 0, total: 20, missingParts: 0 }, 2);
		expect(text).toBe('0:00 / 0:20 - 0:10 remaining');
	});
});

describe('formatCurrentPartTimeText', () => {
	it('formats today\'s per-chunk-only readout', () => {
		expect(formatCurrentPartTimeText(5, 20, 1)).toBe('0:05 / 0:20 · 0:15 remaining');
	});

	it('scales remaining time by playback rate', () => {
		expect(formatCurrentPartTimeText(0, 30, 2)).toBe('0:00 / 0:30 · 0:15 remaining');
	});
});

describe('formatTimeDisplay', () => {
	const times = { elapsed: 42, total: 90, missingParts: 1 };
	const current = { currentTime: 5, duration: 20 };

	it('"full" mode shows only the whole-read totals', () => {
		expect(formatTimeDisplay('full', times, current, 1)).toBe('0:42 / 1:30 (+1 part) - 0:48 (+1 part) remaining');
	});

	it('"current" mode shows only the per-chunk readout', () => {
		expect(formatTimeDisplay('current', times, current, 1)).toBe('0:05 / 0:20 · 0:15 remaining');
	});

	it('"both" mode shows full totals with current part alongside', () => {
		expect(formatTimeDisplay('both', times, current, 1)).toBe(
			'0:42 / 1:30 (+1 part) - 0:48 (+1 part) remaining (current part: 0:05 / 0:20 · 0:15 remaining)',
		);
	});
});
