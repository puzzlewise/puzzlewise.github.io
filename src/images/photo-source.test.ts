import { describe, it, expect } from 'vitest';
import {
    pickPhotoSource,
    usablePages,
    pageCacheKey,
    buildPageUrl,
    parsePage,
    ANY_TOPICS,
    type PhotoSource,
} from './photo-source.js';
import { handleRequest, resolveUpstream, SEARCH_PARAMS, TOPIC_PHOTOS_PARAMS } from '../worker/image-proxy.js';

const PROXY = 'https://proxy.example';
const TOPIC: PhotoSource = { kind: 'topic', slug: 'nature' };
const PHOTO = { id: 'abc123' };

describe('pickPhotoSource', () => {
    it('uses search for a query and a topic for no query', () => {
        expect(pickPhotoSource('nature vibrant colorful', () => 0)).toEqual({
            kind: 'search',
            query: 'nature vibrant colorful',
        });
        expect(pickPhotoSource(undefined, () => 0)).toEqual({ kind: 'topic', slug: 'nature' });
        expect(pickPhotoSource('  ', () => 0.999)).toEqual({
            kind: 'topic',
            slug: ANY_TOPICS[ANY_TOPICS.length - 1],
        });
    });
});

describe('usablePages', () => {
    it.each([
        [{ kind: 'search', query: 'q' }, 334, 166],
        [{ kind: 'search', query: 'q' }, 38, 37],
        [{ kind: 'search', query: 'q' }, 1, 1],
        [{ kind: 'search', query: 'q' }, 0, 1],
        [{ kind: 'topic', slug: 'nature' }, 1160, 1159],
        [{ kind: 'topic', slug: 'nature' }, 1, 1],
    ] as const)('usablePages(%o, %i) = %i', (source, reported, expected) => {
        expect(usablePages(source, reported)).toBe(expected);
    });
});

describe('pageCacheKey', () => {
    it('keys by source and orientation', () => {
        expect(pageCacheKey({ kind: 'search', query: 'face' }, 'portrait')).toBe('search:face|portrait');
        expect(pageCacheKey(TOPIC, 'landscape')).toBe('topic:nature|landscape');
    });
});

describe('buildPageUrl', () => {
    it('builds URLs the Worker routes, with only forwarded parameters', () => {
        const search = new URL(buildPageUrl(PROXY, { kind: 'search', query: 'face' }, 'portrait', 7));
        expect(search.pathname).toBe('/search');
        expect([...search.searchParams.keys()].sort()).toEqual([...SEARCH_PARAMS].sort());
        expect(search.searchParams.get('per_page')).toBe('30');
        expect(search.searchParams.get('page')).toBe('7');

        const topic = new URL(buildPageUrl(PROXY, { kind: 'topic', slug: 'film' }, 'landscape', 3));
        expect(topic.pathname).toBe('/topics/film/photos');
        expect([...topic.searchParams.keys()].sort()).toEqual([...TOPIC_PHOTOS_PARAMS].sort());

        for (const url of [search, topic]) {
            expect(url.origin).toBe(PROXY);
            expect(resolveUpstream(url).ok).toBe(true);
        }
    });
});

describe('parsePage', () => {
    it('reads total_pages from a search body', () => {
        const r = parsePage(
            { kind: 'search', query: 'q' },
            { total: 900, total_pages: 30, results: [PHOTO] },
            new Headers(),
        );

        expect(r.reportedPages).toBe(30);
        expect(r.photos).toHaveLength(1);
    });

    it('derives topic pages from x-total', () => {
        expect(parsePage(TOPIC, [PHOTO], new Headers({ 'x-total': '17898' })).reportedPages).toBe(597);
        expect(parsePage(TOPIC, [PHOTO], new Headers()).reportedPages).toBeUndefined();
        expect(parsePage(TOPIC, [PHOTO], new Headers({ 'x-total': 'lots' })).reportedPages).toBeUndefined();
    });

    it('rejects a body of the wrong shape', () => {
        expect(() => parsePage(TOPIC, { results: [] }, new Headers())).toThrow('Invalid Unsplash API response');
        expect(() => parsePage({ kind: 'search', query: 'q' }, [PHOTO], new Headers())).toThrow(
            'Invalid Unsplash API response',
        );
    });
});

describe('client/Worker header contract', () => {
    it("reads a topic's page count through the Worker's forwarded headers", async () => {
        const upstream = async () => new Response(JSON.stringify([PHOTO]), {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-total': '17898' },
        });
        const url = buildPageUrl(PROXY, TOPIC, 'portrait', 1);

        const response = await handleRequest(
            new Request(url, { headers: { Origin: 'https://puzzlewise.github.io' } }),
            { UNSPLASH_ACCESS_KEY: 'test-key' },
            upstream as unknown as typeof fetch,
        );

        expect(parsePage(TOPIC, await response.json(), response.headers).reportedPages).toBe(597);
    });
});
