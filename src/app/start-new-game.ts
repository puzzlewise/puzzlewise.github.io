/**
 * The orchestration order here is a contract: no call reaching
 * `createNewGameAsync` may be added, removed, or reordered — share links and
 * saves replay a puzzle by re-running this seeded PRNG sequence from the seed
 * alone. Individual ordering constraints (chunk preload overlap, chunk outcome
 * before the download report, yield before generation, overlay teardown in
 * `finally`) are noted at each site below.
 */

import type { GameState, GridSize } from '../model/types.js';
import type { CutStyle } from '../game/cut-styles.js';
import { rotationModeForNewGame } from '../game/cut-styles.js';
import type { ComposableConfig } from '../puzzle/composable-generator.js';
import type { FractalDialogConfig, WavyDialogConfig } from '../ui/index.js';
import { showLoadingOverlay, hideLoadingOverlay, yieldForPaint } from '../ui/index.js';
import { getImageProxyBaseUrl, triggerPhotoDownload, type CandidateImage, type PageDraw } from '../images/index.js';
import { preloadTracedTabGenerator } from '../puzzle/topology/traced-tab-loader.js';
import { createNewGameAsync, GenerationCanceledError } from '../game/index.js';
import { diagnostics } from '../diagnostics.js';
import { track } from '../analytics/index.js';
import type { NewGameData, ReplacedGameData } from '../analytics/index.js';
import { planTracedTabs, resolveTracedTabOutcome } from './traced-tab-plan.js';
import { generatorConfigsForNewGame } from './generator-configs.js';
import { buildFreshGameData } from './new-game-payload.js';
import { buildPieceCountMismatchData } from './piece-count-mismatch-payload.js';
import type { PieceCountMismatch } from '../puzzle/topology/generator.js';
import { pickBundledImage } from './bundled-image.js';
import { resolveUnsplashImage } from './resolve-image.js';
import {
    orientationForViewport,
    orientGridSize,
    blankSizeForOrientation,
} from './orientation.js';
import type { GameSession } from './game-session.js';

export interface StartNewGameOptions {
    cutStyle?: CutStyle;
    composableConfig?: ComposableConfig;
    imageSource?: string;
    imageCategory?: string;
    /** Raw Unsplash query from the dev-only override; supersedes `imageCategory`'s query. */
    queryOverride?: string;
    fractalConfig?: FractalDialogConfig;
    wavyConfig?: WavyDialogConfig;
    vibrant?: boolean;
    rotationEnabled?: boolean;
    seed?: number;
    pickedImage?: CandidateImage;
    /**
     * Start the last-resort boot puzzle (#488): legacy Classic cut, lazy
     * traced-tab chunk never fetched, flagged in analytics. Overrides
     * `cutStyle` — see `planTracedTabs`.
     */
    bootFallback?: boolean;
}

export interface StartNewGameDeps {
    container: HTMLElement;
    /** Install-only slice: this flow installs a generated puzzle and never reads back the previous one. */
    session: Pick<GameSession, 'install'>;
    /**
     * Reset the viewport transform to identity. Called once generation resolves,
     * right before install — not earlier — so the new puzzle never renders under
     * the previous zoom, and a cancel/throw before that point leaves the current
     * pan/zoom untouched.
     */
    resetViewport: () => void;
    fitView: (state: GameState) => void;
    persistNewPuzzle: (state: GameState) => void;
    onGameAnalytics: (data: NewGameData, state: GameState) => void;
    /** Read before `session.install`, which replaces the game it describes. */
    replacedGameAnalytics: () => ReplacedGameData | undefined;
    /**
     * Whether a puzzle is installed. Gates the overlay's Cancel affordance:
     * canceling means "return to your current puzzle", so with nothing installed
     * there's nothing to offer.
     */
    hasCurrentGame: () => boolean;
}

/**
 * @param source - `'fresh'` for a real player start, `'dev'` for a dev-console
 * start (e.g. `__newComposableGame`). Only affects the `source` field of the
 * `piece-count-mismatch` and `generation-canceled` events, keeping developer
 * traffic out of the field-incident and cancel-rate signals (#512). Defaults to
 * the PLAYER path deliberately: a binding that forgets it opts INTO the incident
 * count and nothing goes red, so a non-player start MUST pass `'dev'`.
 */
