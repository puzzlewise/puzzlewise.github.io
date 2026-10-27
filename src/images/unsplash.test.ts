/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    buildRandomPhotoUrl,
    parseUnsplashResponse,
    fetchRandomImage,
    fetchRandomImages,
    triggerPhotoDownload,
    getImageProxyBaseUrl,
    PROXY_RANDOM_PATH,
    PROXY_DOWNLOAD_PATH,
    fetchRandomPhotos,
    type UnsplashImageResult,
} from './unsplash.js';
import { getPageCount, setPageCount } from './page-count-cache.js';
import { isBlockedPhotographerUrl } from './blocked-photographers.js';
import { resolveUpstream, RANDOM_PARAMS } from '../worker/image-proxy.js';

const PROXY = 'https://proxy.example';

function makeUnsplashResponse() {
    return {
        urls: {
            regular: 'https://images.unsplash.com/photo-abc?w=1080',
            full: 'https://images.unsplash.com/photo-abc',
            small: 'https://images.unsplash.com/photo-abc?w=400',
        },
        width: 4000,
        height: 2667,
        user: {
            name: 'Test Photographer',
            links: {
                html: 'https://unsplash.com/@testphotographer',
            },
        },
        links: {
            html: 'https://unsplash.com/photos/abc123',
            download_location: 'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
        },
        alt_description: 'a mountain lake at dawn',
    };
}

describe('buildRandomPhotoUrl', () => {
    it('targets the proxy route with orientation=landscape', () => {
        const url = buildRandomPhotoUrl(PROXY);

        expect(url.startsWith(`${PROXY}${PROXY_RANDOM_PATH}?`)).toBe(true);
        expect(url).toContain('orientation=landscape');
    });

    it('never carries a client_id — the Worker authenticates by header', () => {
        // A key in this URL means the key is back in the bundle (#534).
        const url = buildRandomPhotoUrl(PROXY, 'nature', 'portrait', 4);

        expect(url).not.toContain('client_id');
    });

    it('goes nowhere near api.unsplash.com', () => {
        // An unproxied call is unauthenticated and would 401, not fail here.
        const url = buildRandomPhotoUrl(PROXY, 'nature');

        expect(url).not.toContain('api.unsplash.com');
    });

    it('includes query parameter when provided', () => {
        const url = buildRandomPhotoUrl(PROXY, 'nature landscape');

        expect(url).toContain('query=nature+landscape');
        expect(url).toContain('orientation=landscape');
    });

    it('omits query parameter when undefined', () => {
        const url = buildRandomPhotoUrl(PROXY, undefined);

        expect(url).not.toContain('query=');
    });

    it('omits query parameter when empty string', () => {
        const url = buildRandomPhotoUrl(PROXY, '');

        expect(url).not.toContain('query=');
    });

    it('uses orientation=portrait when requested', () => {
        const url = buildRandomPhotoUrl(PROXY, undefined, 'portrait');

        expect(url).toContain('orientation=portrait');
    });

    it('uses orientation=landscape when requested', () => {
        const url = buildRandomPhotoUrl(PROXY, undefined, 'landscape');

        expect(url).toContain('orientation=landscape');
    });

    it('includes count when provided', () => {
        const url = buildRandomPhotoUrl(PROXY, undefined, 'landscape', 4);

        expect(url).toContain('count=4');
    });

    it('omits count when not provided', () => {
        const url = buildRandomPhotoUrl(PROXY);

        expect(url).not.toContain('count=');
    });
});

