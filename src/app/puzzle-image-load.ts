import { track } from '../analytics/index.js';
import type { GameState } from '../model/types.js';
import { classifyImageSource } from './classify-image-source.js';

export type PuzzleImageTrigger = 'new' | 'resume' | 'shared';

export interface PuzzleImageLoadTracker {
    observe(state: GameState, trigger: PuzzleImageTrigger, photoId?: string): void;
    abandon(): void;
}

export function createPuzzleImageLoadTracker(deps: {
    /** The renderer's settle for the puzzle it rendered last; see `Renderer.photoSettled`. */
    photoSettled: () => Promise<'loaded' | 'failed'>;
    now?: () => number;
}): PuzzleImageLoadTracker {
    const now = deps.now ?? (() => performance.now());
    let settlePending: ((outcome: 'loaded' | 'failed' | 'abandoned') => void) | undefined;

    function abandon(): void {
        settlePending?.('abandoned');
    }

    return {
        observe(state, trigger, photoId) {
            abandon();
            const imageUrl = state.imageUrl;
            if (imageUrl === null) return;

            const startedAt = now();
            const settle = (outcome: 'loaded' | 'failed' | 'abandoned'): void => {
                if (settlePending !== settle) return;
                settlePending = undefined;
                track('puzzle-image-loaded', {
                    outcome,
                    ms: Math.round(now() - startedAt),
                    trigger,
                    imageSource: classifyImageSource(imageUrl),
                    ...(photoId === undefined ? {} : { imagePhotoId: photoId }),
                });
            };
            settlePending = settle;
            void deps.photoSettled().then(settle);
        },
        abandon,
    };
}
