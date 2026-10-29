/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportPuzzleCreditOpened } from './puzzle-credit.js';

describe('reportPuzzleCreditOpened', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
    });

    it('reports the photo id it was given', () => {
        reportPuzzleCreditOpened('photo', 'abc123');

        expect(umamiTrack).toHaveBeenCalledWith('photo-credit-opened', { where: 'puzzle', link: 'photo', photoId: 'abc123' });
    });

    it('reports an empty photo id when none is known', () => {
        reportPuzzleCreditOpened('photographer', undefined);

        expect(umamiTrack).toHaveBeenCalledWith('photo-credit-opened', { where: 'puzzle', link: 'photographer', photoId: '' });
    });
});
