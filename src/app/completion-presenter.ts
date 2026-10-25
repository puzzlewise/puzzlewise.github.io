/**
 * Presenter for the "Puzzle Complete!" overlay, owning the re-entrancy guard
 * around `showCompletionOverlay`. The `hide` handle clears two ways — the
 * caller's `remove()` or the player dismissing — and both must
 * leave the presenter able to show again.
 */

import type { GameState } from '../model/types.js';
import type { RotationFocus } from '../interaction/index.js';
import { showCompletionOverlay } from '../ui/index.js';

export interface CompletionPresenter {
    /** No-op while one is already up. */
    show(state: GameState): void;
    remove(): void;
}

export function createCompletionPresenter(deps: {
    container: HTMLElement;
    rotationFocus: RotationFocus;
}): CompletionPresenter {
    const { container, rotationFocus } = deps;
    let hideCurrent: (() => void) | null = null;

    return {
        show(state: GameState): void {
            if (hideCurrent) return;
            // Clear focus so visible rotate buttons quick-fade out before the
            // celebratory zoom, rather than lingering over the overlay.
            rotationFocus.clearFocus();
            hideCurrent = showCompletionOverlay({
                container,
                state,
                onDismiss: () => {
                    hideCurrent = null;
                },
            });
        },

        remove(): void {
            hideCurrent?.();
            hideCurrent = null;
        },
    };
}
