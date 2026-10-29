/**
 * Shared Unsplash-result → display-model mapping (used by `resolve-image.ts` and
 * `fetch-candidate-images.ts`), so the 1080-scale math and attribution shape
 * stay in one place. The "regular" URL is 1080px wide; height comes from the
 * original aspect ratio.
 */

import type { PageDraw, UnsplashImageResult } from './unsplash.js';

export interface DisplayImage {
    imageUrl: string;
    imageSize: { width: number; height: number };
    attribution: {
        photographerName: string;
        photographerUrl: string;
        photoUrl: string;
    };
    /** Unsplash download-reporting endpoint, triggered when the game starts. */
    downloadLocation: string;
    /** Set only on fresh page draws, never on stash or pool images. */
    pageDraw?: PageDraw;
}

/**
 * `extends DisplayImage` keeps the superset relationship compiler-enforced,
 * so the two shapes can't silently drift.
 */
export interface CandidateImage extends DisplayImage {
    /** Small URL hotlinked as the grid thumbnail (Unsplash `small`). */
    thumbUrl: string;
    /** Alt text, when Unsplash provides one. */
    description?: string;
}

export type CandidateCause = 'none' | 'http-error' | 'blocked' | 'empty-page' | 'threw';

export interface CandidateFetchResult {
    candidates: CandidateImage[];
    /** Why no network photos came back; `'none'` when they did. */
    cause: CandidateCause;
    source: 'unsplash' | 'stash' | 'none';
    /** The page requested from Unsplash, also when it failed; absent when none was. */
    draw?: PageDraw;
}

export const CANDIDATE_COUNT = 4;

/** Width the Unsplash "regular" URL scales images to. */
const DISPLAY_WIDTH = 1080;

export function toDisplayImage(result: UnsplashImageResult): DisplayImage {
    const aspectRatio = result.height / result.width;
    return {
        imageUrl: result.imageUrl,
        imageSize: {
            width: DISPLAY_WIDTH,
            height: Math.round(DISPLAY_WIDTH * aspectRatio),
        },
        attribution: {
            photographerName: result.photographerName,
            photographerUrl: result.photographerUrl,
            photoUrl: result.photoUrl,
        },
        downloadLocation: result.downloadLocation,
    };
}
