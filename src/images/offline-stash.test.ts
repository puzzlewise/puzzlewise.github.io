/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    OFFLINE_STASH_COUNT,
    OFFLINE_STASH_KEY,
    downloadOfflineImages,
    loadStash,
    pickStashImage,
    stashCandidates,
    stashCount,
    type StashedImage,
} from './offline-stash.js';
import { OFFLINE_STASH_CACHE } from './offline-stash-cache.js';

const CTX = { caller: 'stash', imageCategory: 'nature', vibrant: false, custom: false } as const;
const PROXY = 'https://proxy.example.com';

function makePhoto(n: number) {
    return {
        urls: {
            regular: `https://images.unsplash.com/photo-${n}?w=1080`,
            full: `https://images.unsplash.com/photo-${n}`,
            small: `https://images.unsplash.com/photo-${n}?w=400`,
        },
        width: 4000,
        height: 3000,
        user: {
            name: `Photographer ${n}`,
            links: { html: `https://unsplash.com/@user${n}` },
        },
        links: {
            html: `https://unsplash.com/photos/p${n}`,
            download_location: `https://api.unsplash.com/photos/p${n}/download`,
        },
        alt_description: `Photo ${n}`,
    };
}

function makeStashedImage(n: number, orientation: 'landscape' | 'portrait' = 'landscape'): StashedImage {
    return {
        imageUrl: `https://images.unsplash.com/photo-${n}?w=1080`,
        thumbUrl: `https://images.unsplash.com/photo-${n}?w=400`,
        imageSize: { width: 1080, height: 810 },
        attribution: {
            photographerName: `Photographer ${n}`,
            photographerUrl: `https://unsplash.com/@user${n}?utm_source=puzzle&utm_medium=referral`,
            photoUrl: `https://unsplash.com/photos/p${n}?utm_source=puzzle&utm_medium=referral`,
        },
        downloadLocation: `https://api.unsplash.com/photos/p${n}/download`,
        description: `Photo ${n}`,
        orientation,
    };
}

function writeStash(images: StashedImage[], previous: StashedImage[] = []): void {
    localStorage.setItem(OFFLINE_STASH_KEY, JSON.stringify({ v: 1, images, previous }));
}

interface FakeCacheStore {
    caches: CacheStorage;
    entries: Map<string, unknown>;
}

function makeFakeCaches(): FakeCacheStore {
    const entries = new Map<string, unknown>();
    const cache = {
        put: async (url: string, response: unknown) => {
            entries.set(url, response);
        },
        match: async (url: string) => entries.get(url),
        keys: async () => [...entries.keys()].map((url) => ({ url })),
        delete: async (url: string) => entries.delete(url),
    };
    return {
        caches: {
            open: async (name: string) => {
                expect(name).toBe(OFFLINE_STASH_CACHE);
                return cache;
            },
        } as unknown as CacheStorage,
        entries,
    };
}

/**
 * Routes the three URL families the download flow hits: the proxy page
 * request, the CDN blob fetches, and the download pings.
 */
