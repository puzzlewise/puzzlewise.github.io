/**
 * @vitest-environment jsdom
 */

/**
 * Wiring-order tests for the composition root. These orderings held only
 * because of where statements sat in `main.ts` — a file no test could import;
 * pinned here as contracts. Includes the one agreement no statement order can
 * enforce: `installDevHooks` and `installToolbar` must get the *same* `solve`
 * reference, or `window.__solvePuzzle` and the Solve button drift apart.
 *
 * Most collaborators are spy-*wrapped* so the real implementations still run.
 * `global-handlers`, `boot-sequence`, `start-new-game`, `load-shared-puzzle`
 * and `new-game-flow` are replaced outright: they reach analytics, the
 * network, the save file, or the dialog's own preference loading and DOM.
 */

import {
    describe, it, expect, beforeEach, afterEach, onTestFinished, vi, type Mock, type MockInstance,
} from 'vitest';
import type { GameState, PieceGroup } from '../model/types.js';
import type { MergeResult } from '../game/group-merging.js';
import type { SharePayload } from '../sharing/index.js';
import { makeGameState, makeSavedGameState, makeRectPiece } from '../test-helpers/fixtures.js';

// `virtual:pwa-register` exists only at build time, so the real module can't
// load under Vitest (see `pwa/register.ts`).
vi.mock('../pwa/register.js', () => ({
    initPwaUpdates: vi.fn(() => ({
        attemptShareLinkRescue: vi.fn(async () => 'no-update' as const),
    })),
}));

vi.mock('./global-handlers.js', () => ({ installGlobalHandlers: vi.fn() }));
vi.mock('./boot-sequence.js', () => ({ runBootSequence: vi.fn(async () => {}) }));
vi.mock('./start-new-game.js', () => ({ startNewGame: vi.fn(async () => {}) }));
vi.mock('./load-shared-puzzle.js', () => ({ loadSharedPuzzle: vi.fn(async () => {}) }));
// Replaced outright, not spy-wrapped, so calling `onNewGame` doesn't run the
// real dialog's preference loading and DOM construction.
vi.mock('./new-game-flow.js', () => ({ openNewGameDialog: vi.fn() }));

vi.mock('./rotation-ui.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./rotation-ui.js')>();
    return {
        ...actual,
        // Spy the *returned* `syncVisibility`: `bootstrap` reads it as a bare
        // value at construction, so a later spy wouldn't be the session's ref.
        createRotationUi: vi.fn((deps: Parameters<typeof actual.createRotationUi>[0]) => {
            const ui = actual.createRotationUi(deps);
            return { ...ui, syncVisibility: vi.fn(ui.syncVisibility) };
        }),
    };
});

vi.mock('./game-session.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./game-session.js')>();
    return { ...actual, createGameSession: vi.fn(actual.createGameSession) };
});

vi.mock('./share-link-loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./share-link-loader.js')>();
    return {
        ...actual,
        createShareLinkLoader: vi.fn((deps: Parameters<typeof actual.createShareLinkLoader>[0]) => {
            const loader = actual.createShareLinkLoader(deps);
            return { ...loader, tryLoad: vi.fn(loader.tryLoad) };
        }),
    };
});

// The real zoom waits on rAF plus a `transitionend` that never fires in
// jsdom, so the settle callback is captured from the mock and invoked by
// hand — also the only way to observe what the overlay reads at settle time.
vi.mock('./viewport-fit.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./viewport-fit.js')>();
    return { ...actual, zoomToFitCompletedPuzzle: vi.fn() };
});

vi.mock('./completion-presenter.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./completion-presenter.js')>();
    return {
        ...actual,
        createCompletionPresenter: vi.fn(
            (deps: Parameters<typeof actual.createCompletionPresenter>[0]) => {
                const presenter = actual.createCompletionPresenter(deps);
                return { ...presenter, show: vi.fn(presenter.show) };
            },
        ),
    };
});

vi.mock('./install-background-color.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./install-background-color.js')>();
    return { ...actual, installBackgroundColor: vi.fn(actual.installBackgroundColor) };
});

vi.mock('./install-toolbar.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./install-toolbar.js')>();
    return { ...actual, installToolbar: vi.fn(actual.installToolbar) };
});

vi.mock('./renderer-appearance.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./renderer-appearance.js')>();
    return {
        ...actual,
        observeRendererAppearance: vi.fn(actual.observeRendererAppearance),
        createProbeResolver: () => () => 'rgb(8, 8, 8)',
    };
});

vi.mock('./dev-hooks.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./dev-hooks.js')>();
    return { ...actual, installDevHooks: vi.fn(actual.installDevHooks) };
});

// Spy on `track` so the completion payload `merge-result` emits is
// observable; every other export (only types are load-bearing here) passes
// through untouched.
vi.mock('../analytics/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../analytics/index.js')>();
    return { ...actual, track: vi.fn(), whenAnalyticsReady: vi.fn((send: () => void) => send()) };
});

const webgl = vi.hoisted(() => ({
    initError: null as Error | null,
    onInit: null as ((options: WebGlRendererOptions) => void) | null,
    options: undefined as WebGlRendererOptions | undefined,
}));

// An SVG renderer under the WebGL name: jsdom has no WebGL, and the wiring
// under test only needs `init` to fail or succeed and the options it was given.
vi.mock('../renderer/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../renderer/index.js')>();
    class FakeWebGlRenderer extends actual.SvgDomRenderer {
        constructor(options: WebGlRendererOptions) {
            super();
            webgl.options = options;
        }

        override init(container: HTMLElement): void {
            if (webgl.initError) throw webgl.initError;
            super.init(container);
            webgl.onInit?.(webgl.options!);
        }
    }
    return { ...actual, WebGlRenderer: FakeWebGlRenderer };
});

vi.mock('./idle-chunks.js', () => ({ runInIdleChunks: vi.fn(() => vi.fn()) }));

vi.mock('../move/move-receiver.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../move/move-receiver.js')>();
    return { ...actual, runMoveReceiver: vi.fn(async () => 'done' as const) };
});

import { installGlobalHandlers } from './global-handlers.js';
import { runBootSequence } from './boot-sequence.js';
import { startNewGame, type StartNewGameDeps } from './start-new-game.js';
import { loadSharedPuzzle } from './load-shared-puzzle.js';
import { openNewGameDialog } from './new-game-flow.js';
import { createRotationUi } from './rotation-ui.js';
import { createCompletionPresenter } from './completion-presenter.js';
import { zoomToFitCompletedPuzzle } from './viewport-fit.js';
import { createGameSession, type GameSession } from './game-session.js';
import { createShareLinkLoader } from './share-link-loader.js';
import { installBackgroundColor } from './install-background-color.js';
import { installToolbar } from './install-toolbar.js';
import { installDevHooks } from './dev-hooks.js';
import { observeRendererAppearance } from './renderer-appearance.js';
import { track, whenAnalyticsReady } from '../analytics/index.js';
import { runMoveReceiver } from '../move/move-receiver.js';
import { runInIdleChunks } from './idle-chunks.js';
import { warmEdgePathBounds } from '../game/index.js';
import type { NewGameData, PuzzleCompletedData } from '../analytics/index.js';
// From the module, not the barrel: the token key is deliberately not part of
// the persistence layer's public surface.
import { STORAGE_KEY, GEOMETRY_SEED_KEY } from '../persistence/storage.js';
import { loadGameContext, loadGameStartedAt, saveGameContext } from '../analytics/game-context.js';
import type { LoadSharedPuzzleDeps } from './load-shared-puzzle.js';
import { bootstrap } from './bootstrap.js';
import {
    SvgDomRenderer, ShaderBuildError, WebGLUnsupportedError, type WebGlRendererOptions,
} from '../renderer/index.js';
import { initPwaUpdates } from '../pwa/register.js';
import { savePieceOutlinePreference } from '../ui/piece-outline.js';
import { saveOutlineInsidePreference } from '../ui/outline-inside.js';

