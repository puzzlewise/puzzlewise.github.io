/**
 * The dev-console `window.__*` hooks: `__solvePuzzle`, `__startVennPuzzle`,
 * `__newComposableGame`, `__reproPuzzle`. Used directly from the browser
 * console, so their names, signatures, and return values must not drift.
 *
 * `solvePuzzle` is exported separately so the composition root binds it once
 * and hands that one reference to both `window.__solvePuzzle` and the info
 * modal's Solve button — one binding they can't desynchronize.
 */

import type { GameState, GridSize, PieceGroup } from '../model/types.js';
import type { Renderer } from '../renderer/index.js';
import { buildGroupIndexes } from '../model/helpers.js';
import type { ComposableConfig } from '../puzzle/composable-generator.js';
import {
    type SharePayload,
    encodePayload,
    decodePayload,
    reproParamsToPayload,
    type ReproParams,
} from '../sharing/index.js';
import { loadState } from '../persistence/index.js';
import { loadImageSourcePreference } from '../game/image-source.js';
import {
    loadImageCategoryPreference,
    loadVibrantPreference,
} from '../game/image-categories.js';
import { runWithErrorReport } from './run-with-error-report.js';
import { track } from '../analytics/index.js';
import type { PuzzleSolvedData } from '../analytics/index.js';
import { gameProgress } from './game-progress.js';
import { elapsedMsSince } from './game-clock.js';
import type { StartNewGameOptions } from './start-new-game.js';
import type { GameSession } from './game-session.js';

export interface SolvePuzzleDeps {
    /** Read-only slice: solves whatever is installed, never replaces it. */
    session: Pick<GameSession, 'current'>;
    renderer: Renderer;
    gameStartedAt: () => number | undefined;
    onSolved: (state: GameState, group: PieceGroup) => void;
}

/**
 * No-op when there is no installed game (#488/#499): reached from the Solve
 * button or a console call, either of which can hit the no-game state a
 * failed boot leaves behind.
 */
export function solvePuzzle(deps: SolvePuzzleDeps): void {
    const state = deps.session.current();
    if (!state) return;
    if (!state.completed) reportSolve(state, deps.gameStartedAt());

    const solvedGroup: PieceGroup = {
        id: 0,
        pieces: new Map(),
        position: { x: 0, y: 0 },
        rotation: 0,
    };

    for (const piece of state.pieces) {
        solvedGroup.pieces.set(piece.id, {
            x: -piece.imageOffset.x,
            y: -piece.imageOffset.y,
        });
    }

    state.groups = [solvedGroup];
    const solvedIndexes = buildGroupIndexes(state.groups);
    state.groupsById = solvedIndexes.groupsById;
    state.pieceToGroup = solvedIndexes.pieceToGroup;
    state.completed = true;
    deps.renderer.renderState(state);

    deps.onSolved(state, solvedGroup);
}

function reportSolve(state: GameState, startedAt: number | undefined): void {
    const data: PuzzleSolvedData = {
        progress: gameProgress(state),
        pieceCount: state.pieces.length,
        cutStyle: state.cutStyle ?? 'classic',
    };
    const elapsedMs = elapsedMsSince(startedAt, Date.now());
    if (elapsedMs !== undefined) data.elapsedMs = elapsedMs;
    track('puzzle-solved', data);
}

export interface DevHooksDeps {
    start: (gridSize: GridSize, options: StartNewGameOptions) => Promise<void>;
    loadShared: (payload: SharePayload, savedState: GameState | undefined) => Promise<void>;
    /**
     * Injected, not built here, so `window.__solvePuzzle` and the settings modal's
     * Solve button are the same reference — otherwise an edit to either
     * `onSolved` would silently desync them.
     */
    solve: () => void;
}

