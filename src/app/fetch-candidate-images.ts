/**
 * Returns `null` when the fetch fails, yields nothing, and the offline stash
 * is empty — the picker shows its inline error state. An error-status answer
 * is tracked one layer down as `image-fetch-http-error`; the thrown path
 * caught here stays untracked.
 */

import { diagnostics } from '../diagnostics.js';
import { track } from '../analytics/index.js';
import { fetchRandomPhotos, CANDIDATE_COUNT, toDisplayImage, type CandidateImage } from '../images/index.js';
import { stashCandidates } from '../images/offline-stash.js';
import { findImageCategory, buildImageQuery, resolveQueryOverride, isCustomQuery } from '../game/image-categories.js';
import type { Orientation } from '../model/types.js';

/** Candidates per picker fetch — one per grid tile, so tied to the tile count. */
export const CANDIDATE_IMAGE_COUNT = CANDIDATE_COUNT;

async function candidatesFromStash(
    cause: 'fetch-failed' | 'no-candidates',
    imageCategory: string,
    vibrant: boolean,
    orientation: Orientation,
): Promise<CandidateImage[] | null> {
    const stash = await stashCandidates(orientation, CANDIDATE_IMAGE_COUNT);
    track('image-stash-fallback', {
        imageCategory,
        orientation,
        vibrant,
        hit: stash.length > 0,
        cause,
    });
    return stash.length > 0 ? stash : null;
}

export async function fetchCandidateImages(
    proxyBaseUrl: string,
    imageCategory: string,
    vibrant: boolean,
    orientation: Orientation,
    queryOverride?: string,
    fetchFn: typeof fetch = fetch,
): Promise<CandidateImage[] | null> {
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
        );

        if (!results || results === 'blocked' || results.length === 0) {
            return await candidatesFromStash('no-candidates', imageCategory, vibrant, orientation);
        }

        return results.map((result) => {
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
    } catch (error) {
        diagnostics.warn('Failed to fetch candidate images:', error);
        return await candidatesFromStash('fetch-failed', imageCategory, vibrant, orientation);
    }
}
