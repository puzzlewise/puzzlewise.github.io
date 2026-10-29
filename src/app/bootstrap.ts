/**
 * The composition root: construct the app's singletons, wire them, and kick
 * off boot. `bootstrap` is a function and **this module runs nothing on
 * import**, so the wiring order is testable; `bootstrap.test.ts` pins the
 * orderings that previously held only because of where a statement sat in
 * `main.ts`.
 *
 * Statement order is a contract where the compiler can't enforce it:
 * `installGlobalHandlers` first (analytics up before anything can throw);
 * `installGeometryTokenInvalidation` before boot (a storage event reaches only
 * a document already listening, never replayed); the `hashchange` listener
 * after boot is kicked off (boot runs synchronously to its first await). The
 * rotation-UI-before-session and toolbar-before-sharedDeps orders are plain
 * data dependencies the compiler holds. Each is detailed at its call site.
 */

import type { GameState, PieceGroup } from '../model/types.js';
import type { MergeResult } from '../game/group-merging.js';
import { SvgDomRenderer } from '../renderer/index.js';
import { ViewportTransform, RotationFocus } from '../interaction/index.js';
import {
    createAttributionElement,
    removeAttribution,
} from '../ui/index.js';
import { SelectionManager } from '../interaction/selection-manager.js';
import type { NewGameData, ReplacedGameData } from '../analytics/index.js';
import {
    clearGameContext,
    loadGameContext,
    loadGameStartedAt,
    saveGameContext,
} from '../analytics/game-context.js';
import { elapsedMsSince } from './game-clock.js';
import { buildReplacedGameData } from './replaced-game-payload.js';
import { startNewGame, type StartNewGameDeps } from './start-new-game.js';
import { loadSharedPuzzle, type LoadSharedPuzzleDeps } from './load-shared-puzzle.js';
import { createShareLinkLoader } from './share-link-loader.js';
import { runBootSequence } from './boot-sequence.js';
import { createPuzzleImageLoadTracker } from './puzzle-image-load.js';
import { reportPuzzleCreditOpened } from './puzzle-credit.js';
import { openNewGameDialog } from './new-game-flow.js';
import { createCompletionPresenter } from './completion-presenter.js';
import { gatherAndZoomToFit, zoomToFitCompletedPuzzle, type ViewportFitDeps } from './viewport-fit.js';
import { createSaveCoordinator } from './save-coordinator.js';
import { applyMergeResult } from './merge-result.js';
import { createGameSession } from './game-session.js';
import { createRotationUi, type RotationUi } from './rotation-ui.js';
import { installBackgroundColor } from './install-background-color.js';
import { installGlobalHandlers } from './global-handlers.js';
import { installToolbar } from './install-toolbar.js';
import { installDevHooks, solvePuzzle } from './dev-hooks.js';
import { installGeometryTokenInvalidation } from '../persistence/index.js';
import { initPwaUpdates } from '../pwa/register.js';
import { movedToUrl } from '../move/move-config.js';
import { createMoveSource, redirectShareLink } from '../move/move-source.js';
import { isReceiveMode, runMoveReceiver } from '../move/move-receiver.js';

/**
 * `root` defaults to `#app`, evaluated at call time: `main.ts` stays free of
 * any DOM lookup while a test can pass its own container — and importing this
 * module boots nothing.
 */
