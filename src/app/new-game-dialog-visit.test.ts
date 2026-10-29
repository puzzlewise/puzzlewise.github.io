/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNewGameDialogVisit } from './new-game-dialog-visit.js';
import type { CandidateFetchResult, CandidateImage, PageDraw } from '../images/index.js';

function candidate(id: string): CandidateImage {
    const c: CandidateImage = {
        imageUrl: `https://images.unsplash.com/${id}?w=1080`,
        thumbUrl: `https://images.unsplash.com/${id}?w=400`,
        imageSize: { width: 1080, height: 720 },
        attribution: {
            photographerName: 'P',
            photographerUrl: 'https://unsplash.com/@p',
            photoUrl: `https://unsplash.com/photos/${id}`,
        },
        downloadLocation: `https://api.unsplash.com/photos/${id}/download`,
    };
    return c;
}

function shown(
    candidates: CandidateImage[],
    source: 'unsplash' | 'stash' = 'unsplash',
    draw?: PageDraw,
): CandidateFetchResult {
    return draw === undefined ? { candidates, cause: 'none', source } : { candidates, cause: 'none', source, draw };
}

const PARAMS = { imageCategory: 'face', vibrant: false, custom: false, orientation: 'portrait' } as const;
const OPEN = {
    hasPuzzle: true,
    puzzleCompleted: false,
    imageCategory: 'face',
    vibrant: false,
    picker: true,
    offlineDownload: true,
};

