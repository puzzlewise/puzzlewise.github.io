/**
 * Calls go through our own proxy Worker (`src/worker/image-proxy.ts`) rather
 * than `api.unsplash.com` directly: this is a static site, so a build-time API
 * key would be inlined into the bundle and readable by every visitor (#534).
 * The Worker holds the key. `VITE_IMAGE_PROXY_URL` names it — a plain URL, not
 * a secret; its absence means "no photo source", the gate the key used to be.
 *
 * @see https://unsplash.com/documentation#search-photos
 */

import { diagnostics } from '../diagnostics.js';
import { track } from '../analytics/index.js';
import type { ImagePageEmptyData } from '../analytics/umami.js';
import { isBlockedPhotographerUrl } from './blocked-photographers.js';
import { getPageCount, setPageCount } from './page-count-cache.js';
import {
    buildPageUrl,
    pageCacheKey,
    parsePage,
    pickPhotoSource,
    usablePages,
    type ParsedPage,
    type PhotoSource,
} from './photo-source.js';
import { shuffled } from './shuffled.js';
import type { Orientation } from '../model/types.js';

/** Proxy route that forwards a photo's `download_location`. */
export const PROXY_DOWNLOAD_PATH = '/download';

/** Only the fields we actually use — the full API response is much larger. */
export interface UnsplashPhoto {
    urls: {
        regular: string;
        full: string;
        /** Small (400px) URL — used for picker thumbnails. */
        small: string;
    };
    width: number;
    height: number;
    user: {
        name: string;
        links: {
            html: string;
        };
    };
    links: {
        html: string;
        download_location: string;
    };
    /** Alt text; null when the photographer set none. */
    alt_description?: string | null;
}

/**
 * Where a drawn photo came from: `knownPages` is the cached usable page count
 * before the draw, 0 when unknown (so page 1 was forced).
 */
export interface PageDraw {
    page: number;
    knownPages: number;
}

export interface UnsplashImageResult {
    imageUrl: string;
    width: number;
    height: number;
    photographerName: string;
    photographerUrl: string;
    photoUrl: string;
    thumbUrl: string;
    /** Unsplash download-reporting endpoint (not the image URL). */
    downloadLocation: string;
    description?: string;
    pageDraw?: PageDraw;
}

export function parseUnsplashResponse(data: unknown): UnsplashImageResult {
    if (!isUnsplashPhoto(data)) {
        throw new Error('Invalid Unsplash API response');
    }

    // "regular" (1080px) balances quality and load time.
    const imageUrl = data.urls.regular;

    return {
        imageUrl,
        width: data.width,
        height: data.height,
        photographerName: data.user.name,
        photographerUrl: `${data.user.links.html}?utm_source=puzzle&utm_medium=referral`,
        photoUrl: `${data.links.html}?utm_source=puzzle&utm_medium=referral`,
        thumbUrl: data.urls.small,
        downloadLocation: data.links.download_location,
        description: typeof data.alt_description === 'string' && data.alt_description.length > 0
            ? data.alt_description
            : undefined,
    };
}

function getAtPath(data: unknown, path: readonly string[]): unknown {
    let current: unknown = data;

    for (const key of path) {
        if (typeof current !== 'object' || current === null) {
            return undefined;
        }

        current = (current as Record<string, unknown>)[key];
    }

    return current;
}

function hasString(data: unknown, ...path: string[]): boolean {
    return typeof getAtPath(data, path) === 'string';
}

function hasNumber(data: unknown, ...path: string[]): boolean {
    return typeof getAtPath(data, path) === 'number';
}

function isUnsplashPhoto(data: unknown): data is UnsplashPhoto {
    return (
        hasString(data, 'urls', 'regular') &&
        hasString(data, 'urls', 'full') &&
        hasString(data, 'urls', 'small') &&
        hasNumber(data, 'width') &&
        hasNumber(data, 'height') &&
        hasString(data, 'user', 'name') &&
        hasString(data, 'user', 'links', 'html') &&
        hasString(data, 'links', 'html') &&
        hasString(data, 'links', 'download_location')
    );
}

/**
 * Returns `undefined` when no proxy is configured — callers treat that as "no
 * photo source", so an unconfigured build degrades to no picker rather than a
 * broken one. Strips a trailing slash so callers can append a rooted path.
 */
export function getImageProxyBaseUrl(): string | undefined {
    const url = import.meta.env.VITE_IMAGE_PROXY_URL as string | undefined;

    if (!url || url.trim().length === 0) {
        return undefined;
    }

    return url.trim().replace(/\/+$/, '');
}

