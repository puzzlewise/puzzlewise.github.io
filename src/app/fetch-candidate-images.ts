import { diagnostics } from '../diagnostics.js';
import { track } from '../analytics/index.js';
import {
    fetchRandomPhotos,
    CANDIDATE_COUNT,
    toDisplayImage,
    type CandidateCause,
    type CandidateFetchResult,
    type CandidateImage,
    type PageDraw,
} from '../images/index.js';
import { stashCandidates } from '../images/offline-stash.js';
import { findImageCategory, buildImageQuery, resolveQueryOverride, isCustomQuery } from '../game/image-categories.js';
import type { Orientation } from '../model/types.js';

/** Candidates per picker fetch — one per grid tile, so tied to the tile count. */
export const CANDIDATE_IMAGE_COUNT = CANDIDATE_COUNT;

async function candidatesFromStash(
    networkCause: CandidateCause,
    imageCategory: string,
    vibrant: boolean,
    orientation: Orientation,
): Promise<CandidateFetchResult> {
    const stash = await stashCandidates(orientation, CANDIDATE_IMAGE_COUNT);
    track('image-stash-fallback', {
        imageCategory,
        orientation,
        vibrant,
        hit: stash.length > 0,
        cause: networkCause === 'threw' ? 'fetch-failed' : 'no-candidates',
    });
    return stash.length > 0
        ? { candidates: stash, cause: networkCause, source: 'stash' }
        : { candidates: [], cause: networkCause, source: 'none' };
}

export async function fetchCandidateImages(
    proxyBaseUrl: string,
    imageCategory: string,
    vibrant: boolean,
    orientation: Orientation,
    queryOverride?: string,
    fetchFn: typeof fetch = fetch,
): Promise<CandidateFetchResult> {
    let draw: PageDraw | undefined;
    const withDraw = (result: CandidateFetchResult): CandidateFetchResult =>
        draw === undefined ? result : { ...result, draw };
    try {
        const category = findImageCategory(imageCategory);
        const query = buildImageQuery(resolveQueryOverride(category.query, queryOverride), vibrant);
        const results = await fetchRandomPhotos(
            proxyBaseUrl,
            CANDIDATE_IMAGE_COUNT,
            fetchFn,
            query,
            orientation,
            { caller: 'picker', imageCategory, vibrant, custom: isCustomQuery(queryOverride) },
            { onDraw: (d) => { draw = d; } },
        );

        if (!results || results === 'blocked' || results.length === 0) {
            const networkCause: CandidateCause = results === undefined
                ? 'http-error'
                : results === 'blocked' ? 'blocked' : 'empty-page';
            return withDraw(await candidatesFromStash(networkCause, imageCategory, vibrant, orientation));
        }

        const candidates = results.map((result) => {
            const candidate: CandidateImage = {
                ...toDisplayImage(result),
                thumbUrl: result.thumbUrl,
            };
            if (result.description !== undefined) {
                candidate.description = result.description;
            }
            if (result.pageDraw !== undefined) {
                candidate.pageDraw = result.pageDraw;
            }
            return candidate;
        });
        return withDraw({ candidates, cause: 'none', source: 'unsplash' });
    } catch (error) {
        diagnostics.warn('Failed to fetch candidate images:', error);
        return withDraw(await candidatesFromStash('threw', imageCategory, vibrant, orientation));
    }
}