describe('createNewGameDialogVisit', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;
    let clock: number;
    const now = (): number => clock;

    function events(name: string): unknown[] {
        return umamiTrack.mock.calls.filter(([n]) => n === name).map(([, d]) => d);
    }

    beforeEach(() => {
        clock = 0;
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
    });

    it('reports the opening with the visit context', () => {
        createNewGameDialogVisit({ ...OPEN, now });

        expect(events('new-game-dialog-opened')).toEqual([OPEN]);
    });

    it('reports a shown batch with page, ids and timing', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        clock = 100;
        const settle = visit.batchStarted('open', PARAMS);
        clock = 350;
        settle(shown(
            [candidate('a1'), candidate('b2')],
            'unsplash',
            { page: 12, knownPages: 166, sourceKind: 'search', topic: '' },
        ));

        expect(events('image-candidates-loaded')).toEqual([{
            trigger: 'open',
            outcome: 'shown',
            cause: 'none',
            source: 'unsplash',
            count: 2,
            ms: 250,
            imageCategory: 'face',
            vibrant: false,
            custom: false,
            orientation: 'portrait',
            imagePage: 12,
            imagePagesKnown: 166,
            sourceKind: 'search',
            topic: '',
            photoIds: 'a1,b2',
        }]);
    });

    it('reports the topic of a topic batch, and no source for a failed one', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        visit.batchStarted('open', PARAMS)(shown(
            [candidate('t1')],
            'unsplash',
            { page: 3, knownPages: 596, sourceKind: 'topic', topic: 'film' },
        ));
        visit.batchStarted('refresh', PARAMS)({ candidates: [], cause: 'http-error', source: 'none' });

        expect(events('image-candidates-loaded')).toEqual([
            expect.objectContaining({ sourceKind: 'topic', topic: 'film' }),
            expect.objectContaining({ sourceKind: 'none', topic: '' }),
        ]);
    });

    it("reports a failed batch's draw from the result", () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        visit.batchStarted('open', PARAMS)({
            candidates: [],
            cause: 'empty-page',
            source: 'none',
            draw: { page: 1, knownPages: 0, sourceKind: 'topic', topic: 'film' },
        });

        expect(events('image-candidates-loaded')[0]).toMatchObject({
            outcome: 'empty',
            sourceKind: 'topic',
            topic: 'film',
            imagePage: 1,
            imagePagesKnown: 0,
        });
    });

    it('marks an earlier batch superseded when a newer one started', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        const settleA = visit.batchStarted('open', PARAMS);
        const settleB = visit.batchStarted('refresh', PARAMS);

        settleA(shown([candidate('a1')]));
        settleB(shown([candidate('b2')]));

        expect(events('image-candidates-loaded').map((e) => (e as { outcome: string }).outcome))
            .toEqual(['superseded', 'shown']);
    });

    it('keeps a superseded batch out of thumbnailsOffered and firstThumbnailsMs', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        const settleA = visit.batchStarted('open', PARAMS);
        const settleB = visit.batchStarted('refresh', PARAMS);
        clock = 200;
        settleA(shown(['a', 'b', 'c'].map((id) => candidate(id))));
        clock = 300;
        settleB(shown(['d', 'e'].map((id) => candidate(id))));
        visit.closed('cancel', -1, { imageCategory: 'face', vibrant: false });

        expect(events('new-game-dialog-closed')[0]).toMatchObject({ thumbnailsOffered: 2, firstThumbnailsMs: 300 });
    });

    it('marks a batch abandoned when the dialog closed first, and counts it', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        const settle = visit.batchStarted('open', PARAMS);
        visit.closed('surprise', -1, { imageCategory: 'face', vibrant: false });
        settle(shown([candidate('a1')]));

        expect(events('new-game-dialog-closed')[0]).toMatchObject({
            outcome: 'surprise',
            batches: 1,
            firstThumbnailsMs: -1,
            firstThumbnailLoadedMs: -1,
            thumbnailsOffered: 0,
        });
        expect(events('image-candidates-loaded')[0]).toMatchObject({ outcome: 'abandoned' });
    });

    it.each([
        ['threw', 'error'],
        ['http-error', 'error'],
        ['blocked', 'empty'],
        ['empty-page', 'empty'],
    ] as const)('maps cause %s with no photos to outcome %s', (cause, outcome) => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        visit.batchStarted('open', PARAMS)({ candidates: [], cause, source: 'none' });

        expect(events('image-candidates-loaded')[0]).toMatchObject({
            outcome,
            cause,
            source: 'none',
            count: 0,
            imagePage: 0,
            imagePagesKnown: 0,
            photoIds: '',
        });
    });

    it('reports a stash-served batch as shown from the stash', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        visit.batchStarted('open', PARAMS)({ candidates: [candidate('s1')], cause: 'http-error', source: 'stash' });

        expect(events('image-candidates-loaded')[0]).toMatchObject({
            outcome: 'shown',
            cause: 'http-error',
            source: 'stash',
            imagePage: 0,
            photoIds: 's1',
        });
    });

    it('summarizes the visit on close', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        clock = 50;
        const settle = visit.batchStarted('refresh', PARAMS);
        clock = 300;
        settle(shown(['a', 'b', 'c', 'd'].map((id) => candidate(id))));
        visit.optionChanged('category', 'face', 'nature');
        clock = 450;
        visit.thumbnailLoaded();
        clock = 500;
        visit.thumbnailLoaded();
        visit.thumbnailFailed(3, 'd', 'face');
        visit.offlineDownloadUsed();
        clock = 900;
        visit.closed('photo', 2, { imageCategory: 'nature', vibrant: true });

        expect(events('new-game-dialog-closed')).toEqual([{
            outcome: 'photo',
            openMs: 900,
            firstThumbnailsMs: 300,
            firstThumbnailLoadedMs: 450,
            pickedSlot: 2,
            refreshes: 1,
            optionChanges: 1,
            batches: 1,
            thumbnailsOffered: 4,
            thumbnailsLoaded: 2,
            thumbnailsFailed: 1,
            offlineDownloadUsed: true,
            imageCategory: 'nature',
            vibrant: true,
        }]);
    });

    it('rounds its timing fields to whole milliseconds', () => {
        clock = 0.2;
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        clock = 100.2;
        const settle = visit.batchStarted('open', PARAMS);
        clock = 350.9;
        settle(shown([candidate('a1')]));
        clock = 900.6;
        visit.closed('cancel', -1, { imageCategory: 'face', vibrant: false });

        expect(events('image-candidates-loaded')[0]).toMatchObject({ ms: 251 });
        expect(events('new-game-dialog-closed')[0]).toMatchObject({ openMs: 900, firstThumbnailsMs: 351 });
    });

    it('ignores a second close', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        visit.closed('cancel', -1, { imageCategory: 'face', vibrant: false });
        visit.closed('blank', -1, { imageCategory: 'face', vibrant: false });

        expect(events('new-game-dialog-closed')).toHaveLength(1);
    });

    it('reports option changes, thumbnail failures and picker credit taps', () => {
        const visit = createNewGameDialogVisit({ ...OPEN, now });
        visit.optionChanged('query', 'none', 'custom');
        visit.thumbnailFailed(3, 'a1', 'face');
        visit.creditOpened('a1');

        expect(events('image-option-changed')).toEqual([{ setting: 'query', from: 'none', to: 'custom' }]);
        expect(events('image-thumbnail-failed')).toEqual([{ slot: 3, photoId: 'a1', imageCategory: 'face' }]);
        expect(events('photo-credit-opened')).toEqual([{ where: 'picker', link: 'photographer', photoId: 'a1' }]);
    });
});
