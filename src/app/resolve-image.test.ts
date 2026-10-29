/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../images/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../images/index.js')>()),
    fetchRandomPhotos: vi.fn(),
}));

vi.mock('../images/backup-pool.js', () => ({
    resolveFromPool: vi.fn(),
}));

vi.mock('../images/offline-stash.js', () => ({
    pickStashImage: vi.fn(),
}));

import { fetchRandomPhotos } from '../images/index.js';
import { resolveFromPool } from '../images/backup-pool.js';
import { pickStashImage } from '../images/offline-stash.js';
import { GenerationCanceledError } from '../game/index.js';
import { resolveUnsplashImage } from './resolve-image.js';

describe('resolveUnsplashImage', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveFromPool).mockReturnValue(null);
        vi.mocked(pickStashImage).mockResolvedValue(null);
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
        vi.restoreAllMocks();
    });

    it('maps a fetched photo into a ResolvedImage and reports nothing', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([{
            imageUrl: 'https://images.example/photo',
            width: 2000,
            height: 1000,
            photographerName: 'Ada',
            photographerUrl: 'https://u.example/ada',
            photoUrl: 'https://p.example/1',
            thumbUrl: 'https://images.unsplash.com/photo-abc?w=400',
            downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
        }]);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'any', false, 'landscape');

        expect(resolved).toEqual({
            imageUrl: 'https://images.example/photo',
            imageSize: { width: 1080, height: 540 },
            attribution: {
                photographerName: 'Ada',
                photographerUrl: 'https://u.example/ada',
                photoUrl: 'https://p.example/1',
            },
            downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
        });
        expect(resolved!.downloadLocation).toBe(
            'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
        );
        expect(umamiTrack).not.toHaveBeenCalled();
    });

    it('keeps the page draw on the resolved image', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([{
            imageUrl: 'https://images.example/photo',
            width: 2000,
            height: 1000,
            photographerName: 'Ada',
            photographerUrl: 'https://u.example/ada',
            photoUrl: 'https://p.example/1',
            thumbUrl: 'https://images.unsplash.com/photo-abc?w=400',
            downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
            pageDraw: { page: 7, knownPages: 0, sourceKind: 'search', topic: '' },
        }]);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'nature', false, 'landscape');

        expect(resolved!.pageDraw).toEqual({ page: 7, knownPages: 0, sourceKind: 'search', topic: '' });
    });

    it('uses the query override in place of the category query', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([{
            imageUrl: 'https://images.example/photo',
            width: 2000,
            height: 1000,
            photographerName: 'Ada',
            photographerUrl: 'https://u.example/ada',
            photoUrl: 'https://p.example/1',
            thumbUrl: 'https://images.unsplash.com/photo-abc?w=400',
            downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
        }]);

        await resolveUnsplashImage('https://proxy.example', 'nature', false, 'landscape', undefined, 'red bicycles');

        expect(fetchRandomPhotos).toHaveBeenCalledWith(
            'https://proxy.example', 1, fetch, 'red bicycles', 'landscape',
            { caller: 'surprise', imageCategory: 'nature', vibrant: false, custom: true },
            { signal: undefined },
        );
    });

    it('appends the vibrant terms to the query override', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([{
            imageUrl: 'https://images.example/photo',
            width: 2000,
            height: 1000,
            photographerName: 'Ada',
            photographerUrl: 'https://u.example/ada',
            photoUrl: 'https://p.example/1',
            thumbUrl: 'https://images.unsplash.com/photo-abc?w=400',
            downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
        }]);

        await resolveUnsplashImage('https://proxy.example', 'nature', true, 'portrait', undefined, 'red bicycles');

        expect(fetchRandomPhotos).toHaveBeenCalledWith(
            'https://proxy.example', 1, fetch, 'red bicycles vibrant colorful', 'portrait',
            { caller: 'surprise', imageCategory: 'nature', vibrant: true, custom: true },
            { signal: undefined },
        );
    });

    it('keys the pool fallback on the selected category, not the override', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);

        await resolveUnsplashImage('https://proxy.example', 'nature', false, 'landscape', undefined, 'red bicycles');

        expect(vi.mocked(resolveFromPool)).toHaveBeenCalledWith('nature', false, 'landscape');
    });

    it('serves a pool image and reports a hit when the proxy refuses (HTTP error)', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);
        const poolImage = {
            imageUrl: 'https://images.unsplash.com/photo-pool',
            imageSize: { width: 1080, height: 720 },
            attribution: {
                photographerName: 'Ada',
                photographerUrl: 'https://u.example/ada',
                photoUrl: 'https://p.example/1',
            },
            downloadLocation: 'https://api.unsplash.com/photos/pool/download',
        };
        vi.mocked(resolveFromPool).mockReturnValue(poolImage);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'nature', true, 'landscape');

        expect(resolved).toEqual(poolImage);
        expect(vi.mocked(resolveFromPool)).toHaveBeenCalledWith('nature', true, 'landscape');
        expect(umamiTrack).toHaveBeenCalledWith('image-pool-fallback', {
            imageCategory: 'nature',
            orientation: 'landscape',
            vibrant: true,
            hit: true,
            cause: 'http-error',
        });
    });

    it("reports cause 'blocked' when the page's photos were all by blocked photographers", async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue('blocked');
        vi.mocked(resolveFromPool).mockReturnValue(null);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'face', false, 'landscape');

        expect(resolved).toBeNull();
        expect(umamiTrack).toHaveBeenCalledWith('image-pool-fallback', {
            imageCategory: 'face',
            orientation: 'landscape',
            vibrant: false,
            hit: false,
            cause: 'blocked',
        });
    });

    it("reports cause 'empty' when the page held no photos", async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([]);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'face', false, 'landscape');

        expect(resolved).toBeNull();
        expect(umamiTrack).toHaveBeenCalledWith('image-pool-fallback', {
            imageCategory: 'face',
            orientation: 'landscape',
            vibrant: false,
            hit: false,
            cause: 'empty',
        });
    });

    it('returns null and reports a miss when the matching bucket is empty', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);
        vi.mocked(resolveFromPool).mockReturnValue(null);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'astronomy', false, 'portrait');

        expect(resolved).toBeNull();
        expect(umamiTrack).toHaveBeenCalledWith('image-pool-fallback', {
            imageCategory: 'astronomy',
            orientation: 'portrait',
            vibrant: false,
            hit: false,
            cause: 'http-error',
        });
    });

    it('reports image-fetch-failed and returns null when the fetch throws', async () => {
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new Error('network down'));

        const resolved = await resolveUnsplashImage('https://proxy.example', 'any', false, 'landscape');

        expect(resolved).toBeNull();
        expect(umamiTrack).toHaveBeenCalledWith('image-fetch-failed', {
            reason: 'network down',
            orientation: 'landscape',
            imageCategory: 'any',
        });
    });

    it('forwards orientation to fetchRandomPhotos and scales a portrait photo', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue([{
            imageUrl: 'https://images.example/portrait',
            width: 2000,
            height: 3000,
            photographerName: 'Ada',
            photographerUrl: 'https://u.example/ada',
            photoUrl: 'https://p.example/1',
            thumbUrl: 'https://images.unsplash.com/photo-abc?w=400',
            downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
        }]);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'any', false, 'portrait');

        expect(vi.mocked(fetchRandomPhotos).mock.calls[0][4]).toBe('portrait');
        // 1080 wide, height derived from the 2:3 portrait aspect.
        expect(resolved?.imageSize).toEqual({ width: 1080, height: 1620 });
    });

    it('forwards the abort signal to fetchRandomPhotos', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);
        const { signal } = new AbortController();

        await resolveUnsplashImage('https://proxy.example', 'any', false, 'landscape', signal);

        expect(vi.mocked(fetchRandomPhotos).mock.calls[0][6]).toEqual({ signal });
    });

    it('throws GenerationCanceledError when the fetch is aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new DOMException('Aborted', 'AbortError'));

        await expect(
            resolveUnsplashImage('https://proxy.example', 'any', false, 'landscape', controller.signal),
        ).rejects.toBeInstanceOf(GenerationCanceledError);
    });

    it('keys cancellation off the aborted signal, not the error type', async () => {
        const controller = new AbortController();
        controller.abort();
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new Error('network down'));

        await expect(
            resolveUnsplashImage('https://proxy.example', 'any', false, 'landscape', controller.signal),
        ).rejects.toBeInstanceOf(GenerationCanceledError);
    });

    const stashImage = {
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

    it('serves a stash image when the pool also misses', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);
        vi.mocked(pickStashImage).mockResolvedValue(stashImage);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'nature', true, 'landscape');

        expect(resolved).toBe(stashImage);
        expect(vi.mocked(pickStashImage)).toHaveBeenCalledWith('landscape');
        expect(umamiTrack).toHaveBeenCalledWith('image-stash-fallback', {
            imageCategory: 'nature',
            orientation: 'landscape',
            vibrant: true,
            hit: true,
            cause: 'pool-miss',
        });
    });

    it('serves a stash image when the fetch throws', async () => {
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new Error('network down'));
        vi.mocked(pickStashImage).mockResolvedValue(stashImage);

        const resolved = await resolveUnsplashImage('https://proxy.example', 'any', false, 'landscape');

        expect(resolved).toBe(stashImage);
        expect(umamiTrack).toHaveBeenCalledWith('image-fetch-failed', {
            reason: 'network down',
            orientation: 'landscape',
            imageCategory: 'any',
        });
        expect(umamiTrack).toHaveBeenCalledWith('image-stash-fallback', {
            imageCategory: 'any',
            orientation: 'landscape',
            vibrant: false,
            hit: true,
            cause: 'fetch-failed',
        });
    });

    it('reports a stash miss when the fetch throws and the stash is empty', async () => {
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new Error('network down'));

        const resolved = await resolveUnsplashImage('https://proxy.example', 'any', false, 'portrait');

        expect(resolved).toBeNull();
        expect(umamiTrack).toHaveBeenCalledWith('image-stash-fallback', {
            imageCategory: 'any',
            orientation: 'portrait',
            vibrant: false,
            hit: false,
            cause: 'fetch-failed',
        });
    });

    it('does not consult the stash when the pool covers the failure', async () => {
        vi.mocked(fetchRandomPhotos).mockResolvedValue(undefined);
        vi.mocked(resolveFromPool).mockReturnValue({
            imageUrl: 'https://images.unsplash.com/photo-pool',
            imageSize: { width: 1080, height: 720 },
            attribution: {
                photographerName: 'Ada',
                photographerUrl: 'https://u.example/ada',
                photoUrl: 'https://p.example/1',
            },
            downloadLocation: 'https://api.unsplash.com/photos/pool/download',
        });

        await resolveUnsplashImage('https://proxy.example', 'nature', true, 'landscape');

        expect(vi.mocked(pickStashImage)).not.toHaveBeenCalled();
    });

    it('does not report image-fetch-failed when the fetch is aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        vi.mocked(fetchRandomPhotos).mockRejectedValue(new DOMException('Aborted', 'AbortError'));

        await resolveUnsplashImage('https://proxy.example', 'any', false, 'landscape', controller.signal)
            .catch(() => {});

        expect(umamiTrack).not.toHaveBeenCalled();
    });
});
