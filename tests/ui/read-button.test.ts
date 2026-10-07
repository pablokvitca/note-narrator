import { describe, expect, it } from 'vitest';
import { readButtonLabel } from '../../src/ui/read-button';

describe('readButtonLabel', () => {
	it('says Regenerate for outdated audio', () => {
		expect(readButtonLabel('outdated')).toBe('Regenerate');
	});

	it('says Regenerate with new narrator for audio made with another narrator', () => {
		expect(readButtonLabel('other-narrator')).toBe('Regenerate with new narrator');
	});

	it('leaves Read alone for current or unknown audio', () => {
		expect(readButtonLabel('current')).toBeNull();
		expect(readButtonLabel('unknown')).toBeNull();
	});
});
