/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    getPageCount,
    setPageCount,
    PAGE_COUNT_CACHE_KEY,
    PAGE_COUNT_TTL_MS,
    MAX_PAGE_COUNT_ENTRIES,
} from './page-count-cache.js';

async function freshCache(): Promise<typeof import('./page-count-cache.js')> {
    vi.resetModules();
    return import('./page-count-cache.js');
}

describe('page-count cache', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });

    it('returns undefined for an unknown key', () => {
        expect(getPageCount('search:nature|landscape')).toBeUndefined();
    });

    it('round-trips a stored count', () => {
        setPageCount('k', 166, 1000);

        expect(getPageCount('k', 2000)).toBe(166);
    });

    it('expires an entry after the TTL', () => {
        setPageCount('k', 5, 0);

        expect(getPageCount('k', PAGE_COUNT_TTL_MS + 1)).toBeUndefined();
    });

    it('evicts the oldest entry beyond MAX_PAGE_COUNT_ENTRIES', () => {
        for (let i = 0; i <= MAX_PAGE_COUNT_ENTRIES; i++) setPageCount(`k${i}`, 2, i);

        expect(getPageCount('k0', MAX_PAGE_COUNT_ENTRIES)).toBeUndefined();
        expect(getPageCount(`k${MAX_PAGE_COUNT_ENTRIES}`, MAX_PAGE_COUNT_ENTRIES)).toBe(2);
    });

    it('treats corrupt JSON as empty and overwrites it', () => {
        localStorage.setItem(PAGE_COUNT_CACHE_KEY, '{nope');

        expect(getPageCount('k')).toBeUndefined();
        setPageCount('k', 3, 0);
        expect(getPageCount('k', 0)).toBe(3);
    });

    it('treats a wrong-shape record as empty', () => {
        localStorage.setItem(
            PAGE_COUNT_CACHE_KEY,
            JSON.stringify({ v: 1, entries: { k: { pages: 'x', at: 0 } } }),
        );

        expect(getPageCount('k', 0)).toBeUndefined();
    });

    it('keeps well-formed entries next to a wrong-shape one', () => {
        localStorage.setItem(
            PAGE_COUNT_CACHE_KEY,
            JSON.stringify({ v: 1, entries: { bad: { pages: 'x', at: 0 }, good: { pages: 7, at: 0 } } }),
        );

        expect(getPageCount('good', 0)).toBe(7);
    });

    it.each([0, -5, 2.5])('drops a stored count of %d', (pages) => {
        localStorage.setItem(
            PAGE_COUNT_CACHE_KEY,
            JSON.stringify({ v: 1, entries: { k: { pages, at: 0 } } }),
        );

        expect(getPageCount('k', 0)).toBeUndefined();
    });

    it('keeps counts for the session when localStorage throws', async () => {
        const cache = await freshCache();
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });

        expect(() => cache.setPageCount('k', 3, 0)).not.toThrow();
        expect(cache.getPageCount('k', 0)).toBe(3);
    });

    it('keeps an unsaved count over an older stored one when writes start failing', async () => {
        const cache = await freshCache();
        cache.setPageCount('k', 166, 0);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('full', 'QuotaExceededError');
        });

        cache.setPageCount('k', 40, 1);

        expect(cache.getPageCount('k', 2)).toBe(40);
    });

    it('reports a failed write once per session, by error name', async () => {
        const cache = await freshCache();
        const umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
        // jsdom's DOMException is not instanceof this realm's Error; a browser's is.
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
        });

        cache.setPageCount('a', 3, 0);
        cache.setPageCount('b', 4, 0);

        expect(umamiTrack).toHaveBeenCalledExactlyOnceWith('image-page-counts-unsaved', {
            errorName: 'QuotaExceededError',
        });
        delete (window as unknown as { umami?: unknown }).umami;
    });
});