describe('parseUnsplashResponse', () => {
    it('extracts image URL from valid response', () => {
        const response = makeUnsplashResponse();
        const result = parseUnsplashResponse(response);

        expect(result.imageUrl).toBe(
            'https://images.unsplash.com/photo-abc?w=1080',
        );
    });

    it('extracts original image dimensions', () => {
        const response = makeUnsplashResponse();
        const result = parseUnsplashResponse(response);

        expect(result.width).toBe(4000);
        expect(result.height).toBe(2667);
    });

    it('extracts photographer name', () => {
        const response = makeUnsplashResponse();
        const result = parseUnsplashResponse(response);

        expect(result.photographerName).toBe('Test Photographer');
    });

    it('adds UTM parameters to photographer URL', () => {
        const response = makeUnsplashResponse();
        const result = parseUnsplashResponse(response);

        expect(result.photographerUrl).toBe(
            'https://unsplash.com/@testphotographer?utm_source=puzzle&utm_medium=referral',
        );
    });

    it('adds UTM parameters to photo URL', () => {
        const response = makeUnsplashResponse();
        const result = parseUnsplashResponse(response);

        expect(result.photoUrl).toBe(
            'https://unsplash.com/photos/abc123?utm_source=puzzle&utm_medium=referral',
        );
    });

    it('throws on null response', () => {
        expect(() => parseUnsplashResponse(null)).toThrow(
            'Invalid Unsplash API response',
        );
    });

    it('throws on non-object response', () => {
        expect(() => parseUnsplashResponse('string')).toThrow(
            'Invalid Unsplash API response',
        );
    });

    it('throws on response missing urls', () => {
        const response = { ...makeUnsplashResponse(), urls: undefined };

        expect(() => parseUnsplashResponse(response)).toThrow(
            'Invalid Unsplash API response',
        );
    });

    it('throws on response missing user', () => {
        const response = { ...makeUnsplashResponse(), user: undefined };

        expect(() => parseUnsplashResponse(response)).toThrow(
            'Invalid Unsplash API response',
        );
    });

    it('throws on response missing links', () => {
        const response = { ...makeUnsplashResponse(), links: undefined };

        expect(() => parseUnsplashResponse(response)).toThrow(
            'Invalid Unsplash API response',
        );
    });

    it('throws on response with non-number dimensions', () => {
        const response = { ...makeUnsplashResponse(), width: 'not-a-number' };

        expect(() => parseUnsplashResponse(response)).toThrow(
            'Invalid Unsplash API response',
        );
    });

    it('extracts thumb URL, download location and description', () => {
        const result = parseUnsplashResponse(makeUnsplashResponse());

        expect(result.thumbUrl).toBe('https://images.unsplash.com/photo-abc?w=400');
        expect(result.downloadLocation).toBe(
            'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
        );
        expect(result.description).toBe('a mountain lake at dawn');
    });

    it('omits description when alt_description is null', () => {
        const response = { ...makeUnsplashResponse(), alt_description: null };

        expect(parseUnsplashResponse(response).description).toBeUndefined();
    });

    it('throws on response missing download_location', () => {
        const response = makeUnsplashResponse();
        response.links = { html: response.links.html } as typeof response.links;

        expect(() => parseUnsplashResponse(response)).toThrow(
            'Invalid Unsplash API response',
        );
    });
});

describe('fetchRandomImage', () => {
    it('returns image result on successful fetch', async () => {
        const responseData = makeUnsplashResponse();
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(responseData),
        });

        const result = await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(result).toBeDefined();
        expect(result).toMatchObject({
            imageUrl: responseData.urls.regular,
            photographerName: 'Test Photographer',
        });
    });

    it('calls the correct URL', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(makeUnsplashResponse()),
        });

        await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(mockFetch).toHaveBeenCalledOnce();
        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl.startsWith(`${PROXY}${PROXY_RANDOM_PATH}?`)).toBe(true);
        expect(calledUrl).toContain('orientation=landscape');
        expect(calledUrl).not.toContain('client_id');
    });

    it('returns undefined on HTTP error', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(result).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledOnce();
        warnSpy.mockRestore();
    });

    it('returns undefined on rate limit (429)', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
        });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(result).toBeUndefined();
        warnSpy.mockRestore();
    });

    it('passes query parameter to the URL', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(makeUnsplashResponse()),
        });

        await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch, 'nature landscape');

        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl).toContain('query=nature+landscape');
    });

    it('omits query parameter when not provided', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(makeUnsplashResponse()),
        });

        await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl).not.toContain('query=');
    });

    it('propagates fetch exceptions', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

        await expect(
            fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch),
        ).rejects.toThrow('Network error');
    });

    it('threads portrait orientation into the request URL', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(makeUnsplashResponse()),
        });

        await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch, 'city', 'portrait');

        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl).toContain('orientation=portrait');
    });

    it('refetches once when the draw lands on a blocked photographer', async () => {
        const blocked = makeUnsplashResponse();
        blocked.user.links.html = 'https://unsplash.com/@silverkblack';
        const mockFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(blocked) })
            .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeUnsplashResponse()) });

        const result = await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            photographerUrl:
                'https://unsplash.com/@testphotographer?utm_source=puzzle&utm_medium=referral',
        });
    });

    it("returns 'blocked' when the retry draws a blocked photographer too", async () => {
        const blocked = makeUnsplashResponse();
        blocked.user.links.html = 'https://unsplash.com/@silverkblack';
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(blocked),
        });

        const result = await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(result).toBe('blocked');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('forwards the abort signal to the fetch call', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(makeUnsplashResponse()),
        });
        const { signal } = new AbortController();

        await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch, undefined, 'landscape', signal);

        expect(mockFetch.mock.calls[0][1]).toEqual({ signal });
    });
});

