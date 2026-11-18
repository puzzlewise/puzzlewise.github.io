/**
 * @vitest-environment jsdom
 */

import {
    describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance,
} from 'vitest';
import type { GameState } from '../model/types.js';
import type { SharePayload } from '../sharing/index.js';
import type { ReplacedGameData } from '../analytics/index.js';
import type { BackgroundColorControl } from './install-background-color.js';
import { makeGameState } from '../test-helpers/fixtures.js';
import { diagnostics } from '../diagnostics.js';

vi.mock('../ui/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../ui/index.js')>()),
    showLoadingOverlay: vi.fn(),
    hideLoadingOverlay: vi.fn(),
    yieldForPaint: vi.fn(async () => {}),
    showToast: vi.fn(),
}));
// `createNewGameAsync` runs for real for a plain Classic payload, and its
// registry imports `tracedTabGeneratorStub` from this module — pass the rest
// through via `importOriginal` or that generation breaks.
vi.mock('../puzzle/topology/traced-tab-loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../puzzle/topology/traced-tab-loader.js')>();
    return { ...actual, preloadTracedTabGenerator: vi.fn(async () => {}) };
});
// Plain `vi.spyOn` can't intercept a cross-module call under Vite; wrap the
// real `createNewGameAsync` via `vi.mock` passthrough so tests can override
// it (traced-tab payloads, cancel signal inspection) while plain-Classic
// tests exercise real generation.
vi.mock('../game/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../game/index.js')>();
    return { ...actual, createNewGameAsync: vi.fn(actual.createNewGameAsync) };
});

import { showLoadingOverlay, hideLoadingOverlay, showToast } from '../ui/index.js';
import { preloadTracedTabGenerator } from '../puzzle/topology/traced-tab-loader.js';
import { createNewGameAsync, GenerationCanceledError } from '../game/index.js';
import { loadSharedPuzzle, type LoadSharedPuzzleDeps } from './load-shared-puzzle.js';

/**
 * The wrapped real implementation, captured so `beforeEach` can restore it
 * explicitly: `vi.clearAllMocks()` clears call records but not a per-test
 * `mockImplementation`, which would otherwise leak into later tests.
 */
const realCreateNewGameAsync = vi.mocked(createNewGameAsync).getMockImplementation()!;

/**
 * Minimal decoded payload: required fields only, cut style forced to plain
 * Classic so real generation never needs the traced-tab chunk this file
 * doesn't register. Callers override the fields each test cares about.
 */
function payload(overrides: Partial<SharePayload> = {}): SharePayload {
    return {
        v: 1,
        i: 'https://images.unsplash.com/photo-123?w=1080',
        is: [1080, 720],
        g: [8, 6],
        c: 'classic',
        s: 12345,
        r: 'none',
        ...overrides,
    };
}