const HOOK_NAMES = [
    '__solvePuzzle',
    '__startVennPuzzle',
    '__newComposableGame',
    '__reproPuzzle',
] as const;

/**
 * Evidence that importing `./bootstrap.js` ran nothing. Captured at
 * module-evaluation time because `beforeEach`'s `vi.clearAllMocks()` would
 * erase it: a `bootstrap.ts` that ran on import would boot the app on import.
 */
const atImportTime = {
    globalHandlerCalls: vi.mocked(installGlobalHandlers).mock.calls.length,
    puzzleTables: document.querySelectorAll('[data-puzzle-table]').length,
};

function createdRotationUi(): { syncVisibility: Mock<(state: GameState | undefined) => void> } {
    const result = vi.mocked(createRotationUi).mock.results[0];
    expect(result.type, 'createRotationUi did not return').toBe('return');
    return result.value as unknown as {
        syncVisibility: Mock<(state: GameState | undefined) => void>;
    };
}

function createdCompletionPresenter(): { show: Mock<(state: GameState) => void> } {
    const result = vi.mocked(createCompletionPresenter).mock.results[0];
    expect(result.type, 'createCompletionPresenter did not return').toBe('return');
    return result.value as unknown as { show: Mock<(state: GameState) => void> };
}

/**
 * A state whose single group holds every piece — what `checkAndMarkWin` reads
 * as completed, so `applyMergeResult` reaches the completion handler for real.
 */
function makeCompletedState(): GameState {
    const pieces = [
        makeRectPiece({ id: 0, width: 100, height: 100 }),
        makeRectPiece({ id: 1, width: 100, height: 100 }),
    ];
    const group: PieceGroup = {
        id: 0,
        pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
        position: { x: 0, y: 0 },
        rotation: 0,
    };
    return makeGameState({ pieces, groups: [group] });
}

function makeUnfinishedState(): GameState {
    const pieces = [
        makeRectPiece({ id: 0, width: 100, height: 100 }),
        makeRectPiece({ id: 1, width: 100, height: 100 }),
    ];
    const groups: PieceGroup[] = pieces.map((piece) => ({
        id: piece.id,
        pieces: new Map([[piece.id, { x: 0, y: 0 }]]),
        position: { x: 0, y: 0 },
        rotation: 0,
    }));
    return makeGameState({ pieces, groups });
}

function createdSession(): GameSession {
    const result = vi.mocked(createGameSession).mock.results[0];
    expect(result.type, 'createGameSession did not return').toBe('return');
    return result.value;
}

function createdShareLinks(): { tryLoad: Mock<() => Promise<boolean>> } {
    const result = vi.mocked(createShareLinkLoader).mock.results[0];
    expect(result.type, 'createShareLinkLoader did not return').toBe('return');
    return result.value as unknown as { tryLoad: Mock<() => Promise<boolean>> };
}

function windowListenerOrder(spy: MockInstance<typeof window.addEventListener>, type: string): number {
    const index = spy.mock.calls.findIndex((call) => call[0] === type);
    expect(index, `window.addEventListener('${type}', …) was never called`).toBeGreaterThanOrEqual(0);
    return spy.mock.invocationCallOrder[index];
}