function makeDownloadFetch(photos: unknown[], failUrls: string[] = []) {
    return vi.fn(async (url: string) => {
        if (failUrls.includes(url)) {
            return { ok: false, status: 500 };
        }
        if (url.startsWith(`${PROXY}/search`)) {
            return {
                ok: true,
                headers: new Headers(),
                json: async () => ({ total: photos.length, total_pages: 1, results: photos }),
            };
        }
        if (url.startsWith(`${PROXY}/topics/`)) {
            return {
                ok: true,
                headers: new Headers({ 'x-total': String(photos.length) }),
                json: async () => photos,
            };
        }
        return { ok: true };
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

beforeEach(() => {
    localStorage.clear();
});

describe('downloadOfflineImages', () => {
    it('stores one stash entry per downloaded photo', async () => {
        const photos = [makePhoto(1), makePhoto(2)];
        const { caches } = makeFakeCaches();
        const fetchFn = makeDownloadFetch(photos);

        const { saved } = await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: 'nature',
            orientation: 'landscape',
            fetchFn,
            cacheStorage: caches,
        });

        expect(saved).toBe(2);
        const stash = loadStash();
        expect(stash).toHaveLength(2);
        expect(stash).toEqual(expect.arrayContaining([makeStashedImage(1), makeStashedImage(2)]));
    });

    it('requests one page of search results through the proxy and keeps OFFLINE_STASH_COUNT', async () => {
        const fetchFn = makeDownloadFetch(Array.from({ length: 30 }, (_, i) => makePhoto(i + 1)));

        await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: 'nature',
            orientation: 'portrait',
            fetchFn,
            cacheStorage: makeFakeCaches().caches,
        });

        const batchUrl = String(fetchFn.mock.calls[0][0]);
        expect(batchUrl).toContain(`${PROXY}/search?`);
        expect(batchUrl).toContain('query=nature');
        expect(batchUrl).toContain('orientation=portrait');
        expect(loadStash()).toHaveLength(OFFLINE_STASH_COUNT);
    });

    it('caches the full image and the thumbnail under their URLs', async () => {
        const photo = makePhoto(1);
        const { caches, entries } = makeFakeCaches();

        await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn: makeDownloadFetch([photo]),
            cacheStorage: caches,
        });

        expect(entries.has(photo.urls.regular)).toBe(true);
        expect(entries.has(photo.urls.small)).toBe(true);
    });

    it('reports each stored photo as a download to Unsplash', async () => {
        const photos = [makePhoto(1), makePhoto(2)];
        const fetchFn = makeDownloadFetch(photos);

        await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn,
            cacheStorage: makeFakeCaches().caches,
        });

        const downloadPings = fetchFn.mock.calls
            .map((call) => String(call[0]))
            .filter((url) => url.startsWith(`${PROXY}/download`));
        expect(downloadPings).toHaveLength(2);
        expect(downloadPings).toEqual(expect.arrayContaining([
            expect.stringContaining(encodeURIComponent('https://api.unsplash.com/photos/p1/download')),
            expect.stringContaining(encodeURIComponent('https://api.unsplash.com/photos/p2/download')),
        ]));
    });

    it('reports progress after each photo', async () => {
        const onProgress = vi.fn();

        await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            onProgress,
            fetchFn: makeDownloadFetch([makePhoto(1), makePhoto(2)]),
            cacheStorage: makeFakeCaches().caches,
        });

        expect(onProgress.mock.calls).toEqual([[1, 2], [2, 2]]);
    });

    it('keeps the existing stash when the batch request fails', async () => {
        writeStash([makeStashedImage(9)]);
        const fetchFn = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

        const { saved } = await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn,
            cacheStorage: makeFakeCaches().caches,
        });

        expect(saved).toBe(0);
        expect(loadStash()).toHaveLength(1);
    });

    it('keeps the existing stash when the batch request throws', async () => {
        writeStash([makeStashedImage(9)]);
        const fetchFn = vi.fn(async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;

        const { saved } = await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn,
            cacheStorage: makeFakeCaches().caches,
        });

        expect(saved).toBe(0);
        expect(loadStash()).toHaveLength(1);
    });

    it('skips a photo whose full-size download fails', async () => {
        const photos = [makePhoto(1), makePhoto(2)];

        const { saved } = await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn: makeDownloadFetch(photos, [photos[0].urls.regular]),
            cacheStorage: makeFakeCaches().caches,
        });

        expect(saved).toBe(1);
        expect(loadStash().map((entry) => entry.imageUrl)).toEqual([photos[1].urls.regular]);
    });

    it('keeps a photo whose thumbnail download fails', async () => {
        const photo = makePhoto(1);

        const { saved } = await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn: makeDownloadFetch([photo], [photo.urls.small]),
            cacheStorage: makeFakeCaches().caches,
        });

        expect(saved).toBe(1);
    });

    it('retains the previous generation in the cache and prunes older ones', async () => {
        const { caches, entries } = makeFakeCaches();
        const genA = makeStashedImage(101);
        const genB = makeStashedImage(102);
        writeStash([genB], [genA]);
        entries.set(genA.imageUrl, 'blob-a');
        entries.set(genA.thumbUrl, 'thumb-a');
        entries.set(genB.imageUrl, 'blob-b');
        entries.set(genB.thumbUrl, 'thumb-b');

        await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn: makeDownloadFetch([makePhoto(1)]),
            cacheStorage: caches,
        });

        expect(entries.has(genA.imageUrl)).toBe(false);
        expect(entries.has(genA.thumbUrl)).toBe(false);
        expect(entries.has(genB.imageUrl)).toBe(true);
        expect(loadStash()).toHaveLength(1);
    });

    it('reports why a zero save happened', async () => {
        const threw = vi.fn(async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch;
        await expect(downloadOfflineImages({
            proxyBaseUrl: PROXY, context: CTX, query: undefined, orientation: 'landscape',
            fetchFn: threw, cacheStorage: makeFakeCaches().caches,
        })).resolves.toEqual({ saved: 0, reason: 'batch-threw' });

        await expect(downloadOfflineImages({
            proxyBaseUrl: PROXY, context: CTX, query: undefined, orientation: 'landscape',
            fetchFn: makeDownloadFetch([makePhoto(1)]), cacheStorage: undefined,
        })).resolves.toEqual({ saved: 0, reason: 'cache-unavailable' });

        const empty = makeDownloadFetch([]);
        await expect(downloadOfflineImages({
            proxyBaseUrl: PROXY, context: CTX, query: undefined, orientation: 'landscape',
            fetchFn: empty, cacheStorage: makeFakeCaches().caches,
        })).resolves.toEqual({ saved: 0, reason: 'batch-empty' });

        const photo = makePhoto(2);
        await expect(downloadOfflineImages({
            proxyBaseUrl: PROXY, context: CTX, query: undefined, orientation: 'landscape',
            fetchFn: makeDownloadFetch([photo], [photo.urls.regular]),
            cacheStorage: makeFakeCaches().caches,
        })).resolves.toEqual({ saved: 0, reason: 'no-photos' });
    });

    it('reports a write failure after photos were fetched', async () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(downloadOfflineImages({
            proxyBaseUrl: PROXY, context: CTX, query: undefined, orientation: 'landscape',
            fetchFn: makeDownloadFetch([makePhoto(1)]), cacheStorage: makeFakeCaches().caches,
        })).resolves.toEqual({ saved: 0, reason: 'write-failed' });

        setItem.mockRestore();
        vi.restoreAllMocks();
    });

    it('drops the orphaned blobs but keeps the previous generation on a write failure', async () => {
        const prev = makeStashedImage(9);
        writeStash([prev]);
        const { caches, entries } = makeFakeCaches();
        entries.set(prev.imageUrl, 'blob-prev');
        entries.set(prev.thumbUrl, 'thumb-prev');
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
            if (key === OFFLINE_STASH_KEY) throw new Error('quota');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const photo = makePhoto(1);
        await expect(downloadOfflineImages({
            proxyBaseUrl: PROXY, context: CTX, query: undefined, orientation: 'landscape',
            fetchFn: makeDownloadFetch([photo]), cacheStorage: caches,
        })).resolves.toEqual({ saved: 0, reason: 'write-failed' });

        expect(entries.has(photo.urls.regular)).toBe(false);
        expect(entries.has(photo.urls.small)).toBe(false);
        expect(entries.has(prev.imageUrl)).toBe(true);
        expect(entries.has(prev.thumbUrl)).toBe(true);

        setItem.mockRestore();
        vi.restoreAllMocks();
    });

    it('still reports a successful save when pruning the cache throws', async () => {
        const entries = new Map<string, unknown>();
        const cache = {
            put: async (url: string, response: unknown) => { entries.set(url, response); },
            match: async (url: string) => entries.get(url),
            keys: async () => { throw new Error('cache keys unavailable'); },
            delete: async (url: string) => entries.delete(url),
        };
        const caches = { open: async () => cache } as unknown as CacheStorage;
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(downloadOfflineImages({
            proxyBaseUrl: PROXY, context: CTX, query: undefined, orientation: 'landscape',
            fetchFn: makeDownloadFetch([makePhoto(1)]), cacheStorage: caches,
        })).resolves.toEqual({ saved: 1, reason: 'saved' });
        expect(loadStash()).toHaveLength(1);

        vi.restoreAllMocks();
    });

    it('collapses duplicate photos from the batch into one stash entry', async () => {
        const { caches, entries } = makeFakeCaches();

        const { saved } = await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn: makeDownloadFetch([makePhoto(1), makePhoto(1)]),
            cacheStorage: caches,
        });

        expect(saved).toBe(1);
        expect(loadStash()).toHaveLength(1);
        expect(entries.size).toBe(2);
    });

    it('returns 0 when the cache storage is unavailable', async () => {
        writeStash([makeStashedImage(9)]);

        const { saved } = await downloadOfflineImages({
            proxyBaseUrl: PROXY,
            context: CTX,
            query: undefined,
            orientation: 'landscape',
            fetchFn: makeDownloadFetch([makePhoto(1)]),
            cacheStorage: undefined,
        });

        expect(saved).toBe(0);
        expect(loadStash()).toHaveLength(1);
    });
});