export function bootstrap(
    root: HTMLElement = document.querySelector<HTMLDivElement>('#app')!,
): void {
    installGlobalHandlers(root);

    if (isReceiveMode()) {
        void runMoveReceiver({ container: root });
        return;
    }

    const movedTo = movedToUrl();
    if (movedTo !== undefined && redirectShareLink(movedTo)) return;

    // Distrust the persisted geometry-ownership token once another tab touches
    // the geometry, or on bfcache restore that missed those events. Ahead of
    // boot: a storage event reaches only a document already listening and is
    // never replayed, so any event-loop turn before this loses cross-tab
    // writes.
    installGeometryTokenInvalidation();

    /**
     * `createOnInstalled` clears it on every install (#507): both start flows
     * install first and assign this several statements later, so a throw in
     * that gap would otherwise cache the *previous* puzzle's payload against
     * the *new* game and misattribute its completion.
     */
    let currentGameAnalytics: Partial<NewGameData> | null = null;
    let currentGameResumed = false;
    let currentGameStartedAt: number | undefined;

    const renderer = new SvgDomRenderer();
    renderer.init(root);

    const selectionManager = new SelectionManager();

    const rotationFocus = new RotationFocus();

    const completionPresenter = createCompletionPresenter({ container: root, rotationFocus });

    // Selection is stored alongside the game state, so it clears on deselect /
    // new game and never leaks into share links.
    selectionManager.onChange((selectedIds) => {
        const state = session.current();
        for (const group of state?.groups ?? []) {
            renderer.setGroupSelected(group.id, selectedIds.has(group.id));
        }
        if (state) saveCoordinator.autoSave(state);
    });

    const viewportTransform = new ViewportTransform();

    function applyViewportTransform(): void {
        const state = viewportTransform.getState();
        renderer.setViewportTransform(state.scale, state.offset.x, state.offset.y);
    }

    const viewportFitDeps: ViewportFitDeps = {
        container: root,
        renderer,
        viewportTransform,
        applyTransform: applyViewportTransform,
        // Late-bound: the completion cleanup fires up to 1000ms later, by
        // which time a new game may have started or (boot failed) none is
        // installed. Nothing installed means nothing to re-render — skip
        // rather than throw, which would abort the cleanup before the overlay.
        renderCurrent: () => {
            const state = session.current();
            if (state) renderer.renderState(state);
        },
    };

    /** Persists the view via debounced auto-save so zoom/pan survive a reload (#420). */
    function onViewportChanged(): void {
        applyViewportTransform();
        const state = session.current();
        if (state) saveCoordinator.autoSave(state);
    }

    // Installs its own pagehide / visibilitychange listeners on construction.
    const saveCoordinator = createSaveCoordinator({ selectionManager, viewportTransform });

    /** Shared by the rotation UI and game session so both merge through the same follow-up. */
    const applyMerge = (
        state: GameState,
        result: MergeResult,
        droppedGroupIds: readonly number[],
    ): void => {
        applyMergeResult(state, result, droppedGroupIds, {
            renderer,
            selectionManager,
            rotationFocus,
            currentGameAnalytics: () => currentGameAnalytics,
            isResumedGame: () => currentGameResumed,
            gameStartedAt: () => currentGameStartedAt,
            onCompleted: onPuzzleCompleted,
        });
    };

    const puzzleImageLoad = createPuzzleImageLoadTracker({ photoSettled: () => renderer.photoSettled() });

    // Before `session` — see `createOnInstalled` for why the compiler enforces it.
    const rotationUi = createRotationUi({
        container: root,
        renderer,
        viewportTransform,
        selectionManager,
        rotationFocus,
        getState: () => session.current(),
        save: (state) => saveCoordinator.autoSave(state),
        applyMerge,
    });

    /**
     * Takes `syncRotationUi` as a parameter so the call site reads
     * `rotationUi.syncVisibility` as a bare value in `createGameSession`'s
     * argument list — making a `createGameSession`-before-`createRotationUi`
     * reorder a use-before-declaration error the compiler reports.
     *
     * **Do not inline this into the deps literal.** That puts the read back
     * inside a closure and the compile-time guard silently disappears, leaving
     * only `bootstrap.test.ts` between a reorder and a TDZ crash at boot.
     */
    function createOnInstalled(
        syncRotationUi: RotationUi['syncVisibility'],
    ): (state: GameState) => void {
        return (state) => {
            puzzleImageLoad.abandon();
            // Drop the outgoing puzzle's cached analytics (#507; the field's
            // contract covers why this can't wipe the incoming game's payload).
            currentGameAnalytics = null;
            currentGameResumed = false;
            currentGameStartedAt = undefined;
            // Remove the previous game's overlay first — `show` no-ops while
            // one is already up.
            completionPresenter.remove();
            updateAttribution(state);
            syncRotationUi(state);
            if (state.completed) {
                completionPresenter.show(state);
            }
        };
    }

    // Owns the installed game and its interaction wiring. Readers go through
    // `session.current()` (`GameState | undefined`) — boot can fail and
    // install nothing (#488).
    const session = createGameSession({
        container: root,
        renderer,
        viewportTransform,
        selectionManager,
        rotationFocus,
        onInstalled: createOnInstalled(rotationUi.syncVisibility),
        save: (state) => saveCoordinator.autoSave(state),
        cancelPendingSave: () => saveCoordinator.cancel(),
        applyMerge,
        onViewportChanged,
        applyTransform: applyViewportTransform,
    });

    // The save coordinator flushes first so progress within the debounce
    // window survives the update reload.
    const pwaUpdates = initPwaUpdates(() => saveCoordinator.flush());

    /**
     * Reads the session late: the zoom settles up to ~1000ms later, by which
     * time a new game may have replaced this one, and the overlay's "Challenge
     * a friend" link is built from the state it's given. The settle has no
     * cancel handle, so `session.current() === state` (not a bare "something
     * installed") is what keeps a stale celebration — fresh game, restored
     * save, a second puzzle solved inside this zoom — from showing the wrong
     * link. Shared by both completion routes so they can't drift apart.
     */
    function celebrateCompletion(state: GameState, group: PieceGroup): void {
        zoomToFitCompletedPuzzle(state, group, viewportFitDeps, () => {
            if (session.current() === state) completionPresenter.show(state);
        });
    }

    /** `onCompleted` for `applyMergeResult`: it detects the win, the viewport stays here. */
    function onPuzzleCompleted(state: GameState): void {
        if (state.groups.length === 1) {
            celebrateCompletion(state, state.groups[0]);
        } else {
            // Fallback (shouldn't happen post-completion). Shows `state`
            // directly — nothing defers here, so it equals the session.
            completionPresenter.show(state);
        }
    }

    function updateAttribution(state: GameState): void {
        removeAttribution(root);

        if (state.attribution) {
            const el = createAttributionElement(
                state.attribution,
                (link) => reportPuzzleCreditOpened(link, currentGameAnalytics?.imagePhotoId),
            );
            root.appendChild(el);
        }
    }

    let savedNewPuzzle: GameState | null = null;

    function replacedGameAnalytics(savedState?: GameState): ReplacedGameData | undefined {
        const installed = session.hasGame() ? session.current() : undefined;
        if (installed) {
            return buildReplacedGameData(installed, elapsedMsSince(currentGameStartedAt, Date.now()));
        }
        if (savedState) {
            const savedStartedAt = loadGameStartedAt(savedState.seed);
            return buildReplacedGameData(savedState, elapsedMsSince(savedStartedAt, Date.now()));
        }
        return undefined;
    }

    /**
     * `fitView` folds gather-and-zoom-to-fit with a follow-up render:
     * `session.install` already rendered at pre-gather positions, so the
     * repositioning needs a second render to reach the screen.
     */
    const startNewGameDeps: StartNewGameDeps = {
        container: root,
        session,
        resetViewport: () => {
            viewportTransform.reset();
            applyViewportTransform();
        },
        fitView: (state) => {
            gatherAndZoomToFit(state, viewportFitDeps);
            renderer.renderState(state);
        },
        persistNewPuzzle: (state) => {
            if (saveCoordinator.persistNewPuzzle(state)) {
                savedNewPuzzle = state;
                clearGameContext();
            } else {
                savedNewPuzzle = null;
            }
        },
        onGameAnalytics: (data, state) => {
            puzzleImageLoad.observe(state, data.source === 'shared' ? 'shared' : 'new', data.imagePhotoId);
            currentGameAnalytics = data;
            currentGameStartedAt = Date.now();
            if (state === savedNewPuzzle) saveGameContext(state.seed, data, currentGameStartedAt);
        },
        replacedGameAnalytics,
        // `hasGame()`, not `current() !== undefined` (same distinction as
        // `boot-sequence.ts`): `install` makes the state current before wiring
        // interaction, so `current()` can be set over a blank canvas — and
        // Cancel's "return to your current puzzle" is the interactive question.
        hasCurrentGame: () => session.hasGame(),
    };

    /**
     * One solve binding, shared by `window.__solvePuzzle` and the info modal's
     * Solve button and handed to both `installDevHooks` and `installToolbar`.
     * While each owned its own `solvePuzzle` call an edit to either `onSolved`
     * would silently desync the console hook from the button.
     */
    const solve = (): void =>
        solvePuzzle({
            session,
            renderer,
            gameStartedAt: () => currentGameStartedAt,
            onSolved: celebrateCompletion,
        });

    installDevHooks({
        // 'dev': exclusively dev-console starts (e.g. `__newComposableGame`).
        // Dev-deploy shares production's Umami website ID, so without this a
        // developer's cut-parameter games inflate the field-incident count.
        // The dev-build new-game dialog is another route to a sine config but
        // stays 'fresh' — labeling it would also suppress genuine Classic/Wavy
        // mismatches from the real production path; those dev rows are
        // separable by query (see `PieceCountMismatchData`'s `source` note).
        start: (gridSize, options) => startNewGame(gridSize, options, startNewGameDeps, 'dev'),
        // 'repro': exclusively `__reproPuzzle`'s replay path, never a real
        // `#p=` link — a mismatch it surfaces is a developer re-running a
        // known-bad puzzle, not a field incident.
        loadShared: (payload, savedState) =>
            loadSharedPuzzle(payload, savedState, sharedDeps, 'repro'),
        solve,
    });

    const moveSource = movedTo === undefined
        ? undefined
        : createMoveSource({
            container: root,
            targetUrl: movedTo,
            flushSave: () => saveCoordinator.flush(),
        });

    /**
     * `installToolbar` invokes `installBackgroundColorControl` between the
     * deselect and Info buttons and hands the handle back. The installer is
     * passed as a dependency (not reached for) so `install-toolbar.test.ts`
     * can substitute a marker div without touching localStorage and an SVG
     * filter. Returned rather than assigned to an outer binding to keep
     * `sharedDeps` honest: a side-effect `let backgroundColor!` type-checks
     * even if never assigned, and the `undefined` would surface only after the
     * shared puzzle is installed (#500's half-applied state).
     */
    const backgroundColor = installToolbar({
        container: root,
        session,
        selectionManager,
        fitView: startNewGameDeps.fitView,
        save: (state) => saveCoordinator.autoSave(state),
        onNewGame: () => {
            const openDialog = (): void => openNewGameDialog({
                container: root,
                start: (gridSize, options) => startNewGame(gridSize, options, startNewGameDeps),
                currentGame: () => session.current(),
            });
            if (moveSource) moveSource.onNewGame(openDialog);
            else openDialog();
        },
        installBackgroundColorControl: () => installBackgroundColor({ container: root }),
        solve,
    });

    /**
     * Reuses `startNewGameDeps`'s `fitView` / `persistNewPuzzle` /
     * `onGameAnalytics` — installing a generated puzzle is the same fresh or
     * shared. Built after `installToolbar`, which returns `backgroundColor`.
     */
    const sharedDeps: LoadSharedPuzzleDeps = {
        container: root,
        session,
        fitView: startNewGameDeps.fitView,
        persistNewPuzzle: startNewGameDeps.persistNewPuzzle,
        backgroundColor,
        onGameAnalytics: startNewGameDeps.onGameAnalytics,
        replacedGameAnalytics,
        hasCurrentGame: startNewGameDeps.hasCurrentGame,
    };

    const shareLinks = createShareLinkLoader({
        loadShared: (payload, savedState) =>
            loadSharedPuzzle(payload, savedState, sharedDeps),
        attemptRescue: () => pwaUpdates.attemptShareLinkRescue(),
    });

    void runBootSequence({
        container: root,
        session,
        viewportTransform,
        applyTransform: applyViewportTransform,
        tryLoadShared: () => shareLinks.tryLoad(),
        isRescueReloadPending: () => shareLinks.isRescueReloadPending(),
        start: (gridSize, options) => startNewGame(gridSize, options, startNewGameDeps),
        onResumed: (state) => {
            currentGameAnalytics = loadGameContext(state.seed);
            puzzleImageLoad.observe(state, 'resume', currentGameAnalytics?.imagePhotoId);
            currentGameResumed = true;
            currentGameStartedAt = loadGameStartedAt(state.seed);
        },
    });

    // Handle a share link pasted into an already-loaded tab: the hash changes
    // but nothing reacts otherwise. `history.replaceState` inside
    // `shareLinks.tryLoad` doesn't fire hashchange, so no loop risk. Registered
    // after boot is kicked off (boot runs synchronously to its first await).
    window.addEventListener('hashchange', () => {
        if (movedTo !== undefined && redirectShareLink(movedTo)) return;
        void shareLinks.tryLoad();
    });

    moveSource?.showBanner();
}
