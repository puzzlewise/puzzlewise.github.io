import { describe, it, expect, vi, beforeAll } from 'vitest';

// Passthrough mock: inspect the config the classic strategy builds while still
// running real generation. See reference_vitest_spy_internal_module_call.
vi.mock('../puzzle/composable-generator.js', async (importActual) => {
    const actual = await importActual<typeof import('../puzzle/composable-generator.js')>();
    return { ...actual, generateComposablePuzzle: vi.fn(actual.generateComposablePuzzle) };
});

import { generateComposablePuzzle } from '../puzzle/composable-generator.js';
import { getCutStyleStrategy } from './cut-style-strategies.js';
import { createNewGame } from './init.js';
import { alignMatePaths } from '../model/align-mates.js';
import { quantizePieceGeometry } from '../model/quantize-geometry.js';
import { generateProceduralPuzzle } from '../puzzle/procedural-generator.js';
import { registerTabGenerator } from '../puzzle/topology/generator-registry.js';
import { tracedTabGenerator } from '../puzzle/topology/traced-tab-generator.js';

// Swap the lazy-load stub for the real traced generator so traced generation
// runs synchronously in tests (otherwise the stub throws "not loaded").
beforeAll(() => {
    registerTabGenerator(tracedTabGenerator);
});

// cols/3 and rows/3 are clean at this grid, matching classicStrategy's
// baseCutConfig.hf/vf derivation.
const grid = { cols: 6, rows: 3 };
const size = { width: 600, height: 300 };

describe('classicStrategy', () => {
    it('uses the sine pipeline with gentle params when classicConfig is set', () => {
        vi.mocked(generateComposablePuzzle).mockClear();
        const strategy = getCutStyleStrategy('classic');
        strategy.generatePieces(grid, size, 123, {
            classicConfig: { traceSetVersion: 1 },
        });
        const avgPieceArea = (size.width * size.height) / (grid.cols * grid.rows);
        expect(generateComposablePuzzle).toHaveBeenCalledWith(
            grid.cols, grid.rows, size, 123,
            expect.objectContaining({
                baseCutGenerator: 'sine',
                baseCutConfig: expect.objectContaining({
                    cols: grid.cols, rows: grid.rows, ha: 0.11, hf: 2, va: 0.11, vf: 1,
                }),
                tabGenerator: 'traced',
                tabConfig: { traceSetVersion: 1 },
                minPieceArea: avgPieceArea / 4,
                borderless: false,
            }),
        );
    });

    it('falls back to the legacy generator when classicConfig is absent', () => {
        vi.mocked(generateComposablePuzzle).mockClear();
        const strategy = getCutStyleStrategy('classic');
        const result = strategy.generatePieces(grid, size, 7, {});
        expect(generateComposablePuzzle).not.toHaveBeenCalled();
        const legacy = generateProceduralPuzzle(grid.cols, grid.rows, size, 7);
        expect(result.pieces.map((p) => p.shape)).toEqual(legacy.map((p) => p.shape));
    });

    it('exposes classicConfig as its configKey', () => {
        expect(getCutStyleStrategy('classic').configKey).toBe('classicConfig');
    });

    it('traced classic is deterministic and differs from legacy classic for the same seed', () => {
        const s = getCutStyleStrategy('classic');
        const tracedA = s.generatePieces(grid, size, 999, { classicConfig: { traceSetVersion: 1 } });
        const tracedB = s.generatePieces(grid, size, 999, { classicConfig: { traceSetVersion: 1 } });
        const legacy = generateProceduralPuzzle(grid.cols, grid.rows, size, 999);
        const shapes = (p: { pieces: { shape: string }[] }) => p.pieces.map((x) => x.shape);
        expect(shapes(tracedB)).toEqual(shapes(tracedA));       // reproducible
        expect(shapes(tracedA)).not.toEqual(legacy.map((x) => x.shape)); // traced actually ran
    });

    // Guards the init.ts plumbing: the `classicConfig` context entry (missing →
    // new Classic games silently generate legacy geometry) and the `configKey`
    // write-back (missing → config never reaches the save/share link, so the
    // puzzle can't be reproduced).
    it('createNewGame threads classicConfig into generation and onto the state', () => {
        const viewport = { width: 800, height: 600 };
        const state = createNewGame('img', size, viewport, grid, {
            cutStyle: 'classic',
            classicConfig: { traceSetVersion: 1 },
            seed: 4242,
        });
        expect(state.classicConfig).toEqual({ traceSetVersion: 1 });
        const legacy = generateProceduralPuzzle(grid.cols, grid.rows, size, 4242);
        expect(state.pieces.map((p) => p.shape)).not.toEqual(legacy.map((p) => p.shape));
    });

    it('createNewGame without classicConfig produces legacy classic geometry', () => {
        const viewport = { width: 800, height: 600 };
        const state = createNewGame('img', size, viewport, grid, {
            cutStyle: 'classic',
            seed: 4242,
        });
        expect(state.classicConfig).toBeUndefined();
        const legacy = alignMatePaths(quantizePieceGeometry(
            generateProceduralPuzzle(grid.cols, grid.rows, size, 4242),
        ));
        expect(state.pieces.map((p) => p.shape)).toEqual(legacy.map((p) => p.shape));
    });
});