describe('loadSharedPuzzle', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;
    let install: Mock<(state: GameState) => void>;
    let uninstall: Mock<() => void>;
    let fitView: Mock<(state: GameState) => void>;
    let persistNewPuzzle: Mock<(state: GameState) => void>;
    let onGameAnalytics: Mock<(data: unknown, state: GameState) => void>;
    let replacedGameAnalytics: Mock<(savedState: GameState | undefined) => ReplacedGameData | undefined>;
    let adopt: Mock<BackgroundColorControl['adopt']>;
    let deps: LoadSharedPuzzleDeps;
    /**
     * Restored one by one, not via `vi.restoreAllMocks()`: no `restoreMocks`
     * in `vite.config.ts`, and a blanket restore would strip the `vi.mock`
     * factory implementations above.
     */
    let warnSpy: MockInstance<typeof diagnostics.warn> | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(preloadTracedTabGenerator).mockResolvedValue(undefined);
        vi.mocked(createNewGameAsync).mockImplementation(realCreateNewGameAsync);

        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };

        install = vi.fn();
        uninstall = vi.fn();
        fitView = vi.fn();
        persistNewPuzzle = vi.fn();
        onGameAnalytics = vi.fn();
        replacedGameAnalytics = vi.fn(() => undefined);
        adopt = vi.fn();
        deps = {
            container: document.createElement('div'),
            session: { install, uninstall },
            fitView,
            persistNewPuzzle,
            backgroundColor: { adopt },
            onGameAnalytics,
            replacedGameAnalytics,
            hasCurrentGame: () => false,
        };
    });

    afterEach(() => {
        warnSpy?.mockRestore();
        warnSpy = undefined;
        delete (window as unknown as { umami?: unknown }).umami;
    });

    it('installs the shared puzzle, fits the view and persists it', async () => {
        await loadSharedPuzzle(payload(), undefined, deps);

        expect(install).toHaveBeenCalledTimes(1);
        const installedState = install.mock.calls[0][0];
        // The pass-through arm of the blank collapse: without it, `imageUrl =
        // null` would pass the suite while every photo share link arrives blank.
        expect(installedState.imageUrl).toBe(
            'https://images.unsplash.com/photo-123?w=1080',
        );
        expect(fitView).toHaveBeenCalledWith(installedState);
        expect(persistNewPuzzle.mock.calls[0][0]).toBe(installedState);
    });

    it('never loads the traced chunk on the main thread', async () => {
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
        await loadSharedPuzzle(payload({ c: 'triangles', tf: { tv: 3 } }), undefined, deps);
        expect(preloadTracedTabGenerator).not.toHaveBeenCalled();
    });

    it('installs nothing when generation of a traced link fails', async () => {
        const failure = new Error('chunk boom');
        vi.mocked(createNewGameAsync).mockRejectedValue(failure);
        await expect(
            loadSharedPuzzle(payload({ c: 'triangles', tf: { tv: 3 } }), undefined, deps),
        ).rejects.toBe(failure);
        expect(install).not.toHaveBeenCalled();
    });

    it('loads the blank sentinel as a puzzle with no image', async () => {
        await loadSharedPuzzle(payload({ i: 'blank' }), undefined, deps);

        expect(install.mock.calls.at(-1)![0].imageUrl).toBeNull();
    });

    it('loads a legacy data: URL as a puzzle with no image', async () => {
        const legacy = 'data:image/png;base64,' + 'A'.repeat(64);
        await loadSharedPuzzle(payload({ i: legacy }), undefined, deps);

        expect(install.mock.calls.at(-1)![0].imageUrl).toBeNull();
    });

    it('generates a blank puzzle at the dimensions the link recorded', async () => {
        // `is` is part of the reproduction contract: a transposed or ignored
        // `is` cuts the puzzle differently than the sharer saw it. Non-square
        // on purpose — the helper's default wouldn't catch a transposition.
        await loadSharedPuzzle(payload({ i: 'blank', is: [777, 555] }), undefined, deps);

        expect(vi.mocked(createNewGameAsync).mock.calls.at(-1)![1]).toEqual({
            width: 777, height: 555,
        });
        expect(install.mock.calls.at(-1)![0].imageUrl).toBeNull();
    });

    it('loads a legacy data: URL with an uppercase scheme as a puzzle with no image', async () => {
        // `new URL` lowercases `.protocol`, so an uppercase `DATA:` link passes
        // wire validation; the collapse must match case-insensitively too.
        const legacy = 'DATA:image/png;base64,' + 'A'.repeat(64);
        await loadSharedPuzzle(payload({ i: legacy }), undefined, deps);

        expect(install.mock.calls.at(-1)![0].imageUrl).toBeNull();
    });

    it('loads a legacy data: URL with leading whitespace as a puzzle with no image', async () => {
        // `new URL` strips leading whitespace before reading `.protocol`, so a
        // leading-space `data:` link passes wire validation; the collapse must
        // match that too.
        const legacy = ' data:image/png;base64,' + 'A'.repeat(64);
        await loadSharedPuzzle(payload({ i: legacy }), undefined, deps);

        expect(install.mock.calls.at(-1)![0].imageUrl).toBeNull();
    });

    it('applies the attribution the link carried', async () => {
        await loadSharedPuzzle(payload({
            a: { n: 'A Photographer', u: 'https://unsplash.com/@photographer', p: 'https://unsplash.com/photos/abc123' },
        }), undefined, deps);

        const installedState = install.mock.calls[0][0];
        expect(installedState.attribution).toEqual({
            photographerName: 'A Photographer',
            photographerUrl: 'https://unsplash.com/@photographer',
            photoUrl: 'https://unsplash.com/photos/abc123',
        });
    });

    it('toasts when progress in the link could not be applied', async () => {
        // A single-id merge entry is structurally invalid (a merge needs ≥2
        // pieces), so `applyProgress` rejects it regardless of geometry.
        await loadSharedPuzzle(payload({ pr: { m: [[1]] } }), undefined, deps);

        expect(showToast).toHaveBeenCalledWith("Couldn't load progress — starting from scratch");
        // The puzzle still loads despite the rejected progress.
        expect(install).toHaveBeenCalledTimes(1);
    });

    it('reports new-game-started with source shared and recipientHadSavedState', async () => {
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());

        await loadSharedPuzzle(payload({ pr: { m: [] } }), makeGameState(), deps);

        const expected = expect.objectContaining({
            source: 'shared',
            recipientHadSavedState: true,
            includesProgress: true,
        });
        expect(onGameAnalytics).toHaveBeenCalledWith(expected, expect.anything());
        expect(onGameAnalytics.mock.calls[0][1]).toBe(install.mock.calls[0][0]);
        expect(umamiTrack).toHaveBeenCalledWith('new-game-started', expected);
        // #507: bootstrap clears the cached analytics on every `session.install`,
        // which is safe only because this assignment runs *after* it. Pin that
        // order — a reorder above `install` would let the clear wipe the fresh
        // payload, silently degrading every completion event to state-derived.
        expect(vi.mocked(install).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(onGameAnalytics).mock.invocationCallOrder[0],
        );
    });

    it('reports recipientHadSavedState false without a saved game', async () => {
        await loadSharedPuzzle(payload(), undefined, deps);

        expect(umamiTrack).toHaveBeenCalledWith(
            'new-game-started',
            expect.objectContaining({ recipientHadSavedState: false }),
        );
    });

    it('reports the game it replaced on new-game-started only', async () => {
        const saved = makeGameState();
        const replaced: ReplacedGameData = {
            replacedProgress: 0.25,
            replacedCompleted: false,
            replacedPieceCount: 48,
            replacedCutStyle: 'wavy',
        };
        replacedGameAnalytics.mockReturnValue(replaced);

        await loadSharedPuzzle(payload(), saved, deps);

        expect(replacedGameAnalytics).toHaveBeenCalledWith(saved);
        expect(umamiTrack).toHaveBeenCalledWith(
            'new-game-started',
            expect.objectContaining({ source: 'shared', ...replaced }),
        );
        expect(onGameAnalytics.mock.calls[0][0]).not.toHaveProperty('replacedProgress');
    });

    it('reads the replaced game before the shared one is installed', async () => {
        await loadSharedPuzzle(payload(), undefined, deps);

        expect(replacedGameAnalytics.mock.invocationCallOrder[0])
            .toBeLessThan(install.mock.invocationCallOrder[0]);
    });

    it('reports sharedColor none when the link carried no color', async () => {
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());

        await loadSharedPuzzle(payload(), undefined, deps);

        expect(adopt).not.toHaveBeenCalled();
        expect(onGameAnalytics).toHaveBeenCalledWith(
            expect.objectContaining({ sharedColor: 'none' }),
            expect.anything(),
        );
    });

    it('adopts a shared background color and reports the outcome', async () => {
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
        // 'invalid' not 'adopted': proves the reported outcome is whatever
        // `adopt` returns, not a value `loadSharedPuzzle` assumes.
        adopt.mockReturnValue('invalid');

        await loadSharedPuzzle(payload({ bgc: 'indigo-darker' }), undefined, deps);

        expect(adopt).toHaveBeenCalledWith('indigo-darker');
        expect(onGameAnalytics).toHaveBeenCalledWith(
            expect.objectContaining({ sharedColor: 'invalid' }),
            expect.anything(),
        );
    });

    it('hides the loading overlay even when generation throws', async () => {
        vi.mocked(createNewGameAsync).mockRejectedValue(new Error('generation boom'));

        await expect(loadSharedPuzzle(payload(), undefined, deps)).rejects.toThrow('generation boom');
        expect(hideLoadingOverlay).toHaveBeenCalled();
    });

    // #500: a throw after `install` but before the puzzle is saved leaves the
    // session holding a half-applied puzzle. Rolling it back keeps the boot
    // fallback's `hasGame()` gate from mistaking that for a finished game and
    // suppressing the last-resort puzzle.
    it('rolls the session back when fitView throws after install', async () => {
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
        fitView.mockImplementation(() => { throw new Error('fit boom'); });

        await expect(loadSharedPuzzle(payload(), undefined, deps)).rejects.toThrow('fit boom');

        expect(install).toHaveBeenCalledTimes(1);
        expect(uninstall).toHaveBeenCalledTimes(1);
        // Rolled back, not rolled back before it was even installed.
        expect(uninstall.mock.invocationCallOrder[0])
            .toBeGreaterThan(install.mock.invocationCallOrder[0]);
    });

    it('rolls the session back when install itself throws', async () => {
        // The wrapped trio's first step: a mid-install throw leaves the session
        // holding a stale reference (see game-session's render-throw case), so
        // the rollback must reach install too, not just fit/persist.
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
        install.mockImplementation(() => { throw new Error('install boom'); });

        await expect(loadSharedPuzzle(payload(), undefined, deps)).rejects.toThrow('install boom');

        expect(uninstall).toHaveBeenCalledTimes(1);
    });

    it('rolls the session back when persisting the new puzzle throws', async () => {
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
        persistNewPuzzle.mockImplementation(() => { throw new Error('persist boom'); });

        await expect(loadSharedPuzzle(payload(), undefined, deps)).rejects.toThrow('persist boom');

        expect(uninstall).toHaveBeenCalledTimes(1);
    });

    it('does not roll back when a step after the puzzle is saved throws', async () => {
        // The save already succeeded, so boot restores the puzzle — tearing it
        // back down here would be the regression. The window closes at persist.
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
        onGameAnalytics.mockImplementation(() => { throw new Error('analytics boom'); });

        await expect(loadSharedPuzzle(payload(), undefined, deps)).rejects.toThrow('analytics boom');

        expect(persistNewPuzzle).toHaveBeenCalledTimes(1);
        expect(uninstall).not.toHaveBeenCalled();
    });

    it('reports piece-count-mismatch with repro params when generation flags one', async () => {
        // Drive the callback directly rather than build a broken puzzle: the
        // detector is covered in generator.test.ts; this owns the wiring — the
        // callback is passed, captured, and reported against the resolved state.
        warnSpy = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        vi.mocked(createNewGameAsync).mockImplementation(async (imageUrl, imageSize, viewport, grid, options, signal) => {
            options?.onPieceCountMismatch?.({ expected: 4, actual: 2, baseCutId: 'sine' });
            return realCreateNewGameAsync(imageUrl, imageSize, viewport, grid, options, signal);
        });

        await loadSharedPuzzle(payload(), undefined, deps);

        expect(umamiTrack).toHaveBeenCalledWith('piece-count-mismatch', expect.objectContaining({
            source: 'shared',
            expected: 4,
            actual: 2,
            baseCut: 'sine',
            cols: 8,
            rows: 6,
        }));
        // On a local `npm run dev` the console copy is the only signal (`track`
        // is a no-op without a website ID), so it is tested here, not
        // incidental. Asserted against the payload read back out of the tracked
        // call so dropping a repro field from the console copy fails.
        const tracked = umamiTrack.mock.calls
            .find(([name]) => name === 'piece-count-mismatch')?.[1];
        expect(warnSpy).toHaveBeenCalledWith('[piece-count] repro params', tracked);
    });

    it('reports nothing for a healthy shared puzzle', async () => {
        await loadSharedPuzzle(payload(), undefined, deps);
        const names = umamiTrack.mock.calls.map(([name]) => name);
        expect(names).not.toContain('piece-count-mismatch');
    });

    // Closes the `source: 'repro'` gap (#512): a `__reproPuzzle` replay runs
    // this flow, and without an explicit source it reports as a real
    // recipient's 'shared' — a developer's replays become apparent incidents.
    it('reports source repro when the caller identifies the load as a repro replay', async () => {
        // Spied purely to silence it; console copy asserted once above.
        warnSpy = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        vi.mocked(createNewGameAsync).mockImplementation(async (imageUrl, imageSize, viewport, grid, options, signal) => {
            options?.onPieceCountMismatch?.({ expected: 4, actual: 2, baseCutId: 'sine' });
            return realCreateNewGameAsync(imageUrl, imageSize, viewport, grid, options, signal);
        });

        await loadSharedPuzzle(payload(), undefined, deps, 'repro');

        expect(umamiTrack).toHaveBeenCalledWith(
            'piece-count-mismatch',
            expect.objectContaining({ source: 'repro' }),
        );
    });

    it('stamps generationMode and generationMs on new-game-started', async () => {
        await loadSharedPuzzle(payload(), undefined, deps);

        expect(umamiTrack).toHaveBeenCalledWith('new-game-started', expect.objectContaining({
            generationMode: 'sync-fallback', // jsdom has no Worker
            generationMs: expect.any(Number),
        }));
    });

    it('passes onCancel to the overlay only when a game is installed', async () => {
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());

        await loadSharedPuzzle(payload(), undefined, { ...deps, hasCurrentGame: () => true });
        expect(vi.mocked(showLoadingOverlay).mock.calls[0][1]?.onCancel).toBeTypeOf('function');

        vi.mocked(showLoadingOverlay).mockClear();
        await loadSharedPuzzle(payload(), undefined, { ...deps, hasCurrentGame: () => false });
        expect(vi.mocked(showLoadingOverlay).mock.calls[0][1]?.onCancel).toBeUndefined();
    });

    // Cancellation is observed by `createNewGameAsync` itself; this file adds
    // no synchronous abort checkpoint, so this is the only way a load unwinds
    // on cancel.
    it('cancel unwinds silently: no install, no new-game-started, overlay hidden', async () => {
        // Hang the generation await until the test cancels mid-flight,
        // mirroring the real worker client's reaction to an aborted signal.
        vi.mocked(createNewGameAsync).mockImplementation(async (imageUrl, imageSize, viewport, grid, options, signal) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (signal?.aborted) throw new GenerationCanceledError();
            return realCreateNewGameAsync(imageUrl, imageSize, viewport, grid, options, signal);
        });

        const promise = loadSharedPuzzle(payload(), undefined, { ...deps, hasCurrentGame: () => true });
        const onCancel = vi.mocked(showLoadingOverlay).mock.calls[0][1]!.onCancel!;
        onCancel();

        await expect(promise).resolves.toBeUndefined(); // resolves, does not reject
        expect(install).not.toHaveBeenCalled();
        expect(umamiTrack).not.toHaveBeenCalledWith('new-game-started', expect.anything());
        expect(umamiTrack).toHaveBeenCalledWith('generation-canceled', expect.objectContaining({
            source: 'shared',
            cutStyle: 'classic',
            // 8×6 is wider than tall and the link stores the grid oriented —
            // the same test `buildSharedGameData` runs for `new-game-started`.
            orientation: 'landscape',
            cols: 8,
            rows: 6,
            elapsedMs: expect.any(Number),
        }));
        expect(hideLoadingOverlay).toHaveBeenCalled();
    });

    it("reports a canceled __reproPuzzle replay as source 'repro', not 'shared'", async () => {
        // `__reproPuzzle` ships in production builds and dev-deploy reports to
        // production's Umami website ID, so a hardcoded 'shared' would file a
        // developer's abandoned replay as real recipient abandonment (#512).
        vi.mocked(createNewGameAsync).mockImplementation(async (_u, _s, _v, _g, _o, signal) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (signal?.aborted) throw new GenerationCanceledError();
            throw new Error('expected the cancel to win');
        });

        const promise = loadSharedPuzzle(
            payload(), undefined, { ...deps, hasCurrentGame: () => true }, 'repro',
        );
        vi.mocked(showLoadingOverlay).mock.calls[0][1]!.onCancel!();
        await promise;

        expect(umamiTrack).toHaveBeenCalledWith('generation-canceled', expect.objectContaining({
            source: 'repro',
        }));
    });
});

function makeAsyncGenerationResult(state: GameState = makeGameState()) {
    return { state, generation: { mode: 'sync-fallback' as const, durationMs: 0 } };
}
