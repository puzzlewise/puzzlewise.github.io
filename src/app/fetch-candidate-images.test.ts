/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../images/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../images/index.js')>()),
    fetchRandomPhotos: vi.fn(),
}));

vi.mock('../images/offline-stash.js', () => ({
    stashCandidates: vi.fn(),
}));

import { fetchRandomPhotos } from '../images/index.js';
import { stashCandidates } from '../images/offline-stash.js';
import { fetchCandidateImages, CANDIDATE_IMAGE_COUNT } from './fetch-candidate-images.js';

function makeResult(n: number) {
    return {
        imageUrl: `https://images.unsplash.com/photo-${n}?w=1080`,
        thumbUrl: `https://images.unsplash.com/photo-${n}?w=400`,
        width: 4000,
        height: 2667,
        photographerName: `Photographer ${n}`,
        photographerUrl: `https://unsplash.com/@p${n}`,
        photoUrl: `https://unsplash.com/photos/${n}`,
        downloadLocation: `https://api.unsplash.com/photos/${n}/download`,
        description: `photo ${n}`,
    };
}

describe('fetchCandidateImages', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.mocked(fetchRandomPhotos).mockReset();
        vi.mocked(stashCandidates).mockReset().mockResolvedValue([]);
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
    });

    it('maps results into candidates with 1080-scaled display size', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([makeResult(1), makeResult(2)]);

        const candidates = await fetchCandidateImages('https://proxy.example', 'nature', false, 'landscape');

        expect(candidates).toHaveLength(2);
        expect(candidates![0]).toEqual({
            imageUrl: 'https://images.unsplash.com/photo-1?w=1080',
            thumbUrl: 'https://images.unsplash.com/photo-1?w=400',
            imageSize: { width: 1080, height: Math.round(1080 * (2667 / 4000)) },
            attribution: {
                photographerName: 'Photographer 1',
                photographerUrl: 'https://unsplash.com/@p1',
                photoUrl: 'https://unsplash.com/photos/1',
            },
            downloadLocation: 'https://api.unsplash.com/photos/1/download',
            description: 'photo 1',
        });
    });

    it('keeps the page draw on each candidate', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([{ ...makeResult(1), pageDraw: { page: 12, knownPages: 166 } }]);

        const candidates = await fetchCandidateImages('https://proxy.example', 'nature', false, 'landscape');

        expect(candidates![0].pageDraw).toEqual({ page: 12, knownPages: 166 });
    });

    it('passes the category query, count, and orientation through', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([makeResult(1)]);

        await fetchCandidateImages('https://proxy.example', 'nature', true, 'portrait');

        expect(fetchRandomPhotos).toHaveBeenCalledWith(
            'https://proxy.example',
            CANDIDATE_IMAGE_COUNT,
            fetch,
            'nature vibrant colorful',
            'portrait',
            { caller: 'picker', imageCategory: 'nature', vibrant: true, custom: false },
        );
    });

    it('uses the query override in place of the category query', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([makeResult(1)]);

        await fetchCandidateImages('https://proxy.example', 'nature', false, 'landscape', 'red bicycles');

        expect(fetchRandomPhotos).toHaveBeenCalledWith(
            'https://proxy.example',
            CANDIDATE_IMAGE_COUNT,
            fetch,
            'red bicycles',
            'landscape',
            { caller: 'picker', imageCategory: 'nature', vibrant: false, custom: true },
        );
    });

    it('appends the vibrant terms to the query override', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([makeResult(1)]);

        await fetchCandidateImages('https://proxy.example', 'nature', true, 'portrait', 'red bicycles');

        expect(fetchRandomPhotos).toHaveBeenCalledWith(
            'https://proxy.example',
            CANDIDATE_IMAGE_COUNT,
            fetch,
            'red bicycles vibrant colorful',
            'portrait',
            { caller: 'picker', imageCategory: 'nature', vibrant: true, custom: true },
        );
    });

    it('falls back to the category query when the override is blank', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([makeResult(1)]);

        await fetchCandidateImages('https://proxy.example', 'nature', false, 'landscape', '   ');

        expect(fetchRandomPhotos).toHaveBeenCalledWith(
            'https://proxy.example',
            CANDIDATE_IMAGE_COUNT,
            fetch,
            'nature',
            'landscape',
            { caller: 'picker', imageCategory: 'nature', vibrant: false, custom: false },
        );
    });

    it('returns null when the fetch yields nothing', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);

        expect(await fetchCandidateImages('https://proxy.example', 'any', false, 'landscape')).toBeNull();
    });

    it('returns null when the fetch returns an empty array', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([]);

        expect(await fetchCandidateImages('https://proxy.example', 'any', false, 'landscape')).toBeNull();
    });

    it("returns null when the page's photos were all blocked", async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue('blocked');

        expect(await fetchCandidateImages('https://proxy.example', 'any', false, 'landscape')).toBeNull();
    });

    it('returns null and warns when the fetch throws', async () => {
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new Error('network down'));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await fetchCandidateImages('https://proxy.example', 'any', false, 'landscape')).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    const stashEntry = {
        imageUrl: 'https://images.unsplash.com/photo-stash?w=1080',
        thumbUrl: 'https://images.unsplash.com/photo-stash?w=400',
        imageSize: { width: 1080, height: 720 },
        attribution: {
            photographerName: 'Ada',
            photographerUrl: 'https://u.example/ada',
            photoUrl: 'https://p.example/1',
        },
        downloadLocation: 'https://api.unsplash.com/photos/stash/download',
        orientation: 'landscape' as const,
    };

    it('serves stash candidates when the fetch throws', async () => {
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new Error('network down'));
        vi.mocked(stashCandidates).mockResolvedValue([stashEntry]);
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const candidates = await fetchCandidateImages('https://proxy.example', 'nature', true, 'landscape');

        expect(candidates).toEqual([stashEntry]);
        expect(vi.mocked(stashCandidates)).toHaveBeenCalledWith('landscape', CANDIDATE_IMAGE_COUNT);
        expect(umamiTrack).toHaveBeenCalledWith('image-stash-fallback', {
            imageCategory: 'nature',
            orientation: 'landscape',
            vibrant: true,
            hit: true,
            cause: 'fetch-failed',
        });
    });

    it('serves stash candidates when the fetch yields nothing', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);
        vi.mocked(stashCandidates).mockResolvedValue([stashEntry]);

        expect(await fetchCandidateImages('https://proxy.example', 'any', false, 'landscape'))
            .toEqual([stashEntry]);
    });

    it('reports a stash miss when the fetch fails and the stash is empty', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);

        expect(await fetchCandidateImages('https://proxy.example', 'any', false, 'portrait')).toBeNull();
        expect(umamiTrack).toHaveBeenCalledWith('image-stash-fallback', {
            imageCategory: 'any',
            orientation: 'portrait',
            vibrant: false,
            hit: false,
            cause: 'no-candidates',
        });
    });

    it('does not consult the stash when the fetch succeeds', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([makeResult(1)]);

        await fetchCandidateImages('https://proxy.example', 'any', false, 'landscape');

        expect(vi.mocked(stashCandidates)).not.toHaveBeenCalled();
    });
});
