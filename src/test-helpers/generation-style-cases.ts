import { getCutStyleStrategy } from '../game/cut-style-strategies.js';
import type { CutStyle } from '../game/cut-styles.js';
import type { InitOptions } from '../game/init.js';
import type { GeneratedPiece, GridSize } from '../model/types.js';

export const imageSize = { width: 1080, height: 720 };
export const viewport = { width: 1200, height: 900 };
export const SEED = 4242;

export interface StyleCase {
    name: string;
    grid: GridSize;
    options: InitOptions & { cutStyle: CutStyle };
}

// Small grids: precision is per-coordinate, so max piece count isn't needed
// (and Triangles at 192 takes seconds).
export const styles: StyleCase[] = [
    {
        name: 'classic (sine + traced tabs)',
        grid: { cols: 6, rows: 3 },
        options: { cutStyle: 'classic', classicConfig: { traceSetVersion: 1 } },
    },
    {
        name: 'classic (legacy generator)',
        grid: { cols: 6, rows: 3 },
        options: { cutStyle: 'classic' },
    },
    {
        name: 'wavy',
        grid: { cols: 6, rows: 4 },
        options: { cutStyle: 'wavy', wavyConfig: { traceSetVersion: 1 } },
    },
    {
        name: 'triangles',
        grid: { cols: 4, rows: 3 },
        options: { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 1 } },
    },
    {
        name: 'fractal',
        grid: { cols: 6, rows: 4 },
        options: { cutStyle: 'fractal', fractalConfig: {} },
    },
    {
        // Config arrives from the share link (widest coordinate range). `hf` is
        // deliberately not 2-decimal: config stays full precision, only the
        // geometry it produces is rounded.
        name: 'composable',
        grid: { cols: 6, rows: 4 },
        options: {
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { cols: 6, rows: 4, ha: 0.4, hf: 4 / 3, va: 0.4, vf: 1 },
                tabGenerator: 'classic',
            },
        },
    },
];

/**
 * The pieces the generator hands `createNewGame`, before quantization. Mirrors
 * its `scaleGrid` → `inscribePuzzleSize` → `generatePieces` sequence, which
 * matters for Fractal (derived grid) — the raw grid would compare a different
 * puzzle.
 */
export function generateRaw(style: StyleCase): GeneratedPiece[] {
    const strategy = getCutStyleStrategy(style.options.cutStyle);
    const grid = strategy.scaleGrid(style.grid, imageSize, style.options);
    const puzzleSize = strategy.inscribePuzzleSize(imageSize, grid, style.options);
    return strategy.generatePieces(grid, puzzleSize, SEED, style.options).pieces;
}
