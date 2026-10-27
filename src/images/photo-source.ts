import type { Orientation } from '../model/types.js';

export type PhotoSource =
    | { kind: 'search'; query: string }
    | { kind: 'topic'; slug: string };

/**
 * Large photo topics that stand in for an unfiltered "Any" draw. Search needs
 * a query, and the editorial feed has no orientation filter.
 */
export const ANY_TOPICS: readonly string[] = [
    'nature',
    'architecture-interior',
    'wallpapers',
    'textures-patterns',
    'travel',
    'animals',
    'street-photography',
    'film',
    'people',
    'experimental',
];

/**
 * Search reports up to ~10,000 results, but in a 2026-10-27 probe pages past
 * ~5,000 results (page 167+ at 30 per page) came back empty.
 */
export const SEARCH_PAGE_CAP = 166;

export const PER_PAGE = 30;

export function pickPhotoSource(query: string | undefined, random: () => number): PhotoSource {
    if (query !== undefined && query.trim().length > 0) {
        return { kind: 'search', query };
    }
    return { kind: 'topic', slug: ANY_TOPICS[Math.floor(random() * ANY_TOPICS.length)] };
}

/** Skips the last reported page, which can hold as little as one photo. */
export function usablePages(source: PhotoSource, reportedPages: number): number {
    const withoutLast = reportedPages - 1;
    const capped = source.kind === 'search' ? Math.min(withoutLast, SEARCH_PAGE_CAP) : withoutLast;
    return Math.max(1, capped);
}

export function pageCacheKey(source: PhotoSource, orientation: Orientation): string {
    return source.kind === 'search'
        ? `search:${source.query}|${orientation}`
        : `topic:${source.slug}|${orientation}`;
}

export function buildPageUrl(
    proxyBaseUrl: string,
    source: PhotoSource,
    orientation: Orientation,
    page: number,
): string {
    const params = new URLSearchParams({
        orientation,
        page: String(page),
        per_page: String(PER_PAGE),
    });

    if (source.kind === 'search') {
        params.set('query', source.query);
        return `${proxyBaseUrl}/search?${params.toString()}`;
    }

    return `${proxyBaseUrl}/topics/${source.slug}/photos?${params.toString()}`;
}

export interface ParsedPage {
    photos: unknown[];
    reportedPages: number | undefined;
}

export function parsePage(source: PhotoSource, body: unknown, headers: Headers): ParsedPage {
    if (source.kind === 'search') {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new Error('Invalid Unsplash API response');
        }
        const record = body as Record<string, unknown>;
        if (!Array.isArray(record.results)) {
            throw new Error('Invalid Unsplash API response');
        }
        return {
            photos: record.results,
            reportedPages: typeof record.total_pages === 'number' ? record.total_pages : undefined,
        };
    }

    if (!Array.isArray(body)) {
        throw new Error('Invalid Unsplash API response');
    }

    const total = Number(headers.get('x-total') ?? Number.NaN);
    return {
        photos: body,
        reportedPages: Number.isFinite(total) ? Math.ceil(total / PER_PAGE) : undefined,
    };
}
