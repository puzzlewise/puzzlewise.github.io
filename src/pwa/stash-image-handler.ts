/**
 * Cache-first route for stashed offline images (`src/images/offline-stash.ts`).
 * Kept out of `sw.ts` so it stays testable; it must compile under both the DOM
 * and WebWorker libs, so only types common to both appear here.
 */

import { OFFLINE_STASH_CACHE } from '../images/offline-stash-cache.js';

export function isStashImageRequest(url: URL): boolean {
    return url.hostname === 'images.unsplash.com';
}

export function createStashImageHandler(
    cacheStorage: CacheStorage,
    fetchFn: typeof fetch = fetch,
): (options: { request: Request }) => Promise<Response> {
    return async ({ request }) => {
        try {
            const cache = await cacheStorage.open(OFFLINE_STASH_CACHE);
            // By URL string, not `request`: negotiated-format responses carry
            // `Vary: Accept`, and WebKit's cache then misses on an `<img>`
            // request's own Accept header (Chromium does not).
            const cached = await cache.match(request.url);
            if (cached) return cached;
        } catch {
            // An unreadable cache degrades to the network path below.
        }
        return fetchFn(request);
    };
}