function reportProxyHttpError(
    response: Response,
    source: 'single' | 'batch',
    photoSource: PhotoSource,
): void {
    diagnostics.warn(
        `Image proxy error: ${response.status} ${response.statusText}`,
    );
    track('image-fetch-http-error', {
        status: response.status,
        source,
        sourceKind: photoSource.kind,
        topic: photoSource.kind === 'topic' ? photoSource.slug : '',
    });
}

export interface PhotoRequestContext {
    caller: 'picker' | 'surprise' | 'stash';
    imageCategory: string;
    vibrant: boolean;
    custom: boolean;
}

export interface FetchRandomPhotosOptions {
    random?: () => number;
    signal?: AbortSignal;
}

/**
 * `/photos/random` draws from a pool of only ~150 photos per query, so draw
 * from a random page of the full result set instead. A page's count is
 * cached only when unknown or when lowering it, so a later full response
 * cannot undo a lowering; error statuses never touch it, so a rate-limit
 * hour cannot collapse every source to page 1.
 *
 * Resolves `undefined` on an error status, `'blocked'` when the page's photos
 * were all by blocked photographers, `[]` when the page was empty; throws on
 * a malformed body or a rejected fetch.
 */
export async function fetchRandomPhotos(
    proxyBaseUrl: string,
    count: number,
    fetchFn: typeof fetch,
    query: string | undefined,
    orientation: Orientation,
    context: PhotoRequestContext,
    options: FetchRandomPhotosOptions = {},
): Promise<UnsplashImageResult[] | 'blocked' | undefined> {
    const { random = Math.random, signal } = options;
    const source = pickPhotoSource(query, random);
    const key = pageCacheKey(source, orientation);
    const known = getPageCount(key);
    const page = known === undefined ? 1 : 1 + Math.floor(random() * known);

    const fetchPage = async (pageNumber: number): Promise<ParsedPage | undefined> => {
        const response = await fetchFn(buildPageUrl(proxyBaseUrl, source, orientation, pageNumber), { signal });
        if (!response.ok) {
            reportProxyHttpError(response, context.caller === 'surprise' ? 'single' : 'batch', source);
            return undefined;
        }
        return parsePage(source, await response.json(), response.headers);
    };

    let servedPage = page;
    let result = await fetchPage(page);
    if (result === undefined) return undefined;

    if (known === undefined && result.reportedPages !== undefined) {
        setPageCount(key, usablePages(source, result.reportedPages));
    }

    if (result.photos.length === 0 && page > 1) {
        const loweredTo = page - 1;
        const emptyReportedPages = result.reportedPages ?? 0;
        setPageCount(key, loweredTo);
        const report = (retry: ImagePageEmptyData['retry']): void => {
            track('image-page-empty', {
                caller: context.caller,
                imageCategory: context.imageCategory,
                vibrant: context.vibrant,
                custom: context.custom,
                orientation,
                sourceKind: source.kind,
                topic: source.kind === 'topic' ? source.slug : '',
                page,
                reportedPages: emptyReportedPages,
                loweredTo,
                retry,
            });
        };

        let retried: ParsedPage | undefined;
        servedPage = 1 + Math.floor(random() * loweredTo);
        try {
            retried = await fetchPage(servedPage);
        } catch (error) {
            report('threw');
            throw error;
        }
        report(retried === undefined ? 'http-error' : retried.photos.length > 0 ? 'ok' : 'empty');
        if (retried === undefined) return undefined;
        result = retried;
    }

    const parsed = result.photos.flatMap((photo) => {
        try {
            return [parseUnsplashResponse(photo)];
        } catch {
            return [];
        }
    });
    if (result.photos.length > 0 && parsed.length === 0) {
        throw new Error('Invalid Unsplash API response');
    }
    const usable = parsed.filter((photo) => !isBlockedPhotographerUrl(photo.photographerUrl));
    if (parsed.length > 0 && usable.length === 0) return 'blocked';

    const pageDraw: PageDraw = { page: servedPage, knownPages: known ?? 0 };
    return shuffled(usable, random)
        .slice(0, count)
        .map((photo) => ({ ...photo, pageDraw }));
}

/**
 * Reports a photo as used per Unsplash guidelines: hit `download_location`
 * when the photo is actually used (here: a puzzle starts with it), not when
 * merely displayed. Fire-and-forget — failures are logged, never thrown.
 */
export async function triggerPhotoDownload(
    downloadLocation: string,
    proxyBaseUrl: string,
    fetchFn: typeof fetch = fetch,
): Promise<void> {
    // The Worker validates this is an Unsplash download location before
    // attaching the key, so it can't be turned into an open relay.
    const url = `${proxyBaseUrl}${PROXY_DOWNLOAD_PATH}`
        + `?url=${encodeURIComponent(downloadLocation)}`;

    const response = await fetchFn(url);

    if (!response.ok) {
        diagnostics.warn(
            `Image proxy error on download trigger: ${response.status} ${response.statusText}`,
        );
    }
}
