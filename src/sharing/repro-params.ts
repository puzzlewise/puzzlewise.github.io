/**
 * The settings modal's "Reproduction parameters" block and the `__reproPuzzle`
 * console helper share this contract: the modal prints a `ReproParams` as JSON,
 * the helper accepts that object. `imageSize` is part of the contract, not
 * decoration — generators inscribe the puzzle into the image rect, so the same
 * seed/grid/style cuts differently at different dimensions.
 */

import type { GameState, GridSize, Size } from '../model/types.js';
import type { SharePayload, StyleConfigSource } from './share-link.js';
import {
    applyStyleConfigs,
    isCutStyle,
    isRotationMode,
} from './share-link.js';

/**
 * Declared in the order buildReproParams writes / the block prints.
 * `cutStyle`/`rotationMode` are plain strings, not the wire unions: this object
 * is hand-typed from a screenshot, so literal types would be a fiction —
 * reproParamsToPayload validates both at runtime.
 */
export interface ReproParams extends StyleConfigSource {
    seed?: number;
    cutStyle?: string;
    imageUrl?: string;
    imageSize?: Size;
    gridSize?: GridSize;
    rotationMode?: string;
}

/** Kept minimal so a screenshot of the block is easy to read. */
export function buildReproParams(state: GameState): ReproParams {
    const params: ReproParams = {};
    if (state.seed !== undefined) params.seed = state.seed;
    if (state.cutStyle) params.cutStyle = state.cutStyle;
    if (state.imageUrl) params.imageUrl = state.imageUrl;
    if (state.imageSize) params.imageSize = state.imageSize;
    if (state.gridSize) params.gridSize = state.gridSize;
    if (state.rotationMode) params.rotationMode = state.rotationMode;
    if (state.composableConfig) params.composableConfig = state.composableConfig;
    if (state.fractalConfig) params.fractalConfig = state.fractalConfig;
    if (state.wavyConfig) params.wavyConfig = state.wavyConfig;
    if (state.trianglesConfig) params.trianglesConfig = state.trianglesConfig;
    // Load-bearing for Classic: its presence selects the sine generator over
    // the legacy one — omitting it would describe a different puzzle.
    if (state.classicConfig) params.classicConfig = state.classicConfig;
    return params;
}

/**
 * Throws naming the field when a required field is missing or `cutStyle`/
 * `rotationMode` is unrecognized (a screenshot predating `imageSize`, a typo);
 * naming beats the decoder's bare `null`. Absent style config is preserved: no
 * `classicConfig` → no `clf` → the legacy Classic generator.
 *
 * The wire format can't carry two things, so a replay matches geometry but not
 * every detail: `imageSize` is floored to whole pixels (sub-pixel difference on
 * inscribed fractal/wavy rects), and no attribution or background color is
 * emitted (a replayed Unsplash puzzle loses its credit and the sharer's color).
 */
export function reproParamsToPayload(params: ReproParams): SharePayload {
    // `== null` so an explicit `imageSize: null` is named here too, rather
    // than throwing an unattributed `TypeError` on the property read below.
    function required<T>(value: T | undefined, name: string): T {
        if (value == null) {
            throw new Error(`Repro params missing required field: ${name}`);
        }
        return value;
    }

    const cutStyle = required(params.cutStyle, 'cutStyle');
    if (!isCutStyle(cutStyle)) {
        throw new Error(`Repro params has an unknown cutStyle: ${cutStyle}`);
    }
    const rotationMode = params.rotationMode ?? 'none';
    if (!isRotationMode(rotationMode)) {
        throw new Error(`Repro params has an unknown rotationMode: ${rotationMode}`);
    }
    const imageSize = required(params.imageSize, 'imageSize');
    const gridSize = required(params.gridSize, 'gridSize');
    const payload: SharePayload = {
        v: 1,
        i: params.imageUrl ?? 'blank',
        is: [imageSize.width, imageSize.height],
        g: [gridSize.cols, gridSize.rows],
        c: cutStyle,
        s: required(params.seed, 'seed'),
        r: rotationMode,
    };
    applyStyleConfigs(payload, params);
    return payload;
}
