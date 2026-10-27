/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance } from 'vitest';
import type { GameState } from '../model/types.js';
import type { ReplacedGameData } from '../analytics/index.js';
import { makeGameState } from '../test-helpers/fixtures.js';
import { diagnostics } from '../diagnostics.js';

vi.mock('../ui/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../ui/index.js')>()),
    showLoadingOverlay: vi.fn(),
    hideLoadingOverlay: vi.fn(),
    yieldForPaint: vi.fn(async () => {}),
}));
vi.mock('../images/index.js', () => ({
    getImageProxyBaseUrl: vi.fn(),
    triggerPhotoDownload: vi.fn(async () => {}),
}));
// `createNewGame` runs for real, and its registry imports
// `tracedTabGeneratorStub` from this module — replacing the whole module
// instead of passing through via `importOriginal` would break every real generation.
vi.mock('../puzzle/topology/traced-tab-loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../puzzle/topology/traced-tab-loader.js')>();
    return { ...actual, preloadTracedTabGenerator: vi.fn(async () => {}) };
});
// `resolveUnsplashImage` isn't exercised here, so it's stubbed — left real it
// would reach `fetchRandomPhotos` behind the `../images/index.js` mock, which
// doesn't export it. Stubbing also gives the "no second API call" test
// something to assert on.
vi.mock('./resolve-image.js', () => ({ resolveUnsplashImage: vi.fn() }));
// Plain `vi.spyOn` can't intercept the `createNewGameAsync` call
// `start-new-game.ts` makes across modules under Vite; wrap the real
// implementation via `vi.mock` passthrough so ordering/cancel tests can observe
// when it ran and the signal it got, while other tests still generate a real puzzle.
vi.mock('../game/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../game/index.js')>();
    return { ...actual, createNewGameAsync: vi.fn(actual.createNewGameAsync) };
});

import { showLoadingOverlay, hideLoadingOverlay, yieldForPaint } from '../ui/index.js';
import { getImageProxyBaseUrl, triggerPhotoDownload } from '../images/index.js';
import { preloadTracedTabGenerator } from '../puzzle/topology/traced-tab-loader.js';
import { resolveUnsplashImage } from './resolve-image.js';
import { createNewGameAsync, GenerationCanceledError } from '../game/index.js';
import { startNewGame, type StartNewGameDeps, type StartNewGameOptions } from './start-new-game.js';

/**
 * The real generation logic the mock wraps, captured so `beforeEach` can
 * restore it: `vi.clearAllMocks()` clears call records but not a
 * `mockImplementation` override, so a stub one test sets would otherwise leak
 * into every later test.
 */
const realCreateNewGameAsync = vi.mocked(createNewGameAsync).getMockImplementation()!;

/**
 * Options for a start that completes real generation without the lazy
 * traced-tab chunk (never loaded here). Composable with an explicit `'classic'`
 * tab generator never asks the registry for it.
 */
function noTracedTabsOptions(overrides: Partial<StartNewGameOptions> = {}): StartNewGameOptions {
    return {
        cutStyle: 'composable',
        composableConfig: { tabGenerator: 'classic' },
        imageSource: 'blank',
        ...overrides,
    };
}

