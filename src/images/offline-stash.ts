/**
 * Player-triggered offline image stash: a batch of Unsplash photos downloaded
 * ahead of going offline, so new puzzles can still start on real photos.
 *
 * Blobs are cached under their real `images.unsplash.com` URLs and served by a
 * cache-first service-worker route (`src/pwa/sw.ts`), so saves, share links,
 * attribution, and image-source analytics treat a stashed photo exactly like a
 * network one. The metadata below keeps the previous generation alongside the
 * current one: pruning it on refresh would evict the image under a puzzle
 * created from the last stash, breaking its offline reload.
 */

import { diagnostics } from '../diagnostics.js';
import type { Orientation } from '../model/types.js';
import { OFFLINE_STASH_CACHE } from './offline-stash-cache.js';
import { toDisplayImage, type CandidateImage } from './unsplash-display-image.js';
import { fetchRandomPhotos, triggerPhotoDownload, type PhotoRequestContext } from './unsplash.js';
import { shuffled } from './shuffled.js';

export const OFFLINE_STASH_KEY = 'puzzle-offline-image-stash';

export const OFFLINE_STASH_COUNT = 8;

export interface StashedImage extends CandidateImage {
    orientation: Orientation;
}

interface StashRecord {
    v: 1;
    images: StashedImage[];
    previous: StashedImage[];
}

function emptyRecord(): StashRecord {
    return { v: 1, images: [], previous: [] };
}

function isStashedImage(value: unknown): value is StashedImage {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Record<string, unknown>;
    const attribution = entry.attribution as Record<string, unknown> | undefined;
    const imageSize = entry.imageSize as Record<string, unknown> | undefined;
    return (
        typeof entry.imageUrl === 'string'
        && typeof entry.thumbUrl === 'string'
        && typeof entry.downloadLocation === 'string'
        && (entry.orientation === 'landscape' || entry.orientation === 'portrait')
        && (entry.description === undefined || typeof entry.description === 'string')
        && typeof imageSize === 'object' && imageSize !== null
        && typeof imageSize.width === 'number'
        && typeof imageSize.height === 'number'
        && typeof attribution === 'object' && attribution !== null
        && typeof attribution.photographerName === 'string'
        && typeof attribution.photographerUrl === 'string'
        && typeof attribution.photoUrl === 'string'
    );
}

function loadRecord(): StashRecord {
    const raw = localStorage.getItem(OFFLINE_STASH_KEY);
    if (raw === null) return emptyRecord();

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return emptyRecord();
    }

    if (typeof parsed !== 'object' || parsed === null) return emptyRecord();
    const record = parsed as Record<string, unknown>;
    if (
        record.v !== 1
        || !Array.isArray(record.images)
        || !Array.isArray(record.previous)
        || !record.images.every(isStashedImage)
        || !record.previous.every(isStashedImage)
    ) {
        return emptyRecord();
    }

    return { v: 1, images: record.images, previous: record.previous };
}

export function loadStash(): StashedImage[] {
    return loadRecord().images;
}

export function stashCount(): number {
    return loadStash().length;
}

export function isOfflineStashSupported(): boolean {
    return globalThis.caches !== undefined;
}

function byOrientation(
    images: readonly StashedImage[],
    orientation: Orientation,
    random: () => number,
): StashedImage[] {
    const matching = images.filter((image) => image.orientation === orientation);
    const rest = images.filter((image) => image.orientation !== orientation);
    return [...shuffled(matching, random), ...shuffled(rest, random)];
}

async function openStashCache(
    cacheStorage: CacheStorage | undefined,
): Promise<Cache | undefined> {
    if (cacheStorage === undefined) return undefined;
    try {
        return await cacheStorage.open(OFFLINE_STASH_CACHE);
    } catch {
        return undefined;
    }
}

/**
 * The localStorage metadata and the Cache API blobs can diverge: a browser can
 * evict the cache (or a user clears "cached images") while the metadata record
 * survives. Serving such an entry would render an SVG `<image>` at a URL the
 * cache-first route can no longer satisfy — a broken puzzle offline, worse than
 * the bundled fallback the empty-stash path already gives. So confirm each
 * entry's blob is actually present before offering it, which also keeps the
 * `image-stash-fallback` `hit` flag honest.
 */
export async function pickStashImage(
    orientation: Orientation,
    random: () => number = Math.random,
    cacheStorage: CacheStorage | undefined = globalThis.caches,
): Promise<StashedImage | null> {
    const cache = await openStashCache(cacheStorage);
    if (cache === undefined) return null;
    for (const image of byOrientation(loadStash(), orientation, random)) {
        if (await cache.match(image.imageUrl)) return image;
    }
    return null;
}

export async function stashCandidates(
    orientation: Orientation,
    count: number,
    random: () => number = Math.random,
    cacheStorage: CacheStorage | undefined = globalThis.caches,
): Promise<StashedImage[]> {
    const cache = await openStashCache(cacheStorage);
    if (cache === undefined) return [];
    const present: StashedImage[] = [];
    for (const image of byOrientation(loadStash(), orientation, random)) {
        if (await cache.match(image.imageUrl)) {
            present.push(image);
            if (present.length === count) break;
        }
    }
    return present;
}

