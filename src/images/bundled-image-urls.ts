/**
 * Lives alone so `src/pwa/sw.ts` can import it: the worker is type-checked
 * under `tsconfig.sw.json`'s WebWorker lib, so anything it pulls in must stay
 * free of DOM references.
 */

/** Relative URL — resolves against the app origin, like all bundled assets. */
export const BUNDLED_IMAGE_URL = 'first-puzzle.jpg';

export const BUNDLED_PORTRAIT_IMAGE_URL = 'first-puzzle-portrait.jpg';
