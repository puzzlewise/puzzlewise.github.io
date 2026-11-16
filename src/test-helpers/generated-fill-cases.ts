import { beforeAll, describe, expect, test } from 'vitest';
import type { Size } from '../model/types.js';
import {
    buildPieceFill,
    FLATTEN_TOLERANCE,
    MAX_COMPACTNESS,
    MAX_FILL_POINTS,
    measureOutlineGroup,
    outlineGroups,
    SPIKY_MIN_POINTS,
} from '../renderer/webgl/piece-mesh.js';
import { DISPLAY_WIDTH } from '../images/unsplash-display-image.js';
import { orientationForViewport, orientGridSize } from '../app/orientation.js';
import { registerTabGenerator } from '../puzzle/topology/generator-registry.js';
import { tracedTabGenerator } from '../puzzle/topology/traced-tab-generator.js';
import { CURRENT_TRACE_SET_VERSION } from '../puzzle/composable/traces/trace-set-version.js';
import { JITTER_MAX, SINE_AMPLITUDE_MAX, SINE_FREQUENCY_MAX } from '../ui/new-game-dialog.js';
import { composableSliderToGeneratorConfig, type ComposableSliderPreference } from '../game/composable-config.js';
import { runGeneration, type GenerationRequest } from '../game/generation-core.js';
import type { CutStyle } from '../game/cut-styles.js';
import { PUZZLE_SIZE_OPTIONS } from '../game/puzzle-sizes.js';

// Fails while real puzzles still keep a margin below the fill limits, not once a piece loses its fill.
const HEADROOM = 0.8;

type Style = Omit<GenerationRequest, 'gridSize' | 'imageSize' | 'seed' | 'tabDebug'>;

const V = CURRENT_TRACE_SET_VERSION;

function composable(slider: Partial<ComposableSliderPreference>, traceSetVersion?: number): Style & { cutStyle: 'composable' } {
    const config = composableSliderToGeneratorConfig({
        baseCut: 'sine',
        horizontalAmplitude: SINE_AMPLITUDE_MAX,
        horizontalFrequency: SINE_FREQUENCY_MAX,
        verticalAmplitude: SINE_AMPLITUDE_MAX,
        verticalFrequency: SINE_FREQUENCY_MAX,
        tabGenerator: 'classic',
        borderless: false,
        jitter: JITTER_MAX,
        smooth: false,
        ...slider,
    });
    return {
        cutStyle: 'composable',
        composableConfig: traceSetVersion === undefined ? config : { ...config, tabConfig: { traceSetVersion } },
    };
}

function photo(aspect: number): Size {
    return { width: DISPLAY_WIDTH, height: Math.round(DISPLAY_WIDTH * aspect) };
}

const LANDSCAPE = photo(2 / 3);
const PANORAMA = photo(1 / 4);
const PHONE = photo(16 / 9);
const TALL = photo(3);
const TALLER = photo(6);
const TALLEST = photo(8);

interface Case<S extends CutStyle = CutStyle> {
    style: Style & { cutStyle: S };
    images: Size[];
    seeds: number[];
}

const ONE_SEED = [1];
// Include the seeds behind the largest real outlines measured: Fractal borderless 4 and 2, sine traced 7 and 21.
const FRACTAL_SEEDS = [1, 2, 3, 4, 5];
const SINE_TRACED_SEEDS = [1, 7, 21];