describe('loadStash', () => {
    it('returns an empty stash for corrupt metadata', () => {
        localStorage.setItem(OFFLINE_STASH_KEY, '{not json');

        expect(loadStash()).toEqual([]);
    });

    it('returns an empty stash for a well-formed record with invalid entries', () => {
        localStorage.setItem(
            OFFLINE_STASH_KEY,
            JSON.stringify({ v: 1, images: [{ imageUrl: 42 }], previous: [] }),
        );

        expect(loadStash()).toEqual([]);
    });

    it('does not let a mutated empty result leak into the next load', () => {
        loadStash().push(makeStashedImage(1));

        expect(loadStash()).toEqual([]);
    });
});

/** A fake cache holding a blob under each given entry's `imageUrl`. */
function cacheWith(...images: StashedImage[]): CacheStorage {
    const { caches, entries } = makeFakeCaches();
    for (const image of images) entries.set(image.imageUrl, 'blob');
    return caches;
}

describe('pickStashImage', () => {
    it('returns null when the stash is empty', async () => {
        expect(await pickStashImage('landscape', Math.random, cacheWith())).toBeNull();
    });

    it('prefers an image matching the requested orientation', async () => {
        const images = [makeStashedImage(1, 'portrait'), makeStashedImage(2, 'landscape')];
        writeStash(images);

        expect((await pickStashImage('landscape', () => 0, cacheWith(...images)))?.imageUrl)
            .toBe(makeStashedImage(2).imageUrl);
    });

    it('falls back to any orientation when none matches', async () => {
        const images = [makeStashedImage(1, 'portrait')];
        writeStash(images);

        expect((await pickStashImage('landscape', () => 0, cacheWith(...images)))?.imageUrl)
            .toBe(makeStashedImage(1).imageUrl);
    });

    it('skips an entry whose blob was evicted from the cache', async () => {
        writeStash([makeStashedImage(1, 'landscape'), makeStashedImage(2, 'landscape')]);
        // Seed 0 orders #2 ahead of #1, but only #1's blob survives.
        const cache = cacheWith(makeStashedImage(1));

        expect((await pickStashImage('landscape', () => 0, cache))?.imageUrl)
            .toBe(makeStashedImage(1).imageUrl);
    });

    it('returns null when the only entry has lost its blob', async () => {
        writeStash([makeStashedImage(1, 'landscape')]);

        expect(await pickStashImage('landscape', () => 0, cacheWith())).toBeNull();
    });
});