describe('fetchRandomImages', () => {
    it('parses an array response into results', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve([makeUnsplashResponse(), makeUnsplashResponse()]),
        });

        const results = await fetchRandomImages(PROXY, 2, mockFetch as unknown as typeof fetch);

        expect(results).toHaveLength(2);
        expect(results![0].imageUrl).toBe('https://images.unsplash.com/photo-abc?w=1080');
        expect(results![0].thumbUrl).toBe('https://images.unsplash.com/photo-abc?w=400');
    });

    it('requests the given count and orientation', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve([makeUnsplashResponse()]),
        });

        await fetchRandomImages(PROXY, 4, mockFetch as unknown as typeof fetch, 'nature', 'portrait');

        const calledUrl = mockFetch.mock.calls[0][0] as string;
        expect(calledUrl).toContain('count=4');
        expect(calledUrl).toContain('orientation=portrait');
        expect(calledUrl).toContain('query=nature');
    });

    it('returns undefined on HTTP error', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
        });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const results = await fetchRandomImages(PROXY, 4, mockFetch as unknown as typeof fetch);

        expect(results).toBeUndefined();
        warnSpy.mockRestore();
    });

    it('filters out photos by blocked photographers', async () => {
        const blocked = makeUnsplashResponse();
        blocked.user.links.html = 'https://unsplash.com/@silverkblack';
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve([makeUnsplashResponse(), blocked]),
        });

        const results = await fetchRandomImages(PROXY, 2, mockFetch as unknown as typeof fetch);

        expect(results).toHaveLength(1);
        expect(results![0].photographerUrl).toContain('@testphotographer');
    });

    it('throws when the body is not an array', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(makeUnsplashResponse()),
        });

        await expect(
            fetchRandomImages(PROXY, 4, mockFetch as unknown as typeof fetch),
        ).rejects.toThrow('Invalid Unsplash API response');
    });
});

describe('triggerPhotoDownload', () => {
    it('hands the download location to the proxy, intact', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        const location = 'https://api.unsplash.com/photos/abc123/download?ixid=xyz';

        await triggerPhotoDownload(
            location,
            PROXY,
            mockFetch as unknown as typeof fetch,
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
        expect(calledUrl.origin + calledUrl.pathname).toBe(
            `${PROXY}${PROXY_DOWNLOAD_PATH}`,
        );
        // Round-trips whole, ixid included — a mangled ixid silently breaks
        // Unsplash's download attribution.
        expect(calledUrl.searchParams.get('url')).toBe(location);
        expect(calledUrl.searchParams.get('client_id')).toBeNull();
    });

    it('warns but does not throw on HTTP error', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(
            triggerPhotoDownload('https://api.unsplash.com/x/download', PROXY, mockFetch as unknown as typeof fetch),
        ).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledOnce();
        warnSpy.mockRestore();
    });
});

describe('image-fetch-http-error tracking', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
        vi.restoreAllMocks();
    });

    it('reports status and source single when the single fetch gets an error response', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        });

        await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(umamiTrack).toHaveBeenCalledExactlyOnceWith('image-fetch-http-error', {
            status: 403,
            source: 'single',
            sourceKind: 'search',
            topic: '',
        });
    });

    it('reports status and source batch when the picker fetch gets an error response', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
        });

        await fetchRandomImages(PROXY, 4, mockFetch as unknown as typeof fetch);

        expect(umamiTrack).toHaveBeenCalledExactlyOnceWith('image-fetch-http-error', {
            status: 502,
            source: 'batch',
            sourceKind: 'search',
            topic: '',
        });
    });

    it('reports nothing on a successful fetch', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve(makeUnsplashResponse()),
        });

        await fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch);

        expect(umamiTrack).not.toHaveBeenCalled();
    });

    it("reports nothing when the fetch itself throws — that is image-fetch-failed's case", async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

        await expect(
            fetchRandomImage(PROXY, mockFetch as unknown as typeof fetch),
        ).rejects.toThrow('Network error');

        expect(umamiTrack).not.toHaveBeenCalled();
    });

    it('reports nothing on a download-trigger error response', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
        });

        await triggerPhotoDownload(
            'https://api.unsplash.com/photos/abc123/download?ixid=xyz',
            PROXY,
            mockFetch as unknown as typeof fetch,
        );

        expect(umamiTrack).not.toHaveBeenCalled();
    });
});