export const CASES = {
    classic: {
        'classic traced': { style: { cutStyle: 'classic', classicConfig: { traceSetVersion: V } }, images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
        'classic legacy': { style: { cutStyle: 'classic' }, images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
    },
    fractal: {
        'fractal': { style: { cutStyle: 'fractal', fractalConfig: { borderless: false } }, images: [LANDSCAPE, PHONE, TALLEST], seeds: ONE_SEED },
        'fractal borderless': {
            style: { cutStyle: 'fractal', fractalConfig: { borderless: true } },
            images: [LANDSCAPE, PHONE, TALLER, TALLEST],
            seeds: FRACTAL_SEEDS,
        },
    },
    wavy: {
        'wavy traced': { style: { cutStyle: 'wavy', wavyConfig: { borderless: false, traceSetVersion: V } }, images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
        'wavy traced borderless': { style: { cutStyle: 'wavy', wavyConfig: { borderless: true, traceSetVersion: V } }, images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
        'wavy classic tabs borderless': { style: { cutStyle: 'wavy', wavyConfig: { borderless: true } }, images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
    },
    triangles: {
        'triangles': { style: { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: V } }, images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
    },
    composable: {
        'sine classic tabs': { style: composable({}), images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
        'sine no tabs': { style: composable({ tabGenerator: 'none' }), images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
        'sine classic tabs borderless': { style: composable({ borderless: true }), images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
        'sine traced tabs': { style: composable({ tabGenerator: 'traced' }), images: [PANORAMA, PHONE, TALL], seeds: SINE_TRACED_SEEDS },
        'sine traced tabs borderless': { style: composable({ tabGenerator: 'traced', borderless: true }), images: [PANORAMA, PHONE, TALL], seeds: SINE_TRACED_SEEDS },
        'sine traced tabs v2': { style: composable({ tabGenerator: 'traced' }, 2), images: [PANORAMA, PHONE, TALL], seeds: SINE_TRACED_SEEDS },
        'sine traced tabs v2 borderless': { style: composable({ tabGenerator: 'traced', borderless: true }, 2), images: [PANORAMA, PHONE, TALL], seeds: SINE_TRACED_SEEDS },
        'triangular traced tabs': { style: composable({ baseCut: 'triangular', tabGenerator: 'traced' }), images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
        'triangular smooth classic tabs': { style: composable({ baseCut: 'triangular', smooth: true }), images: [LANDSCAPE, PHONE], seeds: ONE_SEED },
    },
} satisfies { [S in CutStyle]: Record<string, Case<S>> };

const ALL_CASES: Record<string, Case> = Object.assign({}, ...Object.values(CASES));

const sizes = [...PUZZLE_SIZE_OPTIONS].sort((a, b) => a.pieceCount - b.pieceCount);
const GRIDS = [sizes[0], sizes[sizes.length - 1]];

// The slowest cases run in files of their own, under src/game, so vitest's workers run them in parallel.
export const OWN_FILE_CASES = {
    'sine traced tabs': 'generated-fills.sine-traced.test.ts',
    'sine traced tabs borderless': 'generated-fills.sine-traced-borderless.test.ts',
    'sine traced tabs v2': 'generated-fills.sine-traced-v2.test.ts',
    'sine traced tabs v2 borderless': 'generated-fills.sine-traced-v2-borderless.test.ts',
} as const satisfies Partial<Record<keyof typeof CASES.composable, string>>;

export const SHARED_FILE_CASES = Object.keys(ALL_CASES).filter((name) => !(name in OWN_FILE_CASES));

export function describeFillMargins(names: readonly string[]): void {
    beforeAll(() => {
        registerTabGenerator(tracedTabGenerator);
    });
    describe('every cut style the new-game dialog offers, at its slider maxima, stays clear of the fill limits', () => {
        for (const name of names) {
            const { style, images, seeds } = ALL_CASES[name];
            test(name, { timeout: 120_000 }, () => {
                const tooClose: string[] = [];
                for (const grid of GRIDS) {
                    const small = grid === GRIDS[0];
                    for (const imageSize of small ? images : images.filter((size) => size.height <= PHONE.height)) {
                        const gridSize = orientGridSize(grid, orientationForViewport(imageSize));
                        for (const seed of small ? seeds : ONE_SEED) {
                            const { pieces } = runGeneration({ ...style, gridSize, imageSize, seed, tabDebug: false });
                            for (const piece of pieces) {
                                const mesh = buildPieceFill(piece, FLATTEN_TOLERANCE);
                                for (const group of outlineGroups(mesh.loops)) {
                                    const { points, compactness } = measureOutlineGroup(group);
                                    if (mesh.fillOmitted
                                        || points > HEADROOM * MAX_FILL_POINTS
                                        || (points > HEADROOM * SPIKY_MIN_POINTS && compactness > HEADROOM * MAX_COMPACTNESS)) {
                                        tooClose.push(`${gridSize.cols}x${gridSize.rows} ${imageSize.width}x${imageSize.height} seed ${seed} piece ${piece.id}: ${points} points, compactness ${compactness.toFixed(1)}`);
                                    }
                                }
                            }
                        }
                    }
                }
                expect(tooClose).toEqual([]);
            });
        }
    });
}
