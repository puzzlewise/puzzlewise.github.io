/**
 * Orchestration order over extracted modules: `yieldForPaint()` so the overlay
 * paints before generation, toast (not fail) on unapplicable progress, and
 * `hideLoadingOverlay()` in `finally`.
 *
 * Nothing here may add, remove, or reorder a call reaching
 * `createNewGameAsync`: a share link (and an `__reproPuzzle` replay of one)
 * reproduces a puzzle by re-running this seeded PRNG sequence from the seed
 * alone.
 *
 * Cancellation: there is no download report to guard before generation, so
 * there is no separate abort checkpoint. A canceled load unwinds from inside
 * `createNewGameAsync`'s own signal handling, straight to the `catch` below.
 */

import type { GameState } from '../model/types.js';
import type { SharePayload } from '../sharing/index.js';
import { isDataUrl } from '../sharing/safe-url.js';
import { showLoadingOverlay, hideLoadingOverlay, yieldForPaint, showToast } from '../ui/index.js';
import { createNewGameAsync, GenerationCanceledError } from '../game/index.js';
import { applyProgress } from '../game/reconstruct-groups.js';
import { track } from '../analytics/index.js';
import type { NewGameData, ReplacedGameData } from '../analytics/index.js';
import { shareInitOptions } from './share-payload-to-init.js';
import { buildSharedGameData } from './new-game-payload.js';
import { buildPieceCountMismatchData } from './piece-count-mismatch-payload.js';
import type { PieceCountMismatch } from '../puzzle/topology/generator.js';
import { diagnostics } from '../diagnostics.js';
import type { BackgroundColorControl } from './install-background-color.js';
import type { GameSession } from './game-session.js';

export interface LoadSharedPuzzleDeps {
    container: HTMLElement;
    /** Installs the regenerated puzzle, and rolls it back if applying it fails; never reads the previous one back. */
    session: Pick<GameSession, 'install' | 'uninstall'>;
    fitView: (state: GameState) => void;
    persistNewPuzzle: (state: GameState) => void;
    /**
     * Offers the sharer's color to a recipient who never picked one. Routed
     * through `adopt()`, not the picker, so the current-color id and the
     * picker's selection can't diverge.
     */
    backgroundColor: BackgroundColorControl;
    onGameAnalytics: (data: NewGameData, state: GameState) => void;
    /**
     * Read before `session.install`, which replaces the game it describes.
     * Takes the saved game, which a link opened on a fresh page load replaces
     * without it ever being installed.
     */
    replacedGameAnalytics: (savedState: GameState | undefined) => ReplacedGameData | undefined;
    /**
     * Gates the overlay's Cancel affordance: canceling means "return to your
     * current puzzle", so with nothing installed there is nothing to return to.
     */
    hasCurrentGame: () => boolean;
}

/**
 * @param savedState - The recipient's readable save, if any.
 * @param source - `'shared'` for a real `#p=` link, `'repro'` for a
 * `__reproPuzzle` replay. Only affects the `source` field of
 * `piece-count-mismatch` and `generation-canceled`, separating real incidents
 * from a developer replaying a known-bad puzzle (#512). Defaults to `'shared'`
 * (the real-recipient path), so a binding that is not a real recipient must
 * pass `'repro'` — nothing goes red if it forgets.
 */
export async function loadSharedPuzzle(
    payload: SharePayload,
    savedState: GameState | undefined,
    deps: LoadSharedPuzzleDeps,
    source: 'shared' | 'repro' = 'shared',
): Promise<void> {
    const startedAt = performance.now();
    const controller = new AbortController();
    showLoadingOverlay(
        undefined,
        deps.hasCurrentGame() ? { onCancel: () => controller.abort() } : {},
    );
    try {
        const imageSize = { width: payload.is[0], height: payload.is[1] };

        // Legacy links carry the synthesized white PNG; both mean no image.
        const imageUrl = payload.i === 'blank' || isDataUrl(payload.i)
            ? null
            : payload.i;

        const viewport = {
            width: deps.container.clientWidth || window.innerWidth,
            height: deps.container.clientHeight || window.innerHeight,
        };

        // Let the overlay paint before generation; the yield matters for the
        // sync fallback.
        await yieldForPaint();

        // Fires synchronously during generation; captured here to report
        // below, once the state exists to report it against.
        let pieceCountMismatch: PieceCountMismatch | undefined;
        const { state, generation } = await createNewGameAsync(
            imageUrl,
            imageSize,
            viewport,
            { cols: payload.g[0], rows: payload.g[1] },
            {
                ...shareInitOptions(payload),
                onPieceCountMismatch: (m) => { pieceCountMismatch = m; },
            },
            controller.signal,
        );

        if (payload.a) {
            state.attribution = {
                photographerName: payload.a.n,
                photographerUrl: payload.a.u,
                photoUrl: payload.a.p,
            };
        }

        if (payload.pr) {
            const ok = applyProgress(state, payload.pr);
            if (!ok) {
                showToast("Couldn't load progress — starting from scratch");
            }
        }

        const replaced = deps.replacedGameAnalytics(savedState);

        // Install, fit and save as a unit. A throw before the save leaves a
        // rendered-but-unsaved puzzle the boot fallback would read as finished
        // and refuse to replace (#500), so roll the session back. Past the save
        // the puzzle is on disk and boot restores it, so a later throw needs no
        // rollback — the window closes here.
        try {
            deps.session.install(state);
            deps.fitView(state);
            deps.persistNewPuzzle(state);
        } catch (err) {
            deps.session.uninstall();
            throw err;
        }

        // 'none' means the link carried no color; a present-but-unrecognized
        // id reports as 'invalid' so palette drift that drops a live link's
        // color stays visible in analytics.
        let sharedColor: NonNullable<NewGameData['sharedColor']> = 'none';
        if (payload.bgc !== undefined) {
            sharedColor = deps.backgroundColor.adopt(payload.bgc);
        }

        const data = buildSharedGameData({
            state,
            includesProgress: payload.pr !== undefined,
            recipientHadSavedState: savedState !== undefined,
            sharedColor,
            generation,
        });
        deps.onGameAnalytics(data, state);
        track('new-game-started', { ...data, ...replaced });

        // After the normal event so that still lands first if anything below
        // throws. A diagnostic, never a load blocker.
        if (pieceCountMismatch) {
            const mismatchData =
                buildPieceCountMismatchData(state, pieceCountMismatch, source);
            track('piece-count-mismatch', mismatchData);
            // Console copy for the local loop; see the note in `start-new-game.ts`.
            diagnostics.warn('[piece-count] repro params', mismatchData);
        }
    } catch (err) {
        if (err instanceof GenerationCanceledError) {
            track('generation-canceled', {
                // Real source, not a hardcoded 'shared': `__reproPuzzle` ships
                // in production too, and a developer canceling a replay must
                // not read as a recipient abandoning a real link (#512).
                source,
                cutStyle: payload.c,
                // Post-transpose — the link stores the oriented grid — so this
                // matches `new-game-started`'s cols/rows, and `orientation` is
                // the same taller-than-wide test on that grid.
                orientation: payload.g[1] > payload.g[0] ? 'portrait' : 'landscape',
                cols: payload.g[0],
                rows: payload.g[1],
                elapsedMs: Math.round(performance.now() - startedAt),
            });
            return;
        }
        throw err;
    } finally {
        hideLoadingOverlay();
    }
}