export function installDevHooks(deps: DevHooksDeps): void {
    // The same reference the settings modal's Solve button calls.
    (window as { __solvePuzzle?: unknown }).__solvePuzzle = deps.solve;

    /**
     * Dev-console hook for smoke-testing the experimental two-circle Venn cut
     * style. Not in any UI. Caveat: share links and reloads don't preserve the
     * venn config — only the in-memory render is meaningful; a reload falls
     * back to sine defaults.
     */
    (window as { __startVennPuzzle?: unknown }).__startVennPuzzle = (overrides?: {
        leftCenter?: { x: number; y: number };
        leftRadius?: number;
        rightCenter?: { x: number; y: number };
        rightRadius?: number;
        tabs?: boolean;
    }) => {
        const baseCutConfig = {
            leftCenter: overrides?.leftCenter ?? { x: 432, y: 360 },
            leftRadius: overrides?.leftRadius ?? 240,
            rightCenter: overrides?.rightCenter ?? { x: 648, y: 360 },
            rightRadius: overrides?.rightRadius ?? 240,
        };
        void deps.start({ cols: 1, rows: 1 }, {
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'venn',
                baseCutConfig,
                tabGenerator: overrides?.tabs ? 'classic' : 'none',
                tabConfig: {},
            },
            imageSource: 'blank',
        });
    };

    /**
     * Dev-console hook for a Composable puzzle with arbitrary generator
     * parameters — Composable is hidden from the production new-game dialog,
     * so this is the only route to the full surface.
     */
    (window as { __newComposableGame?: unknown }).__newComposableGame = (overrides?: {
        cols?: number;
        rows?: number;
        baseCutGenerator?: string;
        baseCutConfig?: Record<string, unknown>;
        tabGenerator?: string;
        tabConfig?: Record<string, unknown>;
        minPieceArea?: number;
        rotation?: 'none' | 'free';
        imageSource?: 'random' | 'blank';
        seed?: number;
    }) => {
        const cols = overrides?.cols ?? 8;
        const rows = overrides?.rows ?? 6;
        const baseCutConfig = overrides?.baseCutConfig ?? {
            cols, rows, ha: 0.15, hf: 1.5, va: 0.15, vf: 1.5,
        };
        const config: ComposableConfig = {
            baseCutGenerator: overrides?.baseCutGenerator ?? 'sine',
            baseCutConfig,
            tabGenerator: overrides?.tabGenerator ?? 'classic',
            tabConfig: overrides?.tabConfig ?? {},
        };
        if (overrides?.minPieceArea !== undefined) {
            config.minPieceArea = overrides.minPieceArea;
        }
        const rotation = overrides?.rotation ?? 'none';
        void deps.start({ cols, rows }, {
            cutStyle: 'composable',
            composableConfig: config,
            imageSource: overrides?.imageSource ?? loadImageSourcePreference(),
            imageCategory: loadImageCategoryPreference(),
            vibrant: loadVibrantPreference(),
            rotationEnabled: rotation !== 'none',
            seed: overrides?.seed,
        });
    };

    /**
     * Dev-console hook: regenerate a puzzle from the settings modal's
     * "Reproduction parameters" JSON. The params run through the share codec's
     * validation and clamps and the share-link load path, so semantics match a
     * share link exactly. `imageUrl: 'blank'` (or absent) renders blank at the
     * recorded size — geometry depends on dimensions, not pixels; attribution
     * and background aren't params, so a replayed Unsplash puzzle loses credit.
     * Replaces the current game and save without confirmation once the replay
     * lands, but leaves the address bar alone so a `#p=` link stays reloadable.
     *
     * The previous save is left intact until `loadShared`'s own
     * `persistNewPuzzle` replaces it, so a canceled or failing replay keeps it.
     * Resolves `true` once on screen, `false` on failure. A cancel also
     * resolves `true` (nothing installed) and emits `generation-canceled`, so
     * don't read `true` as "these params generated".
     */
    (window as { __reproPuzzle?: unknown }).__reproPuzzle = async (params: ReproParams): Promise<boolean> => {
        let payload: SharePayload;
        let decoded: SharePayload | null;
        try {
            payload = reproParamsToPayload(params);
            decoded = decodePayload(encodePayload(payload));
        } catch (err) {
            // The error object, not its message, so the console keeps the stack.
            // eslint-disable-next-line no-console
            console.error('[__reproPuzzle]', err);
            return false;
        }
        if (!decoded) {
            // `decodePayload` returns a bare `null`, so which field failed is
            // structurally unavailable — echoing the mapped payload is the only
            // signal to the caller. The throwing steps above already name most
            // hand-typing mistakes, so what reaches here is a rejected
            // `composableConfig` or an unsafe/empty/non-string `imageUrl`.
            //
            // A non-boolean `borderless` is deliberately NOT rejected:
            // `applyStyleConfigs` coerces with `=== true`, so `"true"` replays
            // borderless OFF — faithful to generation but silent, so a repro
            // that comes back bordered means the flag was typed as a string.
            // eslint-disable-next-line no-console
            console.error('[__reproPuzzle] params did not survive share-codec validation', payload);
            return false;
        }
        // Const captures the narrowing: the async closure below would un-narrow
        // if `decoded` gained a second assignment.
        const validated = decoded;
        const savedState = loadState();
        // Previous save left alone until `loadShared`'s own `persistNewPuzzle`
        // replaces it on success — same fix as `share-link-loader.ts`; an eager
        // clear used to destroy it on a canceled or failing replay too.
        return runWithErrorReport({
            run: async () => {
                await deps.loadShared(validated, savedState);
                return true;
            },
            warnMessage: 'Failed to load repro puzzle:',
            // Readable on a deployed build: a generation failure is what this
            // helper investigates, and the default diagnostic is DEV-gated.
            logInProduction: true,
            event: 'shared-load-failed',
            // Not a user-facing share-link failure: often the reason this was called.
            source: 'repro',
            toastMessage: "Couldn't load repro puzzle",
            fallback: false,
        });
    };
}