export interface DownloadOfflineImagesOptions {
    proxyBaseUrl: string;
    context: PhotoRequestContext;
    query: string | undefined;
    orientation: Orientation;
    onProgress?: (done: number, total: number) => void;
    fetchFn?: typeof fetch;
    cacheStorage?: CacheStorage;
}

/**
 * Why the download settled the way it did. Every `saved: 0` path carries a
 * distinct reason so a production `offline-images-saved` spike is triageable:
 * `batch-threw` is the benign offline tap (the fetch threw); `batch-empty`
 * (proxy HTTP error, or a page with no usable photo) and `no-photos` (the batch
 * returned photos but every blob fetch failed) point at the proxy/CDN;
 * `cache-unavailable` and `write-failed` are a real client fault (the Cache
 * API or localStorage failing). `diagnostics.warn`, the only other signal,
 * never runs in production builds.
 */
export type OfflineDownloadReason =
    | 'saved'
    | 'cache-unavailable'
    | 'batch-threw'
    | 'batch-empty'
    | 'no-photos'
    | 'write-failed';

export interface OfflineDownloadResult {
    saved: number;
    reason: OfflineDownloadReason;
}

/**
 * Reports each saved photo as an Unsplash download here, at the moment the raw
 * file is actually fetched — the puzzle it later starts is created offline,
 * where the usual use-time report cannot reach Unsplash. `saved: 0` leaves the
 * stash as it was; `reason` says why.
 */
export async function downloadOfflineImages(
    options: DownloadOfflineImagesOptions,
): Promise<OfflineDownloadResult> {
    const {
        proxyBaseUrl,
        context,
        query,
        orientation,
        onProgress,
        fetchFn = fetch,
        cacheStorage = globalThis.caches,
    } = options;

    if (cacheStorage === undefined) return { saved: 0, reason: 'cache-unavailable' };

    let results;
    try {
        results = await fetchRandomPhotos(
            proxyBaseUrl,
            OFFLINE_STASH_COUNT,
            fetchFn,
            query,
            orientation,
            context,
        );
    } catch (error) {
        diagnostics.warn('Offline image download failed:', error);
        return { saved: 0, reason: 'batch-threw' };
    }

    if (!results || results === 'blocked' || results.length === 0) return { saved: 0, reason: 'batch-empty' };

    let cache: Cache;
    try {
        cache = await cacheStorage.open(OFFLINE_STASH_CACHE);
    } catch (error) {
        diagnostics.warn('Offline image cache unavailable:', error);
        return { saved: 0, reason: 'cache-unavailable' };
    }

    const seen = new Set<string>();
    const unique = results.filter((result) => {
        if (seen.has(result.imageUrl)) return false;
        seen.add(result.imageUrl);
        return true;
    });

    const stored: StashedImage[] = [];
    let done = 0;

    for (const result of unique) {
        try {
            const image = await fetchFn(result.imageUrl);
            if (image.ok) {
                await cache.put(result.imageUrl, image);
                try {
                    const thumb = await fetchFn(result.thumbUrl);
                    if (thumb.ok) await cache.put(result.thumbUrl, thumb);
                } catch (error) {
                    diagnostics.warn('Offline thumbnail download failed:', error);
                }
                triggerPhotoDownload(result.downloadLocation, proxyBaseUrl, fetchFn)
                    .catch(() => {});
                const entry: StashedImage = {
                    ...toDisplayImage(result),
                    thumbUrl: result.thumbUrl,
                    orientation,
                };
                if (result.description !== undefined) {
                    entry.description = result.description;
                }
                stored.push(entry);
            }
        } catch (error) {
            diagnostics.warn('Offline image download failed:', error);
        }
        done++;
        onProgress?.(done, unique.length);
    }

    if (stored.length === 0) return { saved: 0, reason: 'no-photos' };

    const record: StashRecord = {
        v: 1,
        images: stored,
        previous: loadRecord().images,
    };
    try {
        localStorage.setItem(OFFLINE_STASH_KEY, JSON.stringify(record));
    } catch (error) {
        diagnostics.warn('Offline stash metadata write failed:', error);
        // The blobs are cached but the record referencing them was not
        // persisted, so prune against the record still on disk — not `record`,
        // which would evict the previous generation the persisted metadata
        // still points at — to drop just the now-orphaned blobs.
        await pruneCache(cache, loadRecord());
        return { saved: 0, reason: 'write-failed' };
    }

    await pruneCache(cache, record);

    return { saved: stored.length, reason: 'saved' };
}

async function pruneCache(cache: Cache, record: StashRecord): Promise<void> {
    // A prune failure runs after the stash is already saved, so it must not
    // turn a successful download into a reported failure.
    try {
        const keep = new Set<string>();
        for (const entry of [...record.images, ...record.previous]) {
            keep.add(entry.imageUrl);
            keep.add(entry.thumbUrl);
        }
        for (const request of await cache.keys()) {
            if (!keep.has(request.url)) {
                await cache.delete(request.url);
            }
        }
    } catch (error) {
        diagnostics.warn('Offline stash cache prune failed:', error);
    }
}