describe('startNewGame', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;
    let install: Mock<(state: GameState) => void>;
    let resetViewport: Mock<() => void>;
    let fitView: Mock<(state: GameState) => void>;
    let persistNewPuzzle: Mock<(state: GameState) => void>;
    let onGameAnalytics: Mock<(data: unknown, state: GameState) => void>;
    let replacedGameAnalytics: Mock<() => ReplacedGameData | undefined>;
    let deps: StartNewGameDeps;
    /**
     * Restored one by one, not via `vi.restoreAllMocks()`: `vite.config.ts`
     * sets no `restoreMocks`, and a blanket restore would strip the `vi.mock`
     * factory implementations above.
     */
    let warnSpy: MockInstance<typeof diagnostics.warn> | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getImageProxyBaseUrl).mockReturnValue(undefined);
        vi.mocked(preloadTracedTabGenerator).mockResolvedValue(undefined);
        vi.mocked(resolveUnsplashImage).mockResolvedValue(null);
        vi.mocked(createNewGameAsync).mockImplementation(realCreateNewGameAsync);

        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };

        install = vi.fn();
        resetViewport = vi.fn();
        fitView = vi.fn();
        persistNewPuzzle = vi.fn();
        onGameAnalytics = vi.fn();
        replacedGameAnalytics = vi.fn(() => undefined);
        deps = {
            container: document.createElement('div'),
            session: { install },
            resetViewport,
            fitView,
            persistNewPuzzle,
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

    it('installs a blank puzzle with no image', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        const state = install.mock.calls.at(-1)![0];
        expect(state.imageUrl).toBeNull();
        // The exact blank landscape size, not merely non-zero: the bundled
        // fallback is 1080×722, so a loose assertion would pass even if the
        // blank branch never ran.
        expect(state.imageSize).toEqual({ width: 1080, height: 720 });
    });

    it('installs a puzzle, fits the view and persists it', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        expect(install).toHaveBeenCalledTimes(1);
        expect(fitView).toHaveBeenCalled();
        expect(persistNewPuzzle.mock.calls[0][0]).toBe(install.mock.calls[0][0]);
        expect(resetViewport).toHaveBeenCalled();
        // The viewport is reset only after generation resolves and before
        // install — not earlier, so a canceled/throwing start never touches the
        // current pan/zoom.
        const createOrder = vi.mocked(createNewGameAsync).mock.invocationCallOrder[0];
        const resetOrder = vi.mocked(resetViewport).mock.invocationCallOrder[0];
        const installOrder = vi.mocked(install).mock.invocationCallOrder[0];
        expect(createOrder).toBeLessThan(resetOrder);
        expect(resetOrder).toBeLessThan(installOrder);
    });

    it('shows the loading overlay and always hides it', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);
        expect(showLoadingOverlay).toHaveBeenCalled();
        expect(hideLoadingOverlay).toHaveBeenCalled();
    });

    // Pins ordering step 5: `hideLoadingOverlay()` runs in a `finally`.
    it('hides the loading overlay even when generation throws', async () => {
        install.mockImplementation(() => {
            throw new Error('install boom');
        });

        await expect(
            startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps),
        ).rejects.toThrow('install boom');
        expect(hideLoadingOverlay).toHaveBeenCalled();
    });

    it('reports new-game-started with the fresh source, and records it as the current analytics', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);
        expect(umamiTrack).toHaveBeenCalledWith(
            'new-game-started',
            expect.objectContaining({ source: 'fresh' }),
        );
        expect(onGameAnalytics).toHaveBeenCalledWith(
            expect.objectContaining({ source: 'fresh' }),
            expect.anything(),
        );
        expect(onGameAnalytics.mock.calls[0][1]).toBe(install.mock.calls[0][0]);
        // #507: bootstrap clears the cached analytics on every `session.install`,
        // which is safe only because this assignment runs *after* it. Pin that
        // order — a reorder above `install` would let the clear wipe the fresh
        // payload, silently degrading every completion event to state-derived.
        expect(vi.mocked(install).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(onGameAnalytics).mock.invocationCallOrder[0],
        );
        // An ordinary start must carry no `bootFallback` key at all. Absence,
        // not `false`, is what `umami.ts` subtracts to size the #488 recovery
        // bucket — setting the flag unconditionally would inflate exactly that
        // bucket, and nothing else in the suite catches it.
        expect(umamiTrack).toHaveBeenCalledTimes(1);
        expect(umamiTrack.mock.calls[0][1]).not.toHaveProperty('bootFallback');
    });

    it('reports the game it replaced on new-game-started only', async () => {
        const replaced: ReplacedGameData = {
            replacedProgress: 0.5,
            replacedCompleted: false,
            replacedPieceCount: 24,
            replacedCutStyle: 'triangles',
            replacedElapsedMs: 60_000,
        };
        replacedGameAnalytics.mockReturnValue(replaced);

        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        expect(umamiTrack).toHaveBeenCalledWith(
            'new-game-started',
            expect.objectContaining({ source: 'fresh', ...replaced }),
        );
        // The cached payload is persisted and spread onto this game's
        // `puzzle-completed`, which must not report the previous game.
        expect(onGameAnalytics.mock.calls[0][0]).not.toHaveProperty('replacedProgress');
    });

    it('reads the replaced game before the new one is installed', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        expect(replacedGameAnalytics.mock.invocationCallOrder[0])
            .toBeLessThan(install.mock.invocationCallOrder[0]);
    });

    it('reports no replaced game when there was none', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        expect(umamiTrack.mock.calls[0][1]).not.toHaveProperty('replacedProgress');
    });

    // Pins ordering step 1: the boot fallback forces the plan before
    // anything else runs, so the recovery path never touches the chunk.
    it('never fetches the traced chunk for a boot-fallback start', async () => {
        // The recovery path must not be able to fail the way the start it is
        // recovering from did.
        await startNewGame({ cols: 2, rows: 2 }, { bootFallback: true, imageSource: 'blank' }, deps);
        expect(preloadTracedTabGenerator).not.toHaveBeenCalled();
    });

    it('flags a boot-fallback game in analytics', async () => {
        await startNewGame({ cols: 2, rows: 2 }, { bootFallback: true, imageSource: 'blank' }, deps);
        expect(umamiTrack).toHaveBeenCalledWith(
            'new-game-started',
            expect.objectContaining({ bootFallback: true }),
        );
    });

    // The whole degraded-Classic seam end to end. Classic declares
    // `tracedTabs: 'always'` but survives the fetch failing (the legacy
    // straight-grid generator needs no chunk); every other style throws on
    // `'fail'`. This is the flag `umami.ts` leans on hardest: without it a
    // degraded game is indistinguishable from pre-upgrade Classic traffic. Both
    // ends are covered in isolation, but nothing else drives a degrading start
    // through this file.
    it('flags a Classic game degraded by a failed chunk fetch, and warns', async () => {
        warnSpy = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        const chunkError = new Error('chunk boom');
        vi.mocked(preloadTracedTabGenerator).mockRejectedValue(chunkError);

        await startNewGame(
            { cols: 2, rows: 2 },
            { cutStyle: 'classic', imageSource: 'blank' },
            deps,
        );

        // The start completed on the legacy cut rather than throwing.
        expect(install).toHaveBeenCalledTimes(1);
        expect(umamiTrack).toHaveBeenCalledWith(
            'new-game-started',
            expect.objectContaining({ cutStyle: 'classic', tracedChunkDegraded: true }),
        );
        expect(onGameAnalytics).toHaveBeenCalledWith(
            expect.objectContaining({ tracedChunkDegraded: true }),
            expect.anything(),
        );
        // Quiet for the player, not for us — carries the reason so a dev
        // console says why Classic changed shape.
        expect(warnSpy).toHaveBeenCalledWith(expect.any(String), chunkError);
    });

    it('leaves a healthy Classic start unflagged', async () => {
        // The control for the case above: same style and path, but
        // `preloadTracedTabGenerator` resolves, so the payload must carry no
        // `tracedChunkDegraded` key. Absence, not `false`, is what the
        // pre-upgrade-tail query subtracts on. Generation is stubbed here and
        // only here on the Classic path: a healthy Classic start runs the traced
        // pipeline whose real chunk is never loaded in this file, so real
        // generation would throw for an unrelated reason. The degraded case
        // needs no stub — the legacy fallback is generable.
        warnSpy = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());

        await startNewGame(
            { cols: 2, rows: 2 },
            { cutStyle: 'classic', imageSource: 'blank' },
            deps,
        );

        expect(umamiTrack).toHaveBeenCalledTimes(1);
        expect(umamiTrack.mock.calls[0][1]).not.toHaveProperty('tracedChunkDegraded');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    // Pins ordering step 3: the chunk outcome is collected before the download
    // report, so a start about to throw doesn't credit a photo it discards. Uses
    // a picked image so `downloadLocation` is set on success — otherwise the
    // assertion would pass regardless of ordering.
    it('does not report an Unsplash download when the start throws first', async () => {
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        vi.mocked(preloadTracedTabGenerator).mockRejectedValue(new Error('chunk boom'));

        await expect(
            startNewGame(
                { cols: 2, rows: 2 },
                { cutStyle: 'wavy', pickedImage: makeCandidateImage() },
                deps,
            ),
        ).rejects.toThrow('chunk boom');
        expect(triggerPhotoDownload).not.toHaveBeenCalled();
    });

    // Falsy-rejection defaulting: `null` is the await site's success sentinel,
    // so a chunk-fetch rejection whose reason is itself `null` must be defaulted
    // to a real Error or it reads as success. `createNewGameAsync` is stubbed to
    // succeed regardless of traced-tab availability, so a wrongly-read success
    // reaches `install` rather than throwing for the unrelated missing-chunk
    // reason — otherwise this would pass regardless.
    it('treats a null chunk-fetch rejection as a real failure, not the success sentinel', async () => {
        vi.mocked(preloadTracedTabGenerator).mockRejectedValue(null);
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());

        await expect(
            startNewGame({ cols: 2, rows: 2 }, { cutStyle: 'wavy', imageSource: 'blank' }, deps),
        ).rejects.toThrow();
        expect(install).not.toHaveBeenCalled();
    });

    it('skips the proxy-URL lookup for a blank puzzle', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);
        expect(getImageProxyBaseUrl).not.toHaveBeenCalled();
    });

    it('skips the proxy-URL lookup for the first-run puzzle', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions({ imageSource: 'first-run' }), deps);
        expect(getImageProxyBaseUrl).not.toHaveBeenCalled();
    });

    it('uses a player-picked photo directly, without a second Unsplash fetch', async () => {
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        const picked = makeCandidateImage();

        await startNewGame(
            { cols: 2, rows: 2 },
            noTracedTabsOptions({ imageSource: undefined, pickedImage: picked }),
            deps,
        );

        expect(resolveUnsplashImage).not.toHaveBeenCalled();
        expect(triggerPhotoDownload).toHaveBeenCalledWith(
            picked.downloadLocation,
            'https://proxy.example',
        );
    });

    it("reports a picked photo's page draw on new-game-started", async () => {
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        const picked = { ...makeCandidateImage(), pageDraw: { page: 9, knownPages: 166 } };

        await startNewGame(
            { cols: 2, rows: 2 },
            noTracedTabsOptions({ imageSource: undefined, pickedImage: picked }),
            deps,
        );

        expect(umamiTrack).toHaveBeenCalledWith('new-game-started', expect.objectContaining({
            imagePage: 9,
            imagePagesKnown: 166,
        }));
    });

    it("reports a Surprise me photo's page draw on new-game-started", async () => {
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        vi.mocked(resolveUnsplashImage).mockResolvedValue({
            ...makeCandidateImage(),
            pageDraw: { page: 3, knownPages: 0 },
        });

        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions({ imageSource: undefined }), deps);

        expect(umamiTrack).toHaveBeenCalledWith('new-game-started', expect.objectContaining({
            imagePage: 3,
            imagePagesKnown: 0,
        }));
    });

    // Pins ordering step 2 (first half): the chunk preload starts
    // synchronously, before the first `await`, so it overlaps the image
    // resolution. The style needs traced tabs so `preloadChunk` is true; the
    // outcome is irrelevant (real chunk never loaded), so the rejection is swallowed.
    it('starts the traced chunk fetch synchronously, before awaiting anything', async () => {
        const promise = startNewGame({ cols: 2, rows: 2 }, { cutStyle: 'wavy', imageSource: 'blank' }, deps);
        expect(preloadTracedTabGenerator).toHaveBeenCalledTimes(1);
        await promise.catch(() => {});
    });

    // Pins ordering step 2 (second half): the preload is awaited *after* the
    // image request, so the two overlap. The preload resolves only once
    // `resolveUnsplashImage` releases it; awaiting the chunk first would
    // deadlock — `resolveUnsplashImage` never runs, the preload never resolves,
    // and the test hangs rather than fails.
    it('overlaps the chunk fetch with the image request, rather than awaiting it first', async () => {
        let release!: () => void;
        vi.mocked(preloadTracedTabGenerator).mockReturnValue(
            new Promise<void>((resolve) => { release = resolve; }),
        );
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        vi.mocked(resolveUnsplashImage).mockImplementation(async () => {
            release();
            return null;
        });
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());

        await startNewGame({ cols: 2, rows: 2 }, { cutStyle: 'wavy' }, deps);

        expect(resolveUnsplashImage).toHaveBeenCalled();
    });

    it('passes the query override through to the Unsplash resolve', async () => {
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());

        await startNewGame(
            { cols: 2, rows: 2 },
            { cutStyle: 'wavy', imageCategory: 'nature', vibrant: true, queryOverride: 'red bicycles' },
            deps,
        );

        expect(resolveUnsplashImage).toHaveBeenCalledWith(
            'https://proxy.example', 'nature', true, expect.any(String), expect.anything(), 'red bicycles',
        );
    });

    // Pins ordering step 4: the overlay paints before generation (the yield
    // still matters for the sync fallback jsdom exercises here).
    it('yields for paint before generation starts', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        const yieldOrder = vi.mocked(yieldForPaint).mock.invocationCallOrder[0];
        const createOrder = vi.mocked(createNewGameAsync).mock.invocationCallOrder[0];
        expect(yieldOrder).toBeLessThan(createOrder);
    });

    it('reports piece-count-mismatch with repro params when generation flags one', async () => {
        // Drive the callback directly rather than building a broken puzzle: the
        // detector is covered in generator.test.ts; this owns the wiring — the
        // callback is passed, captured, and reported against the resolved state.
        warnSpy = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        vi.mocked(createNewGameAsync).mockImplementation(async (imageUrl, imageSize, viewport, grid, options, signal) => {
            options?.onPieceCountMismatch?.({ expected: 4, actual: 2, baseCutId: 'sine' });
            return realCreateNewGameAsync(imageUrl, imageSize, viewport, grid, options, signal);
        });

        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        expect(umamiTrack).toHaveBeenCalledWith('piece-count-mismatch', expect.objectContaining({
            source: 'fresh',
            expected: 4,
            actual: 2,
            baseCut: 'sine',
            cols: 2,
            rows: 2,
        }));
        // The console copy is the only signal on a local `npm run dev` (where
        // `track` is a no-op), so it's tested, not incidental. Asserted against
        // the payload read back from the tracked call, not a second
        // `objectContaining`: two matchers over the same keys both stay green if
        // `warn` got a trimmed copy, which would break the
        // paste-into-`__reproPuzzle`-identically property.
        const tracked = umamiTrack.mock.calls
            .find(([name]) => name === 'piece-count-mismatch')?.[1];
        expect(warnSpy).toHaveBeenCalledWith('[piece-count] repro params', tracked);
    });

    // #512: dev-console starts pass 'dev' so a developer poking at parameters
    // doesn't inflate the field-incident count. The binding is
    // `bootstrap.test.ts`'s concern; this checks the parameter reaches the tracked event.
    it('threads a non-default source through to the mismatch event', async () => {
        // Spied purely to silence: the branch also writes repro params to the
        // console, and `diagnostics` is on under Vitest, so an unstubbed run
        // prints on every suite run.
        warnSpy = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        vi.mocked(createNewGameAsync).mockImplementation(async (imageUrl, imageSize, viewport, grid, options, signal) => {
            options?.onPieceCountMismatch?.({ expected: 4, actual: 2, baseCutId: 'sine' });
            return realCreateNewGameAsync(imageUrl, imageSize, viewport, grid, options, signal);
        });

        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps, 'dev');

        expect(umamiTrack).toHaveBeenCalledWith(
            'piece-count-mismatch',
            expect.objectContaining({ source: 'dev' }),
        );
    });

    it('never reports the image URL on the mismatch event', async () => {
        // Silencing again, as above.
        warnSpy = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        vi.mocked(createNewGameAsync).mockImplementation(async (imageUrl, imageSize, viewport, grid, options, signal) => {
            options?.onPieceCountMismatch?.({ expected: 4, actual: 2, baseCutId: 'sine' });
            return realCreateNewGameAsync(imageUrl, imageSize, viewport, grid, options, signal);
        });

        // A player-picked photo, so the state carries a real `https://` URL — a
        // blank puzzle has none, making the redaction assertion unfailable.
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        await startNewGame(
            { cols: 2, rows: 2 },
            noTracedTabsOptions({ imageSource: undefined, pickedImage: makeCandidateImage() }),
            deps,
        );
        expect(install.mock.calls.at(-1)?.[0].imageUrl).toContain('https://');

        const call = umamiTrack.mock.calls.find(([name]) => name === 'piece-count-mismatch');
        // Named separately so a missing event fails with "no call found" rather
        // than the opaque error `JSON.stringify(undefined)` throws below.
        expect(call).toBeDefined();
        expect(JSON.stringify(call?.[1])).not.toContain('http');
    });

    it('reports nothing for a healthy puzzle', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);
        const names = umamiTrack.mock.calls.map(([name]) => name);
        expect(names).not.toContain('piece-count-mismatch');
    });

    it('stamps generationMode and generationMs on new-game-started', async () => {
        await startNewGame({ cols: 2, rows: 2 }, noTracedTabsOptions(), deps);

        expect(umamiTrack).toHaveBeenCalledWith('new-game-started', expect.objectContaining({
            generationMode: 'sync-fallback', // jsdom has no Worker
            generationMs: expect.any(Number),
        }));
    });

    it('passes onCancel to the overlay only when a game is installed', async () => {
        await startNewGame(
            { cols: 2, rows: 2 },
            noTracedTabsOptions(),
            { ...deps, hasCurrentGame: () => true },
        );
        expect(vi.mocked(showLoadingOverlay).mock.calls[0][1]?.onCancel).toBeTypeOf('function');

        vi.mocked(showLoadingOverlay).mockClear();
        await startNewGame(
            { cols: 2, rows: 2 },
            noTracedTabsOptions(),
            { ...deps, hasCurrentGame: () => false },
        );
        expect(vi.mocked(showLoadingOverlay).mock.calls[0][1]?.onCancel).toBeUndefined();
    });

    // A cancellation observed by `createNewGameAsync` itself (not the earlier
    // sync abort check) must unwind quietly: no install, no `new-game-started`,
    // overlay down, and the current pan/zoom untouched (`resetViewport` runs
    // after generation, before install, so a canceled start never reaches it).
    it('cancel unwinds silently: no install, no new-game-started, overlay hidden', async () => {
        // Make generation hang until the test cancels mid-flight, mirroring the
        // real worker client's reaction to an aborted signal.
        vi.mocked(createNewGameAsync).mockImplementation(async (imageUrl, imageSize, viewport, grid, options, signal) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (signal?.aborted) throw new GenerationCanceledError();
            return realCreateNewGameAsync(imageUrl, imageSize, viewport, grid, options, signal);
        });

        const promise = startNewGame(
            { cols: 2, rows: 2 },
            noTracedTabsOptions(),
            { ...deps, hasCurrentGame: () => true },
        );
        const onCancel = vi.mocked(showLoadingOverlay).mock.calls[0][1]!.onCancel!;
        onCancel();

        await expect(promise).resolves.toBeUndefined(); // resolves, does not reject
        expect(install).not.toHaveBeenCalled();
        expect(resetViewport).not.toHaveBeenCalled();
        expect(umamiTrack).not.toHaveBeenCalledWith('new-game-started', expect.anything());
        expect(umamiTrack).toHaveBeenCalledWith('generation-canceled', expect.objectContaining({
            source: 'fresh',
            cutStyle: 'composable',
            cols: 2,
            rows: 2,
            elapsedMs: expect.any(Number),
        }));
        expect(hideLoadingOverlay).toHaveBeenCalled();
    });

    it('reports a cancel with the post-transpose grid, matching new-game-started', async () => {
        // Every `PUZZLE_SIZE_OPTIONS` entry is landscape-normalized, and
        // `new-game-started` reports the grid after orientation. Reporting the
        // requested grid on cancel would file every portrait cancel under a
        // bucket no completed start lands in, so "cancel rate by grid" would
        // divide two disjoint populations.
        const container = document.createElement('div');
        Object.defineProperty(container, 'clientWidth', { value: 400 });
        Object.defineProperty(container, 'clientHeight', { value: 800 });

        await startNewGame(
            { cols: 4, rows: 3 },
            noTracedTabsOptions(),
            { ...deps, container, hasCurrentGame: () => true },
            'dev',
        );
        const started = umamiTrack.mock.calls
            .find(([name]) => name === 'new-game-started')![1] as
            { cols: number; rows: number; orientation: string };
        expect(started).toMatchObject({ cols: 3, rows: 4, orientation: 'portrait' });

        umamiTrack.mockClear();
        vi.mocked(showLoadingOverlay).mockClear();
        vi.mocked(createNewGameAsync).mockImplementation(async (_u, _s, _v, _g, _o, signal) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (signal?.aborted) throw new GenerationCanceledError();
            throw new Error('expected the cancel to win');
        });

        const promise = startNewGame(
            { cols: 4, rows: 3 },
            noTracedTabsOptions(),
            { ...deps, container, hasCurrentGame: () => true },
            'dev',
        );
        vi.mocked(showLoadingOverlay).mock.calls[0][1]!.onCancel!();
        await promise;

        expect(umamiTrack).toHaveBeenCalledWith('generation-canceled', expect.objectContaining({
            // Same grid and orientation the completed start reported, so both
            // are segment filters across the two events, not a per-event comparison.
            cols: 3,
            rows: 4,
            orientation: 'portrait',
            // And the real source, not 'fresh': `installDevHooks` ships in
            // production, so a developer canceling `__newComposableGame` must
            // not read as an impatient player (#512).
            source: 'dev',
        }));
    });

    // Pins the cancel rule (like the "throws first" test, but for
    // cancellation): the abort check sits before the download-report block, so a
    // canceled start never credits a discarded photo. Cancels from inside the
    // awaited image resolution — the last async step before the check — so it
    // exercises the real ordering, not a mock.
    it('does not report an Unsplash download when canceled before the download report', async () => {
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        vi.mocked(resolveUnsplashImage).mockImplementation(async () => {
            // `showLoadingOverlay` already ran synchronously in this call, so
            // its `onCancel` is on the mock's record.
            vi.mocked(showLoadingOverlay).mock.calls[0][1]!.onCancel!();
            return {
                imageUrl: 'https://images.unsplash.com/random.jpg',
                imageSize: { width: 400, height: 300 },
                attribution: {
                    photographerName: 'A Photographer',
                    photographerUrl: 'https://unsplash.com/@photographer',
                    photoUrl: 'https://unsplash.com/photos/random',
                },
                downloadLocation: 'https://api.unsplash.com/photos/random/download',
            };
        });

        await startNewGame(
            { cols: 2, rows: 2 },
            { cutStyle: 'wavy' },
            { ...deps, hasCurrentGame: () => true },
        );

        expect(triggerPhotoDownload).not.toHaveBeenCalled();
        expect(umamiTrack).toHaveBeenCalledWith('generation-canceled', expect.objectContaining({
            cutStyle: 'wavy',
        }));
    });

    // #536: Cancel used to be dead while a new game waited on the image fetch —
    // the abort signal never reached the network phase. Prove the signal handed
    // to `resolveUnsplashImage` is the one `onCancel` aborts, so a cancel during
    // a stalled fetch is observed there (`resolve-image.test.ts` covers the
    // abort → GenerationCanceledError map inside that call).
    it('aborts the signal it hands resolveUnsplashImage when Cancel is clicked', async () => {
        vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
        let capturedSignal: AbortSignal | undefined;
        vi.mocked(resolveUnsplashImage).mockImplementation(async (_proxy, _category, _vibrant, _orientation, signal) => {
            capturedSignal = signal;
            vi.mocked(showLoadingOverlay).mock.calls[0][1]!.onCancel!();
            return null;
        });

        await startNewGame(
            { cols: 2, rows: 2 },
            { cutStyle: 'wavy' },
            { ...deps, hasCurrentGame: () => true },
        );

        expect(capturedSignal?.aborted).toBe(true);
    });
});

function makeCandidateImage() {
    return {
        imageUrl: 'https://images.unsplash.com/picked.jpg',
        imageSize: { width: 400, height: 300 },
        attribution: {
            photographerName: 'A Photographer',
            photographerUrl: 'https://unsplash.com/@photographer',
            photoUrl: 'https://unsplash.com/photos/abc123',
        },
        downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
        thumbUrl: 'https://images.unsplash.com/picked-thumb.jpg',
    };
}

function makeAsyncGenerationResult(state: GameState = makeGameState()) {
    return { state, generation: { mode: 'sync-fallback' as const, durationMs: 0 } };
}
