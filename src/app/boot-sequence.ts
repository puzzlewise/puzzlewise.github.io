/**
 * Boot flow priority: a `#p=` share link wins over a saved game, which wins
 * over a fresh start. An unreadable save stops the flow before a fresh puzzle
 * can overwrite it — a recovery dialog holds boot until the player dismisses
 * it, so a fresh start can never race ahead of that decision.
 */

import type { GameState, GridSize } from '../model/types.js';
import type { GameSession } from './game-session.js';
import type { ViewportTransform } from '../interaction/index.js';
import type { StartNewGameOptions } from './start-new-game.js';
import type { CutStyle } from '../game/cut-styles.js';
import { loadSavedGame } from '../persistence/index.js';
import {
    createCorruptSaveDialog,
    hideLoadingOverlay,
    loadRotationEnabledPreference,
} from '../ui/index.js';
import { startWithBootFallback } from './start-with-boot-fallback.js';
import { loadSizePreference, getSizeOption, toGridSize } from '../game/puzzle-sizes.js';
import { loadCutStylePreference } from '../game/cut-styles.js';
import {
    loadComposableConfigPreference,
    composableSliderToGeneratorConfig,
} from '../game/composable-config.js';
import { loadFractalConfigPreference } from '../game/fractal-config.js';
import { loadWavyConfigPreference } from '../game/wavy-config.js';
import {
    loadImageSourcePreference,
    imageSourcePreferenceExists,
} from '../game/image-source.js';
import {
    loadImageCategoryPreference,
    loadVibrantPreference,
    imageCategoryPreferenceExists,
} from '../game/image-categories.js';
import { track } from '../analytics/index.js';

export interface BootSequenceDeps {
    container: HTMLElement;
    /**
     * Not `current` — the fallback gate turns on `hasGame`, and the two are
     * not interchangeable (see `game-session.ts`).
     */
    session: Pick<GameSession, 'install' | 'restoreSelection' | 'hasGame'>;
    viewportTransform: ViewportTransform;
    /** Push the viewport transform to the renderer without persisting it. */
    applyTransform: () => void;
    /** Handle a `#p=` link; true means the boot flow must not start a puzzle. */
    tryLoadShared: () => Promise<boolean>;
    /** True when a rescue reload is imminent — leave the overlay up. */
    isRescueReloadPending: () => boolean;
    start: (gridSize: GridSize, options: StartNewGameOptions) => Promise<void>;
    /** Runs after `session.install`, whose `onInstalled` hook clears the cached analytics (#507). */
    onResumed: (state: GameState) => void;
}

/**
 * Tears down the pre-boot loading overlay in `finally`, except when a
 * share-link rescue reload is imminent — leaving it up avoids a blank-page
 * flash for the up-to-3s gap before the reload fires.
 */
export async function runBootSequence(deps: BootSequenceDeps): Promise<void> {
    try {
        const loadedFromShare = await deps.tryLoadShared();
        if (loadedFromShare) return;

        const saved = loadSavedGame();
        if (saved.status === 'ok') {
            deps.session.install(saved.state);
            deps.onResumed(saved.state);
            if (saved.viewport) {
                // Restore last zoom/pan (#420). Absent on pre-feature saves,
                // which keep the default view.
                deps.viewportTransform.setState(saved.viewport);
                deps.applyTransform();
            }
            deps.session.restoreSelection(saved.selection);
            return;
        }
        if (saved.status === 'unreadable') {
            // Stop before the fresh puzzle overwrites the unreadable save, so
            // the player can download the raw in-memory blobs. The overlay
            // (z-index above the dialog) is hidden so the modal is visible.
            track('save-unreadable', { reason: saved.reason });
            hideLoadingOverlay();
            await new Promise<void>((resolve) => {
                createCorruptSaveDialog({
                    container: deps.container,
                    raw: saved.raw,
                    onDismiss: ({ downloaded }) => {
                        track('save-recovery', { downloaded });
                        resolve();
                    },
                });
            });
        }

        // Mirror the New Game dialog path so a first-load puzzle respects
        // every remembered preference — otherwise the save (and any share link
        // from it) wouldn't match what the user last chose.
        const preferredSizeId = loadSizePreference();
        const option = getSizeOption(preferredSizeId);
        const preferredCutStyle = loadCutStylePreference() as CutStyle;
        const preferredComposable = loadComposableConfigPreference();
        const preferredFractalConfig = loadFractalConfigPreference();
        const preferredWavyConfig = loadWavyConfigPreference();
        const preferredRotationEnabled = loadRotationEnabledPreference();
        // A brand-new visitor (no save, never touched an image preference)
        // gets the bundled image instead of a random one, for a first
        // impression against the default background. An unreadable save means
        // a returning user, who keeps random-image behavior.
        const firstRun = saved.status === 'empty'
            && !imageSourcePreferenceExists()
            && !imageCategoryPreferenceExists();
        const gridSize = toGridSize(option);
        const imageSource = firstRun ? 'first-run' : loadImageSourcePreference();
        const imageCategory = loadImageCategoryPreference();
        const vibrant = loadVibrantPreference();

        await startWithBootFallback({
            cutStyle: preferredCutStyle,
            start: () => deps.start(gridSize, {
                cutStyle: preferredCutStyle,
                composableConfig: preferredCutStyle === 'composable' && preferredComposable
                    ? composableSliderToGeneratorConfig(preferredComposable)
                    : undefined,
                imageSource,
                imageCategory,
                fractalConfig: preferredFractalConfig,
                wavyConfig: preferredWavyConfig,
                vibrant,
                rotationEnabled: preferredRotationEnabled,
            }),
            // Keeps size, image source, category, vibrancy, rotation but
            // drops the per-style configs: with the style forced to Classic
            // they are dead weight, and a saved Composable config the build
            // cannot generate is one of the failures being recovered from.
            startFallback: () => deps.start(gridSize, {
                bootFallback: true,
                imageSource,
                imageCategory,
                vibrant,
                rotationEnabled: preferredRotationEnabled,
            }),
            // Not `current() !== undefined`: `install` makes the state
            // current before it renders and wires interaction, so a throw in
            // that window would report success over a blank canvas (#488).
            // `hasGame()` is false until `install`'s last statement assigns
            // the interaction teardown handle, so it means exactly what this
            // gate needs.
            hasGame: () => deps.session.hasGame(),
        });
    } finally {
        if (!deps.isRescueReloadPending()) hideLoadingOverlay();
    }
}
