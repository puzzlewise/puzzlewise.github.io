/**
 * The pure generate phase of a new game. Extracted from `init.ts` so the worker
 * and the synchronous main-thread fallback run byte-identical code — the
 * seeded-PRNG call-order contract (share links/saves replay from the seed
 * alone) has one implementation regardless of thread.
 *
 * Request and result are structured-cloneable; the result crosses `postMessage`
 * on the worker path. Quantize + seal run here, inside the worker, deliberately:
 * sealing drops the dense curve samples before the clone — most of the payload.
 */

import type { GridSize, Piece, Size } from '../model/types.js';
import type { FractalConfig } from '../puzzle/fractal/index.js';
import type { ComposableConfig } from '../puzzle/composable-generator.js';
import type { AutoGroup } from '../puzzle/topology/auto-group.js';
import type { PieceCountMismatch } from '../puzzle/topology/generator.js';
import type { TabDebugReport } from '../puzzle/topology/tab-debug.js';
import { TabDebugSession } from '../puzzle/topology/tab-debug.js';
import { alignMatePaths } from '../model/align-mates.js';
import { quantizePieceGeometry } from '../model/quantize-geometry.js';
import { sealPieceGeometry } from '../model/seal-geometry.js';
import type { CutStyle } from './cut-styles.js';
import { getCutStyleStrategy } from './cut-style-strategies.js';

/** Plain data — worker-safe. */
export interface GenerationRequest {
    cutStyle: CutStyle;
    gridSize: GridSize;
    imageSize: Size;
    seed: number;
    fractalConfig?: FractalConfig;
    /**
     * `ComposableConfig` minus `tabDebug`: a live `TabDebugSession` is a class
     * with a function property, so it can't cross `structuredClone`/`postMessage`.
     * The request's `tabDebug: boolean` carries the intent instead, and
     * `runGeneration` builds the session locally. Same as
     * `GameState.composableConfig` (`model/types.ts`).
     */
    composableConfig?: Omit<ComposableConfig, 'tabDebug'>;
    wavyConfig?: { borderless?: boolean; traceSetVersion?: number };
    trianglesConfig?: { traceSetVersion?: number };
    classicConfig?: { traceSetVersion?: number };
    /**
     * Whether to run a tab-debug session. A boolean, not a session: the flag is
     * read from the URL on the main thread (workers have no `window.location`)
     * and the session can't cross the worker boundary — it's built in
     * `runGeneration`, and only its plain-data report travels back.
     */
    tabDebug: boolean;
}

/** Plain data — worker-safe. */
export interface GenerationResult {
    pieces: Piece[];
    puzzleSize: Size;
    autoGroups?: AutoGroup[];
    tabDebugReport?: TabDebugReport;
    pieceCountMismatch?: PieceCountMismatch;
}

export function runGeneration(request: GenerationRequest): GenerationResult {
    const strategy = getCutStyleStrategy(request.cutStyle);
    const tabDebug = request.tabDebug ? new TabDebugSession() : undefined;
    const ctx = {
        fractalConfig: request.fractalConfig,
        composableConfig: request.composableConfig,
        wavyConfig: request.wavyConfig,
        trianglesConfig: request.trianglesConfig,
        classicConfig: request.classicConfig,
        tabDebug,
    };

    const generationGrid = strategy.scaleGrid(request.gridSize, request.imageSize, ctx);
    const puzzleSize = strategy.inscribePuzzleSize(request.imageSize, generationGrid, ctx);
    const { pieces: rawPieces, autoGroups, tabDebugReport, pieceCountMismatch } =
        strategy.generatePieces(generationGrid, puzzleSize, request.seed, ctx);

    const pieces = sealPieceGeometry(alignMatePaths(quantizePieceGeometry(rawPieces)));

    return { pieces, puzzleSize, autoGroups, tabDebugReport, pieceCountMismatch };
}

/**
 * Whether generating this request hits the traced-tab generator, so needs the
 * lazy chunk loaded first. Keep in step with which strategies pass
 * `tabGenerator: 'traced'` in `cut-style-strategies.ts`. Mirrors
 * `needsTracedTabChunk` (`app/share-payload-to-init.ts`) for share payloads.
 */
export function requestNeedsTracedTabs(request: GenerationRequest): boolean {
    switch (request.cutStyle) {
        case 'triangles':
            return true;
        case 'classic':
            return request.classicConfig?.traceSetVersion !== undefined;
        case 'wavy':
            return request.wavyConfig?.traceSetVersion !== undefined;
        case 'composable':
            return request.composableConfig?.tabGenerator === 'traced';
        case 'fractal':
            return false;
    }
}