export async function startNewGame(
    gridSize: GridSize,
    options: StartNewGameOptions,
    deps: StartNewGameDeps,
    source: 'fresh' | 'dev' = 'fresh',
): Promise<void> {
    const {
        cutStyle: requestedCutStyle = 'classic',
        composableConfig,
        imageSource,
        imageCategory,
        queryOverride,
        fractalConfig,
        wavyConfig,
        vibrant = false,
        rotationEnabled = false,
        seed,
        pickedImage,
        bootFallback = false,
    } = options;
    const startedAt = performance.now();
    const controller = new AbortController();
    showLoadingOverlay(
        undefined,
        deps.hasCurrentGame() ? { onCancel: () => controller.abort() } : {},
    );

    const viewport = {
        width: deps.container.clientWidth || window.innerWidth,
        height: deps.container.clientHeight || window.innerHeight,
    };

    // Only place orientation is decided; the grid and image size flow into the
    // save/share payload so replay reproduces it. Computed above the `try` so
    // the `catch`'s cancel branch reports the same post-transpose grid as
    // `new-game-started`; nothing here throws or consumes randomness.
    const orientation = orientationForViewport(viewport);
    const oriented = orientGridSize(gridSize, orientation);

    try {
        // `planTracedTabs` decides whether the lazy traced-tab chunk is needed
        // and which cut style is generated; the boot fallback forces legacy
        // Classic and skips the fetch, so recovery can't fail the way the start
        // it recovers from did.
        const tracedTabPlan = planTracedTabs({
            cutStyle: requestedCutStyle,
            tabGenerator: composableConfig?.tabGenerator,
            bootFallback,
        });
        const { cutStyle, preloadChunk } = tracedTabPlan;

        // Started here but awaited further down, so on paths that skipped the
        // dialog the chunk fetch overlaps the image request instead of running
        // ahead of it. The rejection is captured into a value, not left floating
        // (an unawaited rejected promise would surface as an unhandled
        // rejection); `null` is the success sentinel at the await site, so a
        // falsy rejection reason must be defaulted to a real Error or it reads
        // as success.
        const tracedTabsPreload = preloadChunk
            ? preloadTracedTabGenerator().then(
                () => null,
                (error: unknown) => error ?? new Error('Traced tab chunk failed to load'),
            )
            : null;

        const bundled = pickBundledImage(orientation);
        let imageUrl: string | null = bundled.url;
        let imageSize = bundled.size;
        let attribution: GameState['attribution'] = bundled.attribution;

        // Match the puzzle orientation so a portrait screen gets a portrait
        // blank.
        if (imageSource === 'blank') {
            imageUrl = null;
            imageSize = blankSizeForOrientation(orientation);
            attribution = undefined;
        }

        // Unsplash access is needed for the random fetch and the picked-photo
        // download trigger — not for blank or first-run (bundled defaults above).
        const proxyBaseUrl =
            imageSource !== 'blank' && imageSource !== 'first-run'
                ? getImageProxyBaseUrl()
                : null;

        let downloadLocation: string | undefined;
        let pageDraw: PageDraw | undefined;

        if (imageSource !== 'blank' && pickedImage) {
            // The player picked a concrete candidate in the dialog — use it
            // directly, no second API call.
            imageUrl = pickedImage.imageUrl;
            imageSize = pickedImage.imageSize;
            attribution = pickedImage.attribution;
            downloadLocation = pickedImage.downloadLocation;
            pageDraw = pickedImage.pageDraw;
        } else if (proxyBaseUrl) {
            const resolved = await resolveUnsplashImage(proxyBaseUrl, imageCategory ?? 'any', vibrant, orientation, controller.signal, queryOverride);
            if (resolved) {
                imageUrl = resolved.imageUrl;
                imageSize = resolved.imageSize;
                attribution = resolved.attribution;
                downloadLocation = resolved.downloadLocation;
                pageDraw = resolved.pageDraw;
            }
        }

        // Collect the chunk outcome now the image has resolved — before the
        // download report, not after: a start about to throw must not report a
        // "download" for a photo it discards.
        const tracedTabs = resolveTracedTabOutcome({
            plan: tracedTabPlan,
            chunkError: tracedTabsPreload ? await tracedTabsPreload : null,
        });
        if (tracedTabs.kind === 'fail') throw tracedTabs.error;
        // Read twice (warned here, and handed to `buildFreshGameData` for the
        // `tracedChunkDegraded` flag), so it gets one spelling. Aliasing the
        // discriminant keeps `tracedTabs.error` narrowed.
        const chunkDegraded = tracedTabs.kind === 'legacy-classic' && tracedTabs.degraded;
        if (chunkDegraded) {
            // Degrading is quiet for the player, not for us: warn so a dev
            // console says why Classic changed shape, and flag analytics so
            // these stay separable from pre-upgrade Classic traffic.
            diagnostics.warn(
                'Traced tab chunk failed to load; Classic fell back to the legacy cut:',
                tracedTabs.error,
            );
        }

        // A canceled start must not report a "download" for a photo it discards
        // — same reason as the `'fail'` throw above.
        if (controller.signal.aborted) throw new GenerationCanceledError();

        // Unsplash guidelines: report a "download" when a photo is actually
        // used. Fire-and-forget — a failure must never block the game.
        if (proxyBaseUrl && downloadLocation) {
            triggerPhotoDownload(downloadLocation, proxyBaseUrl).catch(() => {});
        }

        const rotationMode = rotationModeForNewGame(cutStyle, rotationEnabled);

        const generatorConfigs = generatorConfigsForNewGame({
            cutStyle,
            fractalConfig,
            wavyConfig,
            tracedTabsOk: tracedTabs.kind === 'ok',
        });

        // Let the overlay paint before generation starts. Off-thread when
        // possible, but the yield still matters for the sync fallback.
        await yieldForPaint();

        // The callback fires synchronously during generation, before the state
        // exists — captured here to report below once it does.
        let pieceCountMismatch: PieceCountMismatch | undefined;
        const { state, generation } = await createNewGameAsync(
            imageUrl, imageSize, viewport, oriented,
            {
                cutStyle,
                composableConfig,
                ...generatorConfigs,
                rotationMode,
                seed,
                onPieceCountMismatch: (m) => { pieceCountMismatch = m; },
            },
            controller.signal,
        );

        if (attribution) {
            state.attribution = attribution;
        }

        const replaced = deps.replacedGameAnalytics();

        // Reset now that generation produced a puzzle, before install, so it
        // never renders under the previous zoom. Not earlier: every
        // cancellation checkpoint above must unwind without touching the transform.
        deps.resetViewport();
        deps.session.install(state);
        deps.fitView(state);
        deps.persistNewPuzzle(state);

        const data = buildFreshGameData({
            state,
            cutStyle,
            rotationMode,
            orientation,
            oriented,
            imageSource,
            imageCategory,
            vibrant,
            pickedImage,
            pageDraw,
            downloadLocation,
            chunkDegraded,
            bootFallback,
            generation,
        });
        deps.onGameAnalytics(data, state);
        track('new-game-started', { ...data, ...replaced });

        // Reported after `new-game-started` so that event still lands first if
        // anything below throws. A diagnostic, not an error — must never block a start.
        if (pieceCountMismatch) {
            const mismatchData =
                buildPieceCountMismatchData(state, pieceCountMismatch, source);
            track('piece-count-mismatch', mismatchData);
            // Also to the console: the generator's own `[piece-count]` warn
            // can't carry repro params (it's handed `random: () => number`, not
            // the seed), so on a local `npm run dev` — where `track` is a no-op
            // without a website ID — this is the only replayable set. Same
            // object the event ships, so it pastes into `__reproPuzzle` like an
            // Umami row. On any deployed build `diagnostics` can't be turned on,
            // so this never prints and the Umami event is the whole signal.
            diagnostics.warn('[piece-count] repro params', mismatchData);
        }
    } catch (err) {
        if (err instanceof GenerationCanceledError) {
            track('generation-canceled', {
                // The real source, not a hardcoded 'fresh': `installDevHooks`
                // runs in production and dev-deploy shares production's Umami
                // ID, so a developer canceling `__newComposableGame` would
                // otherwise read as an impatient player (#512).
                source,
                cutStyle: requestedCutStyle,
                orientation,
                // Post-transpose, like `new-game-started`: the requested grid is
                // landscape-normalized, so reporting it raw would file every
                // portrait cancel under a grid no completed start reports.
                cols: oriented.cols,
                rows: oriented.rows,
                elapsedMs: Math.round(performance.now() - startedAt),
            });
            return;
        }
        throw err;
    } finally {
        hideLoadingOverlay();
    }
}
