/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPuzzleImageLoadTracker } from './puzzle-image-load.js';
import { makeGameState } from '../test-helpers/fixtures.js';

const PHOTO_URL = 'https://images.unsplash.com/photo-1?w=1080';

type Outcome = 'loaded' | 'failed';

describe('createPuzzleImageLoadTracker', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;
    let clock: number;
    let settle: (outcome: Outcome) => void;
    const now = (): number => clock;
    const photoSettled = (): Promise<Outcome> =>
        new Promise<Outcome>((resolve) => { settle = resolve; });

    function events(): unknown[] {
        return umamiTrack.mock.calls.filter(([n]) => n === 'puzzle-image-loaded').map(([, d]) => d);
    }

    async function flush(): Promise<void> {
        await Promise.resolve();
        await Promise.resolve();
    }

    beforeEach(() => {
        clock = 0;
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
    });

    it('reports a loaded photo with its timing and source', async () => {
        createPuzzleImageLoadTracker({ photoSettled, now }).observe(makeGameState({ imageUrl: PHOTO_URL }), 'new');
        clock = 420;
        settle('loaded');
        await flush();

        expect(events()).toEqual([{ outcome: 'loaded', ms: 420, trigger: 'new', imageSource: 'unsplash' }]);
    });

    it('rounds ms to whole milliseconds', async () => {
        clock = 0.3;
        createPuzzleImageLoadTracker({ photoSettled, now }).observe(makeGameState({ imageUrl: PHOTO_URL }), 'new');
        clock = 420.9;
        settle('loaded');
        await flush();

        expect(events()[0]).toMatchObject({ ms: 421 });
    });

    it('reports a failed photo', async () => {
        createPuzzleImageLoadTracker({ photoSettled, now }).observe(makeGameState({ imageUrl: PHOTO_URL }), 'resume');
        settle('failed');
        await flush();

        expect(events()[0]).toMatchObject({ outcome: 'failed', trigger: 'resume' });
    });

    it('reports the photo id it was given', async () => {
        createPuzzleImageLoadTracker({ photoSettled, now })
            .observe(makeGameState({ imageUrl: PHOTO_URL }), 'new', 'abc123');
        settle('loaded');
        await flush();

        expect(events()[0]).toMatchObject({ imagePhotoId: 'abc123' });
    });

    it('omits imagePhotoId when none was given', async () => {
        createPuzzleImageLoadTracker({ photoSettled, now }).observe(makeGameState({ imageUrl: PHOTO_URL }), 'shared');
        settle('loaded');
        await flush();

        expect(events()[0]).not.toHaveProperty('imagePhotoId');
    });

    it('reports a replaced puzzle as abandoned, not failed', async () => {
        const tracker = createPuzzleImageLoadTracker({ photoSettled, now });
        tracker.observe(makeGameState({ imageUrl: PHOTO_URL }), 'new');
        const settleFirst = settle;
        clock = 100;
        tracker.observe(makeGameState({ imageUrl: PHOTO_URL }), 'new');

        settleFirst('failed');
        await flush();

        expect(events()).toEqual([{ outcome: 'abandoned', ms: 100, trigger: 'new', imageSource: 'unsplash' }]);
    });

    it('reports abandon() as abandoned, once', async () => {
        const tracker = createPuzzleImageLoadTracker({ photoSettled, now });
        tracker.observe(makeGameState({ imageUrl: PHOTO_URL }), 'shared');

        tracker.abandon();
        tracker.abandon();
        settle('loaded');
        await flush();

        expect(events()).toEqual([expect.objectContaining({ outcome: 'abandoned', trigger: 'shared' })]);
    });

    it('does nothing for a blank puzzle', async () => {
        createPuzzleImageLoadTracker({ photoSettled, now }).observe(makeGameState({ imageUrl: null }), 'new');
        await flush();

        expect(events()).toEqual([]);
    });
});
