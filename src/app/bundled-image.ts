/**
 * The image bundled with the app (`public/first-puzzle.jpg`): the first puzzle
 * for a brand-new visitor (chosen to contrast with the default background),
 * and the fallback when the Unsplash fetch fails.
 *
 * The legacy fallback asset `public/puzzle-image.jpg` must stay deployed
 * untouched: old saves and share links reference it with 800×600 geometry.
 */

import type { ImageAttribution, Size, Orientation } from '../model/types.js';
import { BUNDLED_IMAGE_URL, BUNDLED_PORTRAIT_IMAGE_URL } from '../images/bundled-image-urls.js';

export { BUNDLED_IMAGE_URL, BUNDLED_PORTRAIT_IMAGE_URL };

export const BUNDLED_IMAGE_SIZE = { width: 1080, height: 722 };

export const BUNDLED_IMAGE_ATTRIBUTION: ImageAttribution = {
    photographerName: 'Barney Goodman',
    photographerUrl:
        'https://unsplash.com/@bgoodpic?utm_source=puzzle&utm_medium=referral',
    photoUrl:
        'https://unsplash.com/photos/BS-bOYlt_Lg?utm_source=puzzle&utm_medium=referral',
};

export const BUNDLED_PORTRAIT_IMAGE_SIZE = { width: 1080, height: 1614 };

export const BUNDLED_PORTRAIT_IMAGE_ATTRIBUTION: ImageAttribution = {
    photographerName: 'Barney Goodman',
    photographerUrl:
        'https://unsplash.com/@bgoodpic?utm_source=puzzle&utm_medium=referral',
    photoUrl:
        'https://unsplash.com/photos/q5BV6DBTpFM?utm_source=puzzle&utm_medium=referral',
};

export interface BundledImage {
    url: string;
    size: Size;
    attribution: ImageAttribution;
}

export function pickBundledImage(orientation: Orientation): BundledImage {
    return orientation === 'portrait'
        ? {
            url: BUNDLED_PORTRAIT_IMAGE_URL,
            size: BUNDLED_PORTRAIT_IMAGE_SIZE,
            attribution: BUNDLED_PORTRAIT_IMAGE_ATTRIBUTION,
        }
        : {
            url: BUNDLED_IMAGE_URL,
            size: BUNDLED_IMAGE_SIZE,
            attribution: BUNDLED_IMAGE_ATTRIBUTION,
        };
}