describe('getImageProxyBaseUrl', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('returns undefined when unset, which is the "no picker" gate', () => {
        vi.stubEnv('VITE_IMAGE_PROXY_URL', '');
        expect(getImageProxyBaseUrl()).toBeUndefined();
    });

    it('returns undefined for a whitespace-only value', () => {
        vi.stubEnv('VITE_IMAGE_PROXY_URL', '   ');
        expect(getImageProxyBaseUrl()).toBeUndefined();
    });

    it('strips a trailing slash so callers can append a rooted path', () => {
        // `//random` (from a trailing slash) misses the Worker's exact-path
        // check and 404s every photo request.
        vi.stubEnv('VITE_IMAGE_PROXY_URL', 'https://proxy.example/');
        expect(getImageProxyBaseUrl()).toBe('https://proxy.example');

        vi.stubEnv('VITE_IMAGE_PROXY_URL', 'https://proxy.example///');
        expect(getImageProxyBaseUrl()).toBe('https://proxy.example');
    });

    it('trims surrounding whitespace', () => {
        vi.stubEnv('VITE_IMAGE_PROXY_URL', '  https://proxy.example  ');
        expect(getImageProxyBaseUrl()).toBe('https://proxy.example');
    });
});

/**
 * Client and Worker agree on the wire format via two independent sets of
 * string literals; nothing else tests across the boundary, so renaming a route
 * on either side leaves both suites green and 404s every request in production.
 */
describe('client/Worker route contract', () => {
    it('routes a URL the client builds for a random photo', () => {
        const built = buildRandomPhotoUrl(PROXY, 'face', 'portrait', 4);

        const resolved = resolveUpstream(new URL(built));

        expect(resolved.ok).toBe(true);
        const upstream = new URL((resolved as { url: string }).url);
        expect(upstream.pathname).toBe('/photos/random');
        expect(upstream.searchParams.get('query')).toBe('face');
        expect(upstream.searchParams.get('orientation')).toBe('portrait');
        expect(upstream.searchParams.get('count')).toBe('4');
    });

    it('routes the URL the client builds for a download trigger', async () => {
        const location = 'https://api.unsplash.com/photos/abc123/download?ixid=xyz';
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });

        await triggerPhotoDownload(
            location,
            PROXY,
            mockFetch as unknown as typeof fetch,
        );

        const resolved = resolveUpstream(
            new URL(mockFetch.mock.calls[0][0] as string),
        );

        expect(resolved.ok).toBe(true);
        const upstream = new URL((resolved as { url: string }).url);
        expect(upstream.pathname).toBe('/photos/abc123/download');
        expect(upstream.searchParams.get('ixid')).toBe('xyz');
    });

    it('emits exactly the parameters the Worker forwards', () => {
        // Param lists are independent too: one added here without a matching
        // RANDOM_PARAMS entry is silently dropped by the Worker.
        const built = new URL(buildRandomPhotoUrl(PROXY, 'face', 'portrait', 4));

        expect([...built.searchParams.keys()].sort()).toEqual(
            [...RANDOM_PARAMS].sort(),
        );
    });
});

