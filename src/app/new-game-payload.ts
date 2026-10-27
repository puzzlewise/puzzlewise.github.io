import type { GameState, GridSize, Orientation } from '../model/types.js';
import type { NewGameData } from '../analytics/index.js';
import type { GenerationOutcome } from '../game/index.js';
import type { CandidateImage, PageDraw } from '../images/index.js';
import { classifyImageSource, resolveNewGameImageSource } from './classify-image-source.js';
import { traceSetVersionOf } from './trace-set-version.js';

export function buildFreshGameData(opts: {
    state: GameState;
    cutStyle: string;
    rotationMode: 'none' | 'quarter-turn' | 'free';
    orientation: Orientation;
    oriented: GridSize;
    imageSource?: string;
    imageCategory?: string;
    vibrant: boolean;
    pickedImage?: CandidateImage;
    pageDraw?: PageDraw;
    chunkDegraded: boolean;
    bootFallback: boolean;
    generation: GenerationOutcome;
}): NewGameData {
    const {
        state, cutStyle, rotationMode, orientation, oriented,
        imageSource, imageCategory, vibrant, pickedImage, pageDraw, chunkDegraded, bootFallback, generation,
    } = opts;

    const data: NewGameData = {
        source: 'fresh',
        cutStyle,
        rotationMode,
        orientation,
        cols: oriented.cols,
        rows: oriented.rows,
        pieceCount: state.pieces.length,
        // resolveNewGameImageSource honors the 'first-run' sentinel;
        // classifyImageSource can't (both reuse the bundled URL).
        imageSource: resolveNewGameImageSource(imageSource, state.imageUrl),
        generationMode: generation.mode,
        generationMs: generation.durationMs,
    };
    if (generation.fallbackKind !== undefined) {
        data.generationFallbackKind = generation.fallbackKind;
    }
    if (generation.fallbackReason !== undefined) {
        data.generationFallbackReason = generation.fallbackReason;
    }
    // Read off the generated state: createNewGame kept only the config
    // matching cutStyle. Degraded Classic withholds classicConfig, so no version.
    const traceSetVersion = traceSetVersionOf(state);
    if (traceSetVersion !== undefined) {
        data.traceSetVersion = traceSetVersion;
    }
    // Only degraded Classic reaches here (start-new-game.ts threw for other
    // styles). Without the flag it's indistinguishable from pre-upgrade Classic
    // traffic — both classic with no traceSetVersion.
    if (chunkDegraded) {
        data.tracedChunkDegraded = true;
    }
    // Boot fallback never fetched the chunk (no failure to record) but is
    // legacy geometry too, so it must be excludable from the same query.
    if (bootFallback) {
        data.bootFallback = true;
    }
    if (data.imageSource === 'unsplash') {
        data.imageCategory = imageCategory ?? 'any';
        data.vibrant = vibrant;
        data.imagePicked = pickedImage !== undefined;
        if (pageDraw !== undefined) {
            data.imagePage = pageDraw.page;
            data.imagePagesKnown = pageDraw.knownPages;
        }
    }

    return data;
}

export function buildSharedGameData(opts: {
    state: GameState;
    includesProgress: boolean;
    recipientHadSavedState: boolean;
    sharedColor: NonNullable<NewGameData['sharedColor']>;
    generation: GenerationOutcome;
}): NewGameData {
    const { state, includesProgress, recipientHadSavedState, sharedColor, generation } = opts;

    const data: NewGameData = {
        source: 'shared',
        cutStyle: state.cutStyle ?? 'classic',
        rotationMode: state.rotationMode ?? 'none',
        // Link stores the post-transpose grid; taller-than-wide, squares read
        // landscape (matches orientGridSize's normalization).
        orientation:
            state.gridSize.rows > state.gridSize.cols ? 'portrait' : 'landscape',
        cols: state.gridSize.cols,
        rows: state.gridSize.rows,
        pieceCount: state.pieces.length,
        imageSource: classifyImageSource(state.imageUrl),
        includesProgress,
        recipientHadSavedState,
        sharedColor,
        generationMode: generation.mode,
        generationMs: generation.durationMs,
    };
    if (generation.fallbackKind !== undefined) {
        data.generationFallbackKind = generation.fallbackKind;
    }
    if (generation.fallbackReason !== undefined) {
        data.generationFallbackReason = generation.fallbackReason;
    }
    // Read off the generated state, not the payload: createNewGame kept only
    // the config matching the cut style, so the crafted-link guard is
    // structural instead of per-style.
    const traceSetVersion = traceSetVersionOf(state);
    if (traceSetVersion !== undefined) {
        data.traceSetVersion = traceSetVersion;
    }

    return data;
}