describe('bootstrap', () => {
    let root: HTMLElement;
    // Recording pass-throughs so `afterEach` can undo every listener a
    // `bootstrap()` call installs on a shared target; otherwise repeated boots
    // accumulate `hashchange`/`pagehide`/`visibilitychange` listeners and make
    // later listener-counting tests order-dependent. (`onColorSchemeChange`'s
    // `MediaQueryList` listener needs no cleanup — `matchMedia()` returns a
    // fresh object per call.)
    let windowListeners: MockInstance<typeof window.addEventListener>;
    let documentListeners: MockInstance<typeof document.addEventListener>;

    beforeEach(() => {
        localStorage.clear();
        // Clears call records only; the `vi.fn(actual.…)` implementations
        // survive, which these tests rely on.
        vi.clearAllMocks();
        root = document.createElement('div');
        document.body.replaceChildren(root);
        windowListeners = vi.spyOn(window, 'addEventListener');
        documentListeners = vi.spyOn(document, 'addEventListener');
    });

    afterEach(() => {
        for (const [type, listener, options] of windowListeners.mock.calls) {
            window.removeEventListener(type, listener, options as EventListenerOptions);
        }
        for (const [type, listener, options] of documentListeners.mock.calls) {
            document.removeEventListener(type, listener, options as EventListenerOptions);
        }
        windowListeners.mockRestore();
        documentListeners.mockRestore();
        for (const result of vi.mocked(observeRendererAppearance).mock.results) {
            if (result.type === 'return') result.value();
        }
        for (const name of HOOK_NAMES) {
            delete (window as unknown as Record<string, unknown>)[name];
        }
        localStorage.clear();
        document.body.replaceChildren();
    });

    it('exports a function and runs nothing on import', () => {
        expect(typeof bootstrap).toBe('function');
        expect(atImportTime.globalHandlerCalls, 'installGlobalHandlers ran at import time').toBe(0);
        expect(atImportTime.puzzleTables, 'the renderer initialized at import time').toBe(0);
    });

    it('installs global handlers before starting the boot sequence', () => {
        // Analytics and error tracking have to be up before anything that can
        // throw runs, or the first failure of a session goes unreported.
        bootstrap(root);

        expect(installGlobalHandlers).toHaveBeenCalledWith(root);
        expect(vi.mocked(installGlobalHandlers).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(runBootSequence).mock.invocationCallOrder[0],
        );
    });

    it('creates the rotation UI before the game session', () => {
        bootstrap(root);

        expect(vi.mocked(createRotationUi).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(createGameSession).mock.invocationCallOrder[0],
        );
    });

    it("hands the session's onInstalled the rotation UI's syncVisibility", () => {
        // Makes the ordering a data dependency, not a convention: `onInstalled`
        // is built from `rotationUi.syncVisibility` read as a bare value, so
        // the rotation UI must exist when the session is constructed.
        bootstrap(root);

        const { onInstalled } = vi.mocked(createGameSession).mock.calls[0][0];
        const state = makeGameState();
        onInstalled(state);

        expect(createdRotationUi().syncVisibility).toHaveBeenCalledWith(state);
    });

    it('registers the hashchange listener after kicking off the boot sequence', () => {
        // Boot runs synchronously to its first await, so this order is
        // observable: registering first would let a hashchange during boot
        // race the boot flow's own share-link read.
        bootstrap(root);

        expect(windowListenerOrder(windowListeners, 'hashchange')).toBeGreaterThan(
            vi.mocked(runBootSequence).mock.invocationCallOrder[0],
        );
    });

    it('routes a later hashchange through the share-link loader', () => {
        // A `#p=` link pasted into an open tab changes the hash but triggers
        // no reload; the loader handles it, not a second boot sequence.
        bootstrap(root);
        const { tryLoad } = createdShareLinks();
        vi.mocked(runBootSequence).mockClear();
        expect(tryLoad).not.toHaveBeenCalled();

        window.dispatchEvent(new Event('hashchange'));

        expect(tryLoad).toHaveBeenCalledTimes(1);
        expect(runBootSequence).not.toHaveBeenCalled();
    });

    it('installs cross-tab invalidation of the geometry-ownership token', () => {
        // Unwired, the app trusts a token another tab already invalidated —
        // #404's torn save, which the #490 fast path must not give back.
        // Asserted through behavior, not "addEventListener was called".
        bootstrap(root);
        localStorage.setItem(GEOMETRY_SEED_KEY, '5');

        window.dispatchEvent(
            new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: '{}',
                storageArea: localStorage,
            }),
        );

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
    });

    it('installs geometry-token invalidation before boot is kicked off', () => {
        // A storage event reaches only a document already listening and is
        // never replayed (and never fires in the tab that wrote), so any event
        // loop turn before the install loses another tab's geometry writes.
        // `bootstrap` is synchronous to `runBootSequence`, so none passes
        // today — this holds if a statement above ever gains an `await`.
        bootstrap(root);

        expect(windowListenerOrder(windowListeners, 'storage')).toBeLessThan(
            vi.mocked(runBootSequence).mock.invocationCallOrder[0],
        );
    });

    it('passes one and the same solve reference to the dev hooks and the toolbar', () => {
        // `window.__solvePuzzle` and the Solve button are one action; binding
        // it once stops a later edit desynchronizing them.
        bootstrap(root);

        const devSolve = vi.mocked(installDevHooks).mock.calls[0][0].solve;
        const toolbarSolve = vi.mocked(installToolbar).mock.calls[0][0].solve;
        expect(typeof devSolve).toBe('function');
        expect(devSolve).toBe(toolbarSolve);
    });

    it("wires both start/share deps objects' hasCurrentGame to the session", () => {
        // Both are replaced outright, so the third argument each mocked call
        // captures *is* the real deps object bootstrap built, letting
        // `hasCurrentGame` be called directly. Reached through
        // `installDevHooks`.
        bootstrap(root);
        const session = createdSession();

        const { start, loadShared } = vi.mocked(installDevHooks).mock.calls[0][0];
        void start({ cols: 2, rows: 2 }, {});
        void loadShared({} as SharePayload, undefined);

        const startNewGameDeps = vi.mocked(startNewGame).mock.calls.at(-1)![2];
        const sharedDeps = vi.mocked(loadSharedPuzzle).mock.calls.at(-1)![2];

        expect(startNewGameDeps.hasCurrentGame(), 'startNewGameDeps: nothing installed yet').toBe(false);
        expect(sharedDeps.hasCurrentGame(), 'sharedDeps: nothing installed yet').toBe(false);

        session.install(makeGameState());

        expect(startNewGameDeps.hasCurrentGame(), 'startNewGameDeps: a game is now installed').toBe(true);
        expect(sharedDeps.hasCurrentGame(), 'sharedDeps: a game is now installed').toBe(true);

        expect(sharedDeps.hasCurrentGame).toBe(startNewGameDeps.hasCurrentGame);

        // Asks `hasGame()`, not `current() !== undefined`: `install` makes the
        // state current before wiring interaction, so they disagree over a
        // blank canvas (#488). They diverge only inside `install`, so pin the
        // call rather than a state this test can't construct.
        const hasGameSpy = vi.spyOn(session, 'hasGame');
        const currentSpy = vi.spyOn(session, 'current');
        try {
            startNewGameDeps.hasCurrentGame();
            expect(hasGameSpy).toHaveBeenCalled();
            expect(currentSpy).not.toHaveBeenCalled();
        } finally {
            hasGameSpy.mockRestore();
            currentSpy.mockRestore();
        }
    });

    it("reports the installed puzzle's photo load for a fresh, a shared and a resumed puzzle", async () => {
        bootstrap(root);
        const { start } = vi.mocked(installDevHooks).mock.calls[0][0];
        void start({ cols: 2, rows: 2 }, {});
        const startNewGameDeps = vi.mocked(startNewGame).mock.calls.at(-1)![2];
        const bootDeps = vi.mocked(runBootSequence).mock.calls[0][0];
        const state = { ...makeSavedGameState(), imageUrl: 'https://images.unsplash.com/photo-1' };
        createdSession().install(state);
        vi.mocked(track).mockClear();

        startNewGameDeps.onGameAnalytics({ source: 'fresh', imagePhotoId: 'abc123' } as NewGameData, state);
        root.querySelector('image')!.dispatchEvent(new Event('load'));
        await Promise.resolve();
        startNewGameDeps.onGameAnalytics({ source: 'shared' } as NewGameData, state);
        await Promise.resolve();
        bootDeps.onResumed(state);
        await Promise.resolve();
        await Promise.resolve();

        const calls = vi.mocked(track).mock.calls as unknown as Array<[string, Record<string, unknown>]>;
        expect(calls.filter(([name]) => name === 'puzzle-image-loaded').map(([, data]) => data)).toEqual([
            expect.objectContaining({ outcome: 'loaded', trigger: 'new', imagePhotoId: 'abc123' }),
            expect.objectContaining({ outcome: 'loaded', trigger: 'shared' }),
            expect.objectContaining({ outcome: 'loaded', trigger: 'resume' }),
        ]);
    });

    it("reports a puzzle credit tap with the game's in-memory photo id", () => {
        bootstrap(root);
        const { start } = vi.mocked(installDevHooks).mock.calls[0][0];
        void start({ cols: 2, rows: 2 }, {});
        const startNewGameDeps = vi.mocked(startNewGame).mock.calls.at(-1)![2];
        const state = makeGameState({
            attribution: { photographerName: 'Ada', photographerUrl: 'https://unsplash.com/@ada', photoUrl: 'https://unsplash.com/photos/abc123' },
        });
        createdSession().install(state);
        startNewGameDeps.onGameAnalytics({ source: 'fresh', imagePhotoId: 'abc123' } as NewGameData, state);
        vi.mocked(track).mockClear();

        root.querySelectorAll<HTMLAnchorElement>('.image-attribution a')[1]
            .dispatchEvent(new MouseEvent('click', { cancelable: true }));

        expect(vi.mocked(track)).toHaveBeenCalledWith('photo-credit-opened', { where: 'puzzle', link: 'photo', photoId: 'abc123' });
    });

    it("warms each installed puzzle's edge-bounds cache, cancelling the previous warm-up", () => {
        bootstrap(root);
        const { onInstalled } = vi.mocked(createGameSession).mock.calls[0][0];
        onInstalled(makeGameState());
        const cancelFirst = vi.mocked(runInIdleChunks).mock.results[0].value as Mock;
        const second = makeGameState({ pieces: [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })] });

        onInstalled(second);

        expect(cancelFirst).toHaveBeenCalledOnce();
        expect(runInIdleChunks).toHaveBeenLastCalledWith([...second.piecesById.values()], warmEdgePathBounds);
    });

    it("abandons the previous puzzle's pending photo when another puzzle installs", () => {
        bootstrap(root);
        const bootDeps = vi.mocked(runBootSequence).mock.calls[0][0];
        const { onInstalled } = vi.mocked(createGameSession).mock.calls[0][0];
        bootDeps.onResumed(makeGameState({ imageUrl: 'https://images.unsplash.com/photo-1' }));
        vi.mocked(track).mockClear();

        onInstalled(makeGameState());

        const calls = vi.mocked(track).mock.calls as unknown as Array<[string, { outcome?: string; trigger?: string }]>;
        expect(calls.filter(([name]) => name === 'puzzle-image-loaded').map(([, data]) => data))
            .toEqual([expect.objectContaining({ outcome: 'abandoned', trigger: 'resume' })]);
    });

    it('applies the saved effects level to the root element at boot', () => {
        localStorage.setItem('puzzle-effects', 'simple');
        delete document.documentElement.dataset.effects;

        bootstrap(root);

        expect(document.documentElement.dataset.effects).toBe('simple');
    });

    it('enables the renderer rings at boot when the effects level is Simple', () => {
        localStorage.setItem('puzzle-effects', 'simple');
        const setRingsEnabled = vi.spyOn(SvgDomRenderer.prototype, 'setRingsEnabled');
        onTestFinished(() => setRingsEnabled.mockRestore());

        bootstrap(root);

        expect(setRingsEnabled).toHaveBeenLastCalledWith(true);
    });

    it('reports the resolved effects level once at boot', () => {
        localStorage.setItem('puzzle-effects', 'simple');

        bootstrap(root);

        const calls = (vi.mocked(track).mock.calls as unknown as Array<[string, unknown]>)
            .filter(([name]) => name === 'effects-resolved');
        expect(calls).toEqual([['effects-resolved', { preference: 'simple', detected: 'full', applied: 'simple' }]]);
    });

    it('routes an Effects change from the settings modal to the renderer', () => {
        const setRingsEnabled = vi.spyOn(SvgDomRenderer.prototype, 'setRingsEnabled');
        onTestFinished(() => setRingsEnabled.mockRestore());
        bootstrap(root);
        expect(setRingsEnabled).toHaveBeenLastCalledWith(false);

        root.querySelector<HTMLButtonElement>('.settings-button')!.click();
        root.querySelector<HTMLButtonElement>('[data-testid="effects-simple"]')!.click();

        expect(setRingsEnabled).toHaveBeenLastCalledWith(true);
        expect(document.documentElement.dataset.effects).toBe('simple');
    });

    it.each([
        ['outline', true],
        ['shadow', false],
    ])('with %s drawn inside, sets the renderer inner outline to %s at boot', (style, expected) => {
        localStorage.setItem('puzzle-piece-outline', style);
        localStorage.setItem('puzzle-outline-inside', 'true');
        const setInnerOutlineEnabled = vi.spyOn(SvgDomRenderer.prototype, 'setInnerOutlineEnabled');
        onTestFinished(() => setInnerOutlineEnabled.mockRestore());

        bootstrap(root);

        expect(setInnerOutlineEnabled).toHaveBeenLastCalledWith(expected);
    });

    it.each([
        ['outline', true],
        ['shadow', false],
    ] as const)('pushes the saved %s preset, with draw-inside on, as the first appearance at boot', (style, innerOutline) => {
        savePieceOutlinePreference(style);
        saveOutlineInsidePreference(true);
        const setAppearance = vi.spyOn(SvgDomRenderer.prototype, 'setAppearance');
        onTestFinished(() => setAppearance.mockRestore());

        bootstrap(root);

        expect(setAppearance.mock.calls[0][0]).toMatchObject({ outline: style, innerOutline });
        expect(setAppearance.mock.invocationCallOrder[0])
            .toBeGreaterThan(vi.mocked(installToolbar).mock.invocationCallOrder[0]);
        expect(setAppearance.mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(runBootSequence).mock.invocationCallOrder[0]);
    });

    it('applies a draw-inside change from the settings modal to the current game', () => {
        localStorage.setItem('puzzle-piece-outline', 'outline');
        const setInnerOutlineEnabled = vi.spyOn(SvgDomRenderer.prototype, 'setInnerOutlineEnabled');
        const renderState = vi.spyOn(SvgDomRenderer.prototype, 'renderState');
        onTestFinished(() => {
            setInnerOutlineEnabled.mockRestore();
            renderState.mockRestore();
        });
        bootstrap(root);
        const state = makeGameState();
        createdSession().install(state);
        renderState.mockClear();

        root.querySelector<HTMLButtonElement>('.settings-button')!.click();
        const toggle = root.querySelector<HTMLInputElement>('[data-testid="outline-inside-toggle"]')!;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(setInnerOutlineEnabled).toHaveBeenLastCalledWith(true);
        expect(renderState).toHaveBeenLastCalledWith(state);
        expect(setInnerOutlineEnabled.mock.invocationCallOrder.at(-1)!)
            .toBeLessThan(renderState.mock.invocationCallOrder.at(-1)!);
    });

    it('delivers a draw-inside change from the settings modal to the renderer appearance', async () => {
        savePieceOutlinePreference('outline');
        const setAppearance = vi.spyOn(SvgDomRenderer.prototype, 'setAppearance');
        onTestFinished(() => setAppearance.mockRestore());
        bootstrap(root);
        expect(setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ innerOutline: false }));

        root.querySelector<HTMLButtonElement>('.settings-button')!.click();
        const toggle = root.querySelector<HTMLInputElement>('[data-testid="outline-inside-toggle"]')!;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        await vi.waitFor(() => {
            expect(setAppearance).toHaveBeenLastCalledWith(expect.objectContaining({ innerOutline: true }));
        });
    });

    it('puts the background-color control in the right-hand toolbar, between Gather and Help', () => {
        // `install-toolbar.test.ts` pins the full order with a stand-in
        // control; this checks the real picker lands in the toolbar.
        bootstrap(root);

        const children = [...root.querySelector('.right-toolbar')!.children];
        const gather = children.findIndex((el) => el.matches('.gather-pieces-button'));
        const picker = children.findIndex((el) => el.querySelector('.bg-color-button'));
        const help = children.findIndex((el) => el.matches('.help-button'));
        expect(gather, 'gather button').toBeGreaterThanOrEqual(0);
        expect(picker, 'background-color button').toBeGreaterThan(gather);
        expect(help, 'help button').toBeGreaterThan(picker);
    });

    it('hands the background-color handle to the share-link load path', () => {
        // The handle exists only after `installToolbar` invokes
        // `installBackgroundColorControl`, so the shared-puzzle deps must be
        // built after. Asserted present first because
        // `objectContaining({ backgroundColor: undefined })` matches an absent
        // key.
        bootstrap(root);
        const installed = vi.mocked(installBackgroundColor).mock.results[0];
        expect(installed.type, 'installBackgroundColor did not return').toBe('return');
        const control = installed.value;
        expect(control, 'no background-color handle to hand over').toBeDefined();

        const { loadShared } = vi.mocked(installDevHooks).mock.calls[0][0];
        void loadShared({} as SharePayload, undefined);

        expect(loadSharedPuzzle).toHaveBeenCalledWith(
            {},
            undefined,
            expect.objectContaining({ backgroundColor: control }),
            'repro',
        );
    });

    // #512: the share-link binding must not converge on the dev-hooks
    // 'repro' source, or a `__reproPuzzle` replay of a known-bad puzzle would
    // inflate the `piece-count-mismatch` count. Pinned at the *resolved*
    // default ('shared') via `?? 'shared'`, not a fixed-arity
    // `toHaveBeenCalledWith`: making the source explicit is semantically
    // identical to omitting it but would fail an arity-sensitive matcher.
    it('leaves the real share-link binding at the default source', () => {
        bootstrap(root);
        const { loadShared } = vi.mocked(createShareLinkLoader).mock.calls[0][0];
        void loadShared({} as SharePayload, undefined);

        const call = vi.mocked(loadSharedPuzzle).mock.calls.at(-1);
        expect(call?.[0]).toEqual({});
        expect(call?.[1]).toBeUndefined();
        expect(call?.[3] ?? 'shared').toBe('shared');
    });

    // #512: the same split for `startNewGame`'s `'dev'` source. The dev-hooks
    // `start` binding is the only route to `__newComposableGame`'s arbitrary
    // sine configs outside a crafted link, so a mismatch it surfaces must not
    // look like a real player's game.
    it('labels the dev-hooks start binding as a dev-console start', () => {
        bootstrap(root);
        const { start } = vi.mocked(installDevHooks).mock.calls[0][0];
        void start({ cols: 2, rows: 2 }, {});

        const call = vi.mocked(startNewGame).mock.calls.at(-1);
        expect(call?.[3]).toBe('dev');
    });

    // The two real player paths stay at the default. The `toBeDefined` floor
    // keeps `?? 'fresh'` from passing vacuously: without it a binding that
    // stopped calling `startNewGame` leaves `call` undefined and the defaulted
    // assertion still holds.
    it('leaves the boot-path start binding at the default source', () => {
        bootstrap(root);
        const { start } = vi.mocked(runBootSequence).mock.calls[0][0];
        void start({ cols: 2, rows: 2 }, {});

        const call = vi.mocked(startNewGame).mock.calls.at(-1);
        expect(call).toBeDefined();
        expect(call?.[3] ?? 'fresh').toBe('fresh');
    });

    it('leaves the new-game-dialog start binding at the default source', () => {
        bootstrap(root);
        const { onNewGame } = vi.mocked(installToolbar).mock.calls[0][0];
        onNewGame();

        const { start } = vi.mocked(openNewGameDialog).mock.calls.at(-1)![0];
        void start({ cols: 2, rows: 2 }, {});

        const call = vi.mocked(startNewGame).mock.calls.at(-1);
        expect(call).toBeDefined();
        expect(call?.[3] ?? 'fresh').toBe('fresh');
    });

    it('reads the session late before showing the completion overlay', () => {
        // The zoom settles up to ~1000ms after the win, so the session is read
        // inside the settle callback, not captured: by then a new game may
        // have replaced the finished one, and the overlay's "Challenge a
        // friend" link is built from the state it's handed. Nothing installed
        // means no overlay; capturing the completed state would show it.
        bootstrap(root);
        const { applyMerge } = vi.mocked(createGameSession).mock.calls[0][0];
        const completed = makeCompletedState();

        applyMerge(completed, { group: completed.groups[0], mergeCount: 1 } satisfies MergeResult, [0]);

        const [, , , onSettled] = vi.mocked(zoomToFitCompletedPuzzle).mock.calls[0];
        onSettled();

        expect(createdCompletionPresenter().show).not.toHaveBeenCalled();
    });

    it('shows the completion overlay for the game installed when the zoom settles', () => {
        // Counterpart to the test above: the late read is only half the
        // contract, and a `bootstrap` that never showed the overlay satisfies
        // that half. Pins the positive direction with a real installed game.
        bootstrap(root);
        const session = createdSession();
        const completed = makeCompletedState();
        session.install(completed);

        const { applyMerge } = vi.mocked(createGameSession).mock.calls[0][0];
        applyMerge(completed, { group: completed.groups[0], mergeCount: 1 } satisfies MergeResult, [0]);

        const [, , , onSettled] = vi.mocked(zoomToFitCompletedPuzzle).mock.calls[0];
        onSettled();

        // Asserted against the session's report, not local `completed`, so it
        // reads as "the overlay gets the still-installed game"; the `toBe`
        // first guards against comparing two `undefined`s.
        expect(session.current(), 'nothing installed to celebrate').toBe(completed);
        expect(createdCompletionPresenter().show).toHaveBeenCalledTimes(1);
        expect(createdCompletionPresenter().show).toHaveBeenCalledWith(session.current());
    });

    it('skips the completion overlay when a fresh game is installed by the time the zoom settles', () => {
        // The settle has no cancel handle, so a win then New Game inside the
        // ~1s zoom still lands with "something installed" true — of the fresh
        // puzzle. Showing the win screen over it links a friend to an
        // unfinished puzzle. Identity with the zoomed-for game discriminates.
        bootstrap(root);
        const session = createdSession();
        const completed = makeCompletedState();
        session.install(completed);

        const { applyMerge } = vi.mocked(createGameSession).mock.calls[0][0];
        applyMerge(completed, { group: completed.groups[0], mergeCount: 1 } satisfies MergeResult, [0]);

        // A new puzzle starts while the completion zoom runs.
        // `makeCompletedState` is un-won until `applyMerge` marks it, so a
        // second one stands in for any fresh game.
        const fresh = makeCompletedState();
        session.install(fresh);
        expect(fresh, 'a fresh game must be a different object').not.toBe(completed);
        expect(fresh.completed, 'the stand-in fresh game must be unfinished').toBe(false);

        const [, , , onSettled] = vi.mocked(zoomToFitCompletedPuzzle).mock.calls[0];
        onSettled();

        expect(createdCompletionPresenter().show).not.toHaveBeenCalled();
    });

    it('skips the completion overlay when the game installed at settle time is a different finished one', () => {
        // Identity, not "the installed game is finished": that weaker test
        // passes here, yet showing this zoom's win screen for a puzzle it
        // never framed is the same wrong-link defect. Only the debug Solve
        // hook can finish a second puzzle inside the ~1s window; no production
        // path installs a finished game there.
        bootstrap(root);
        const session = createdSession();
        const completed = makeCompletedState();
        session.install(completed);

        const { applyMerge } = vi.mocked(createGameSession).mock.calls[0][0];
        applyMerge(completed, { group: completed.groups[0], mergeCount: 1 } satisfies MergeResult, [0]);

        const otherFinished = makeCompletedState();
        otherFinished.completed = true;
        session.install(otherFinished);

        // Installing a finished game opens its own overlay from the install
        // path, so the settle is measured against that count, not zero.
        const beforeSettle = createdCompletionPresenter().show.mock.calls.length;
        expect(beforeSettle, 'the installed finished game shows its own overlay').toBe(1);

        const [, , , onSettled] = vi.mocked(zoomToFitCompletedPuzzle).mock.calls[0];
        onSettled();

        expect(createdCompletionPresenter().show).toHaveBeenCalledTimes(beforeSettle);
    });

    it('clears the cached new-game analytics when a game is installed (#507)', () => {
        // A throw between `session.install` and the deferred `onGameAnalytics`
        // assignment leaves the *previous* puzzle's payload cached against the
        // *new* game (both start flows install first, assign later). Clearing
        // in the install hook means the worst case is a state-derived
        // completion event — the supported resume-from-localStorage shape —
        // not one carrying another puzzle's `source` / `imageCategory` /
        // `vibrant` / geometry.
        bootstrap(root);
        const session = createdSession();

        // Prime the cache through the same `onGameAnalytics` binding the start
        // flow uses, then install a new game without a following assignment —
        // the "threw before the analytics were re-cached" window.
        const { start } = vi.mocked(installDevHooks).mock.calls[0][0];
        void start({ cols: 2, rows: 2 }, {});
        const startNewGameDeps = vi.mocked(startNewGame).mock.calls.at(-1)![2];
        const staleAnalytics: NewGameData = {
            source: 'fresh', cutStyle: 'wavy', rotationMode: 'none',
            orientation: 'landscape', cols: 9, rows: 9, pieceCount: 81,
            imageSource: 'unsplash', imageCategory: 'nature', vibrant: true,
            generationMode: 'worker', generationMs: 42,
        };
        startNewGameDeps.onGameAnalytics(staleAnalytics, makeGameState());

        const completed = makeCompletedState();
        session.install(completed);

        vi.mocked(track).mockClear();
        const { applyMerge } = vi.mocked(createGameSession).mock.calls[0][0];
        applyMerge(completed, { group: completed.groups[0], mergeCount: 1 } satisfies MergeResult, [0]);

        // `track`'s overloads collapse to the last signature under
        // `mock.calls`, so widen to a plain event tuple to read any event.
        const calls = vi.mocked(track).mock.calls as unknown as Array<[string, PuzzleCompletedData]>;
        const completedCall = calls.find(([name]) => name === 'puzzle-completed');
        expect(completedCall, 'no puzzle-completed event fired').toBeDefined();
        const payload = completedCall![1];
        // Derived from `completed`, not the stale 'wavy' cache.
        expect(payload.cutStyle).toBe('classic');
        // Fields only a cached NewGameData carries — their absence is proof the
        // stale payload did not win.
        expect(payload).not.toHaveProperty('source');
        expect(payload).not.toHaveProperty('imageCategory');
        expect(payload).not.toHaveProperty('vibrant');
    });

    describe('moving to the new site', () => {
        afterEach(() => {
            Reflect.deleteProperty(window, 'opener');
            history.replaceState(null, '', '/');
        });

        it('receives a moved puzzle instead of booting when opened by the old site', () => {
            history.replaceState(null, '', '/?receive-move');
            Object.defineProperty(window, 'opener', { value: {}, configurable: true });

            bootstrap(root);

            expect(runMoveReceiver).toHaveBeenCalledWith({ container: root });
            expect(createGameSession).not.toHaveBeenCalled();
            expect(runBootSequence).not.toHaveBeenCalled();
        });

        it('boots normally when ?receive-move has no opener', () => {
            history.replaceState(null, '', '/?receive-move');
            bootstrap(root);
            expect(runMoveReceiver).not.toHaveBeenCalled();
            expect(runBootSequence).toHaveBeenCalled();
            expect(location.search).toBe('');
        });
    });

    describe('game analytics across page loads (#601)', () => {
        const startedData: NewGameData = {
            source: 'fresh', cutStyle: 'classic', rotationMode: 'none',
            orientation: 'landscape', cols: 2, rows: 1, pieceCount: 2,
            imageSource: 'unsplash', imageCategory: 'nature', vibrant: true,
            generationMode: 'worker', generationMs: 42,
        };

        function completeAndReadPayload(state: GameState): PuzzleCompletedData {
            vi.mocked(track).mockClear();
            const { applyMerge } = vi.mocked(createGameSession).mock.calls[0][0];
            applyMerge(state, { group: state.groups[0], mergeCount: 1 } satisfies MergeResult, [0]);
            const calls = vi.mocked(track).mock.calls as unknown as Array<[string, PuzzleCompletedData]>;
            const completedCall = calls.find(([name]) => name === 'puzzle-completed');
            expect(completedCall, 'no puzzle-completed event fired').toBeDefined();
            return completedCall![1];
        }

        function resume(state: GameState): void {
            createdSession().install(state);
            vi.mocked(runBootSequence).mock.calls[0][0].onResumed(state);
        }

        function mockNow(now: number): MockInstance<typeof Date.now> {
            const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
            onTestFinished(() => spy.mockRestore());
            return spy;
        }

        function sharedDeps(): LoadSharedPuzzleDeps {
            const { loadShared } = vi.mocked(installDevHooks).mock.calls[0][0];
            void loadShared({} as SharePayload, undefined);
            return vi.mocked(loadSharedPuzzle).mock.calls.at(-1)![2];
        }

        function startDeps(): StartNewGameDeps {
            const { start } = vi.mocked(installDevHooks).mock.calls[0][0];
            void start({ cols: 2, rows: 1 }, {});
            return vi.mocked(startNewGame).mock.calls.at(-1)![2];
        }

        it('persists a started game\'s analytics against its seed', () => {
            bootstrap(root);
            const deps = startDeps();
            const state = makeCompletedState();
            state.seed = 11;

            deps.persistNewPuzzle(state);
            deps.onGameAnalytics(startedData, state);

            expect(loadGameContext(11)).toEqual(startedData);
        });

        it('keeps the slot owner\'s analytics when the new puzzle fails to save', () => {
            // The previous puzzle stays in the slot and resumes on reload.
            saveGameContext(11, startedData, 1_000);
            bootstrap(root);
            const deps = startDeps();
            const realSetItem = Storage.prototype.setItem;
            const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
                this: Storage, key: string, value: string,
            ) {
                if (key === STORAGE_KEY) throw new DOMException('quota', 'QuotaExceededError');
                realSetItem.call(this, key, value);
            });
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            onTestFinished(() => {
                setItem.mockRestore();
                warn.mockRestore();
            });
            const unsaved = makeCompletedState();
            unsaved.seed = 12;
            const unsavedData: NewGameData = { ...startedData, source: 'shared' };

            deps.persistNewPuzzle(unsaved);
            deps.onGameAnalytics(unsavedData, unsaved);

            expect(loadGameContext(11)).toEqual(startedData);
            expect(loadGameContext(12)).toBeNull();
            expect(completeAndReadPayload(unsaved).source).toBe('shared');
        });

        it('drops the previous analytics as soon as a new puzzle is saved', () => {
            // A share link reuses its originator's seed, so if the start
            // throws before its own analytics are known, a leftover record
            // for that seed would be read back as this game's.
            saveGameContext(11, startedData, 1_000);
            bootstrap(root);
            const deps = startDeps();
            const state = makeCompletedState();
            state.seed = 11;

            deps.persistNewPuzzle(state);

            expect(loadGameContext(11)).toBeNull();
        });

        it('restores the saved game\'s analytics on resume and reports it resumed', () => {
            saveGameContext(11, startedData, 1_000);
            bootstrap(root);
            const state = makeCompletedState();
            state.seed = 11;

            resume(state);
            const payload = completeAndReadPayload(state);

            expect(payload).toMatchObject({
                resumed: true, source: 'fresh', imageCategory: 'nature', vibrant: true,
            });
        });

        it('reports a resumed game with no persisted analytics as resumed, without source', () => {
            bootstrap(root);
            const state = makeCompletedState();
            state.seed = 11;

            resume(state);
            const payload = completeAndReadPayload(state);

            expect(payload.resumed).toBe(true);
            expect(payload).not.toHaveProperty('source');
        });

        it('persists a started game\'s start time against its seed', () => {
            bootstrap(root);
            const deps = startDeps();
            const state = makeCompletedState();
            state.seed = 11;
            mockNow(1_000);

            deps.persistNewPuzzle(state);
            deps.onGameAnalytics(startedData, state);

            expect(loadGameStartedAt(11)).toBe(1_000);
        });

        it('reports the time from a game\'s start to its completion', () => {
            bootstrap(root);
            const deps = startDeps();
            const state = makeCompletedState();
            state.seed = 11;
            const now = mockNow(1_000);
            createdSession().install(state);
            deps.persistNewPuzzle(state);
            deps.onGameAnalytics(startedData, state);

            now.mockReturnValue(91_000);
            const payload = completeAndReadPayload(state);

            expect(payload.elapsedMs).toBe(90_000);
        });

        it('reports the time since its stored start for a resumed game', () => {
            saveGameContext(11, startedData, 1_000);
            bootstrap(root);
            const state = makeCompletedState();
            state.seed = 11;
            mockNow(91_000);

            resume(state);
            const payload = completeAndReadPayload(state);

            expect(payload.elapsedMs).toBe(90_000);
        });

        it('drops the previous game\'s start time when a game is installed', () => {
            bootstrap(root);
            const deps = startDeps();
            const previous = makeCompletedState();
            mockNow(1_000);
            createdSession().install(previous);
            deps.onGameAnalytics(startedData, previous);

            const next = makeCompletedState();
            createdSession().install(next);
            const payload = completeAndReadPayload(next);

            expect(payload).not.toHaveProperty('elapsedMs');
        });

        it('reports a game started after a resumed one as not resumed', () => {
            saveGameContext(11, startedData, 1_000);
            bootstrap(root);
            const resumed = makeCompletedState();
            resumed.seed = 11;
            resume(resumed);

            const fresh = makeCompletedState();
            fresh.seed = 12;
            createdSession().install(fresh);
            const payload = completeAndReadPayload(fresh);

            expect(payload.resumed).toBe(false);
            expect(payload).not.toHaveProperty('source');
        });

        it('reports the time since the game started when it is solved', () => {
            bootstrap(root);
            const deps = startDeps();
            const installed = makeUnfinishedState();
            const now = mockNow(1_000);
            createdSession().install(installed);
            deps.onGameAnalytics(startedData, installed);
            vi.mocked(track).mockClear();

            now.mockReturnValue(91_000);
            vi.mocked(installDevHooks).mock.calls[0][0].solve();

            expect(track).toHaveBeenCalledWith(
                'puzzle-solved',
                expect.objectContaining({ elapsedMs: 90_000 }),
            );
        });

        it('reports the installed game as replaced, with its time so far', () => {
            bootstrap(root);
            const deps = startDeps();
            const installed = makeUnfinishedState();
            const now = mockNow(1_000);
            createdSession().install(installed);
            deps.onGameAnalytics(startedData, installed);

            now.mockReturnValue(31_000);

            expect(deps.replacedGameAnalytics()).toEqual({
                replacedProgress: 0,
                replacedCompleted: false,
                replacedPieceCount: 2,
                replacedCutStyle: 'classic',
                replacedElapsedMs: 30_000,
            });
        });

        it('reports no replaced game when none is installed', () => {
            bootstrap(root);

            expect(startDeps().replacedGameAnalytics()).toBeUndefined();
            expect(sharedDeps().replacedGameAnalytics(undefined)).toBeUndefined();
        });

        it('reports no replaced game for one installed but never made playable', () => {
            // `install` makes the state current before wiring interaction, so
            // a start that threw there leaves a puzzle nobody played (#488).
            bootstrap(root);
            const session = createdSession();
            session.install(makeUnfinishedState());
            vi.spyOn(session, 'hasGame').mockReturnValue(false);

            expect(startDeps().replacedGameAnalytics()).toBeUndefined();
        });

        it('reports the saved game as replaced when none is installed', () => {
            saveGameContext(11, startedData, 1_000);
            bootstrap(root);
            const saved = makeUnfinishedState();
            saved.seed = 11;
            mockNow(31_000);

            expect(sharedDeps().replacedGameAnalytics(saved)).toEqual({
                replacedProgress: 0,
                replacedCompleted: false,
                replacedPieceCount: 2,
                replacedCutStyle: 'classic',
                replacedElapsedMs: 30_000,
            });
        });

        it('reports the installed game as replaced over the saved one', () => {
            bootstrap(root);
            createdSession().install(makeCompletedState());

            const replaced = sharedDeps().replacedGameAnalytics(makeUnfinishedState());

            expect(replaced?.replacedProgress).toBe(1);
        });
    });

    it('builds the SVG renderer without ?renderer=webgl', () => {
        bootstrap(root);

        expect(webgl.options).toBeUndefined();
    });

    describe('with ?renderer=webgl', () => {
        const UNSUPPORTED = "Puzzlewise needs WebGL 2, which this browser doesn't support.";
        let consoleError: MockInstance<typeof console.error>;

        beforeEach(() => {
            history.replaceState(null, '', '/?renderer=webgl');
            consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            history.replaceState(null, '', '/');
            consoleError.mockRestore();
            webgl.initError = null;
            webgl.onInit = null;
            webgl.options = undefined;
        });

        function contextEvent(phase: 'lost' | 'restored' | 'gave-up'): void {
            expect(webgl.options?.onContextEvent, 'the WebGL renderer got no onContextEvent').toBeTypeOf('function');
            webgl.options!.onContextEvent!(phase);
        }

        it('builds the WebGL renderer, not the SVG one', () => {
            bootstrap(root);

            expect(webgl.options?.runInIdle).toBe(runInIdleChunks);
            expect(runBootSequence).toHaveBeenCalled();
        });

        it('webgl init throwing WebGLUnsupportedError shows the unsupported message and does not boot the game', () => {
            webgl.initError = new WebGLUnsupportedError('no-webgl2');
            // `index.html`'s static "Building puzzle…" overlay, which only boot would remove.
            const loading = document.createElement('div');
            loading.className = 'loading-overlay';
            document.body.appendChild(loading);

            bootstrap(root);

            expect(root.querySelector('.renderer-failure-body')?.textContent).toBe(UNSUPPORTED);
            expect(loading.isConnected, 'the loading overlay is still up').toBe(false);
            expect(createGameSession).not.toHaveBeenCalled();
            expect(runBootSequence).not.toHaveBeenCalled();
            expect(startNewGame).not.toHaveBeenCalled();
            expect(installToolbar).not.toHaveBeenCalled();
            expect(windowListeners.mock.calls.some(([type]) => type === 'hashchange')).toBe(false);
            expect(localStorage.length).toBe(0);
            expect(consoleError).toHaveBeenCalledWith(expect.any(String), webgl.initError);
        });

        it('still registers PWA updates when WebGL is unsupported', () => {
            webgl.initError = new WebGLUnsupportedError('blocked');

            bootstrap(root);

            expect(initPwaUpdates).toHaveBeenCalledTimes(1);
        });

        it.each(['no-webgl2', 'blocked'] as const)(
            'an unsupported WebGL tracks renderer-failed with its cause as kind (%s)',
            (cause) => {
                webgl.initError = new WebGLUnsupportedError(cause);

                bootstrap(root);

                expect(track).toHaveBeenCalledWith('renderer-failed', { kind: cause });
            },
        );

        it('a ShaderBuildError at init shows the unsupported message, tracks renderer-failed with kind shader and console.errors its log', () => {
            const log = "ERROR: 0:12: 'vUv' : undeclared identifier";
            webgl.initError = new ShaderBuildError('Fragment shader failed to compile', log);

            bootstrap(root);

            expect(root.querySelector('.renderer-failure-body')?.textContent).toBe(UNSUPPORTED);
            expect(track).toHaveBeenCalledWith('renderer-failed', { kind: 'shader' });
            expect(consoleError).toHaveBeenCalledWith(expect.any(String), webgl.initError, log);
            expect(runBootSequence).not.toHaveBeenCalled();
        });

        it('lets any other init error propagate', () => {
            webgl.initError = new TypeError('boom');

            expect(() => bootstrap(root)).toThrow('boom');
            expect(track).not.toHaveBeenCalledWith('renderer-failed', expect.anything());
        });

        it('onContextEvent lost tracks renderer-context-lost with pieceCount and visibilityState', () => {
            bootstrap(root);
            createdSession().install(makeUnfinishedState());
            const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
            onTestFinished(() => visibility.mockRestore());
            vi.mocked(track).mockClear();

            contextEvent('lost');

            expect(track).toHaveBeenCalledWith('renderer-context-lost', { pieceCount: 2, visibilityState: 'hidden' });
            expect(track).toHaveBeenCalledTimes(1);
            expect(root.querySelector('.renderer-failure-overlay')).toBeNull();
        });

        it('reports the visibilityState at the loss, not when analytics becomes ready', () => {
            bootstrap(root);
            createdSession().install(makeUnfinishedState());
            let pendingSend: (() => void) | undefined;
            vi.mocked(whenAnalyticsReady).mockImplementationOnce((send) => {
                pendingSend = send;
            });
            const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
            onTestFinished(() => visibility.mockRestore());

            contextEvent('lost');
            visibility.mockReturnValue('visible');
            expect(pendingSend, 'the send was not deferred').toBeTypeOf('function');
            pendingSend!();

            expect(track).toHaveBeenCalledWith('renderer-context-lost', { pieceCount: 2, visibilityState: 'hidden' });
        });

        it('reports a context lost during init with no puzzle installed', () => {
            // `session` doesn't exist yet when `init` reports a loss.
            webgl.onInit = (options) => options.onContextEvent?.('lost');

            expect(() => bootstrap(root)).not.toThrow();

            expect(track).toHaveBeenCalledWith('renderer-context-lost', {
                pieceCount: 0,
                visibilityState: document.visibilityState,
            });
            expect(runBootSequence).toHaveBeenCalled();
        });

        it('onContextEvent gave-up shows the lost message and tracks renderer-failed with kind lost', () => {
            bootstrap(root);
            vi.mocked(track).mockClear();

            contextEvent('gave-up');

            expect(root.querySelector('.renderer-failure-body')?.textContent).toBe('Graphics stopped working.');
            expect(root.querySelector('.renderer-failure-overlay button')?.textContent).toBe('Reload');
            expect(track).toHaveBeenCalledWith('renderer-failed', { kind: 'lost' });
            expect(track).toHaveBeenCalledTimes(1);
        });

        it('a shader failure on restore shows the unsupported message, tracks renderer-failed with kind shader and console.errors its log', () => {
            const log = "ERROR: 0:12: 'vUv' : undeclared identifier";
            const error = new ShaderBuildError('Fragment shader failed to compile', log);
            bootstrap(root);
            contextEvent('lost');
            vi.mocked(track).mockClear();
            expect(webgl.options?.onRestoreFailed, 'the WebGL renderer got no onRestoreFailed').toBeTypeOf('function');

            webgl.options!.onRestoreFailed!(error);

            expect(root.querySelector('.renderer-failure-body')?.textContent).toBe(UNSUPPORTED);
            expect(track).toHaveBeenCalledWith('renderer-failed', { kind: 'shader' });
            expect(track).toHaveBeenCalledTimes(1);
            expect(consoleError).toHaveBeenCalledWith(expect.any(String), error, log);
        });

        it('onContextEvent restored shows nothing and tracks nothing', () => {
            bootstrap(root);
            vi.mocked(track).mockClear();

            contextEvent('restored');

            expect(root.querySelector('.renderer-failure-overlay')).toBeNull();
            expect(track).not.toHaveBeenCalled();
        });
    });

    it('renders the toolbar into the given root', () => {
        bootstrap(root);

        expect(root.querySelector('.new-game-button')).not.toBeNull();
        expect(root.querySelector('.help-button')).not.toBeNull();
        expect(root.querySelector('.settings-button')).not.toBeNull();
    });

    it('falls back to #app when no root is given', () => {
        // The default argument is evaluated at call time, keeping `main.ts`
        // free of a DOM lookup while leaving this module importable.
        const app = document.createElement('div');
        app.id = 'app';
        document.body.replaceChildren(app);

        expect(() => bootstrap()).not.toThrow();

        expect(installGlobalHandlers).toHaveBeenCalledWith(app);
        expect(app.querySelector('.new-game-button')).not.toBeNull();
    });
});