describe('fetchRandomPhotos', () => {
    const CTX = { caller: 'picker', imageCategory: 'nature', vibrant: false, custom: false } as const;
    let umamiTrack: ReturnType<typeof vi.fn>;

    function photo(n: number, blocked = false) {
        const base = makeUnsplashResponse();
        return {
            ...base,
            urls: {
                regular: `https://images.unsplash.com/photo-${n}?w=1080`,
                full: `https://images.unsplash.com/photo-${n}`,
                small: `https://images.unsplash.com/photo-${n}?w=400`,
            },
            user: {
                name: `Photographer ${n}`,
                links: { html: blocked ? 'https://unsplash.com/@silverkblack' : `https://unsplash.com/@p${n}` },
            },
        };
    }

    function photos(n: number, blocked = 0) {
        return Array.from({ length: n }, (_, i) => photo(i, i < blocked));
    }

    function searchBody(n: number, totalPages: number, opts: { blocked?: number } = {}) {
        return { total: totalPages * 30, total_pages: totalPages, results: photos(n, opts.blocked) };
    }

    type Reply = readonly [number, unknown, Record<string, string>?];

    function respondSequence(...replies: Reply[]) {
        const fn = vi.fn();
        for (const [status, body, headers] of replies) {
            fn.mockImplementationOnce(async () =>
                new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
        }
        return fn as typeof fn & typeof fetch;
    }

    function respond(status: number, body: unknown, headers?: Record<string, string>) {
        return respondSequence([status, body, headers]);
    }

    function requestedUrl(fetchFn: ReturnType<typeof vi.fn>, call = 0): URL {
        return new URL(fetchFn.mock.calls[call][0] as string);
    }

    beforeEach(() => {
        localStorage.clear();
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
        vi.restoreAllMocks();
    });

    it('fetches page 1 when the page count is unknown, and caches the usable count', async () => {
        const fetchFn = respond(200, searchBody(30, 334));

        await fetchRandomPhotos(PROXY, 4, fetchFn, 'nature', 'landscape', CTX, { random: () => 0.5 });

        expect(requestedUrl(fetchFn).searchParams.get('page')).toBe('1');
        expect(getPageCount('search:nature|landscape')).toBe(166);
    });

    it('draws a random page within the cached count', async () => {
        setPageCount('search:nature|landscape', 166);
        const fetchFn = respond(200, searchBody(30, 334));

        await fetchRandomPhotos(PROXY, 4, fetchFn, 'nature', 'landscape', CTX, { random: () => 0.5 });

        expect(requestedUrl(fetchFn).searchParams.get('page')).toBe('84');
    });

    it('keeps a lowered count when a later page comes back full', async () => {
        setPageCount('search:nature|landscape', 83);
        const fetchFn = respond(200, searchBody(30, 334));

        await fetchRandomPhotos(PROXY, 4, fetchFn, 'nature', 'landscape', CTX, { random: () => 0.5 });

        expect(getPageCount('search:nature|landscape')).toBe(83);
    });

    it('returns count shuffled photos without blocked photographers', async () => {
        const fetchFn = respond(200, searchBody(30, 2, { blocked: 1 }));

        const result = await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX);

        expect(result).toHaveLength(4);
        expect((result as UnsplashImageResult[]).some((p) => isBlockedPhotographerUrl(p.photographerUrl))).toBe(false);
    });

    it('skips a malformed photo instead of failing the draw', async () => {
        const fetchFn = respond(200, { total: 30, total_pages: 1, results: [{ id: 'odd' }, ...photos(29)] });

        const result = await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX);

        expect(result).toHaveLength(4);
    });

    it('still throws when no photo on the page parses', async () => {
        const fetchFn = respond(200, { total: 2, total_pages: 1, results: [{ id: 'odd' }, { id: 'odder' }] });

        await expect(fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX)).rejects.toThrow(
            'Invalid Unsplash API response',
        );
    });

    it("returns 'blocked' when every photo on the page is by a blocked photographer", async () => {
        const fetchFn = respond(200, searchBody(3, 2, { blocked: 3 }));

        expect(await fetchRandomPhotos(PROXY, 1, fetchFn, 'q', 'landscape', CTX)).toBe('blocked');
    });

    it('uses a topic for no query', async () => {
        const fetchFn = respond(200, photos(30), { 'x-total': '17898' });

        await fetchRandomPhotos(PROXY, 4, fetchFn, undefined, 'portrait', CTX, { random: () => 0 });

        expect(requestedUrl(fetchFn).pathname).toBe('/topics/nature/photos');
        expect(getPageCount('topic:nature|portrait')).toBe(596);
    });

    it('lowers the count, retries once and reports an empty deep page', async () => {
        setPageCount('search:q|landscape', 166);
        const fetchFn = respondSequence([200, searchBody(0, 334)], [200, searchBody(30, 334)]);

        const result = await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX, { random: () => 0.5 });

        expect(getPageCount('search:q|landscape')).toBe(83);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(Number(requestedUrl(fetchFn, 1).searchParams.get('page'))).toBeLessThanOrEqual(83);
        expect(result).toHaveLength(4);
        expect(umamiTrack).toHaveBeenCalledWith('image-page-empty', {
            caller: 'picker',
            imageCategory: 'nature',
            vibrant: false,
            custom: false,
            orientation: 'landscape',
            sourceKind: 'search',
            topic: '',
            page: 84,
            reportedPages: 334,
            loweredTo: 83,
            retry: 'ok',
        });
    });

    it.each([
        ['empty', [200, { total: 0, total_pages: 334, results: [] }]],
        ['http-error', [403, { errors: ['Forbidden'] }]],
    ] as const)("reports retry '%s' when the retry fails that way", async (retry, second) => {
        setPageCount('search:q|landscape', 166);
        const fetchFn = respondSequence([200, searchBody(0, 334)], second);

        await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX, { random: () => 0.5 });

        expect(umamiTrack).toHaveBeenCalledWith('image-page-empty', expect.objectContaining({ retry }));
    });

    it('sends only the named context fields with image-page-empty', async () => {
        setPageCount('search:q|landscape', 166);
        const fetchFn = respondSequence([200, searchBody(0, 334)], [200, searchBody(30, 334)]);
        const context = { ...CTX, queryText: 'my secret search' } as typeof CTX;

        await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', context, { random: () => 0.5 });

        const payload = umamiTrack.mock.calls.find(([name]) => name === 'image-page-empty')![1];
        expect(payload).not.toHaveProperty('queryText');
    });

    it("reports retry 'threw' and rethrows when the retry fetch rejects", async () => {
        setPageCount('search:q|landscape', 166);
        const fetchFn = respondSequence([200, searchBody(0, 334)]);
        fetchFn.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        await expect(
            fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX, { random: () => 0.5 }),
        ).rejects.toThrow('Failed to fetch');
        expect(umamiTrack).toHaveBeenCalledWith('image-page-empty', expect.objectContaining({ retry: 'threw' }));
    });

    it('reports a topic draw with its slug', async () => {
        setPageCount('topic:nature|landscape', 500);
        const fetchFn = respondSequence(
            [200, [], { 'x-total': '15000' }],
            [200, photos(30), { 'x-total': '15000' }],
        );

        const draws = [0, 0.5];
        await fetchRandomPhotos(PROXY, 4, fetchFn, undefined, 'landscape', CTX, {
            random: () => draws.shift() ?? 0,
        });

        expect(umamiTrack).toHaveBeenCalledWith(
            'image-page-empty',
            expect.objectContaining({ sourceKind: 'topic', topic: 'nature', reportedPages: 500 }),
        );
    });

    it('does not retry or report an empty first page', async () => {
        const fetchFn = respond(200, searchBody(0, 0));

        expect(await fetchRandomPhotos(PROXY, 4, fetchFn, 'zzqx', 'landscape', CTX)).toEqual([]);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(umamiTrack).not.toHaveBeenCalledWith('image-page-empty', expect.anything());
    });

    it('leaves the cache alone on an error status, tagged by caller', async () => {
        setPageCount('search:q|landscape', 166);
        const fetchFn = respond(403, { errors: ['Forbidden'] });

        expect(
            await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', { ...CTX, caller: 'surprise' }),
        ).toBeUndefined();
        expect(getPageCount('search:q|landscape')).toBe(166);
        expect(umamiTrack).toHaveBeenCalledWith('image-fetch-http-error', {
            status: 403,
            source: 'single',
            sourceKind: 'search',
            topic: '',
        });
    });

    it('names the topic on an error status from a topic draw', async () => {
        const fetchFn = respond(404, { errors: ['Not found'] });

        await fetchRandomPhotos(PROXY, 4, fetchFn, undefined, 'portrait', CTX, { random: () => 0 });

        expect(umamiTrack).toHaveBeenCalledWith('image-fetch-http-error', {
            status: 404,
            source: 'batch',
            sourceKind: 'topic',
            topic: 'nature',
        });
    });

    it('passes the abort signal to every fetch, including the retry', async () => {
        setPageCount('search:q|landscape', 166);
        const fetchFn = respondSequence([200, searchBody(0, 334)], [200, searchBody(30, 334)]);
        const controller = new AbortController();

        await fetchRandomPhotos(PROXY, 1, fetchFn, 'q', 'landscape', CTX, {
            random: () => 0.5,
            signal: controller.signal,
        });

        expect(fetchFn).toHaveBeenCalledTimes(2);
        for (const call of fetchFn.mock.calls) {
            expect((call[1] as RequestInit).signal).toBe(controller.signal);
        }
    });

    it('still loads photos when localStorage throws', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        const fetchFn = respond(200, searchBody(30, 334));

        const result = await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX);

        expect(requestedUrl(fetchFn).searchParams.get('page')).toBe('1');
        expect(result).toHaveLength(4);
    });
});