describe('stashCandidates', () => {
    it('returns up to the requested number of distinct entries', async () => {
        const images = [makeStashedImage(1), makeStashedImage(2), makeStashedImage(3)];
        writeStash(images);

        const candidates = await stashCandidates('landscape', 2, Math.random, cacheWith(...images));

        expect(candidates).toHaveLength(2);
        expect(new Set(candidates.map((c) => c.imageUrl)).size).toBe(2);
    });

    it('lists entries matching the requested orientation first', async () => {
        const images = [makeStashedImage(1, 'portrait'), makeStashedImage(2, 'landscape')];
        writeStash(images);

        const candidates = await stashCandidates('landscape', 4, () => 0, cacheWith(...images));

        expect(candidates.map((c) => c.imageUrl)).toEqual([
            makeStashedImage(2).imageUrl,
            makeStashedImage(1).imageUrl,
        ]);
    });

    it('omits entries whose blob was evicted from the cache', async () => {
        const present = [makeStashedImage(1), makeStashedImage(3)];
        writeStash([makeStashedImage(1), makeStashedImage(2), makeStashedImage(3)]);
        const cache = cacheWith(...present);

        const candidates = await stashCandidates('landscape', 4, () => 0, cache);

        expect(candidates.map((c) => c.imageUrl).sort())
            .toEqual(present.map((image) => image.imageUrl).sort());
    });
});

describe('stashCount', () => {
    it('counts only the current generation', () => {
        writeStash([makeStashedImage(1)], [makeStashedImage(2)]);

        expect(stashCount()).toBe(1);
    });
});
