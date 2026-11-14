import { describe, expect, test } from 'vitest';
import type { Rgba } from '../index.js';
import { OUTLINE_PRESETS } from './halo-atlas-plan.js';
import { gaussianKernel, HALO_STATES, haloMargin, haloSteps, haloTexelsPerUnit } from './halo-recipe.js';
import { MAX_BLUR_TAPS } from './shaders.js';

const GLOW: Rgba = [1, 0.8, 0.2, 1];
const BLACK: Rgba = [0, 0, 0, 1];

describe('haloSteps', () => {
    test('idle with outline preset has no halo', () => {
        expect(haloSteps('idle', 'outline', GLOW)).toEqual([]);
        expect(haloSteps('idle', 'none', GLOW)).toEqual([]);
    });

    test('idle with shadow preset is one σ4 black 0.35 step', () => {
        expect(haloSteps('idle', 'shadow', GLOW)).toEqual([{ sigma: 4, color: BLACK, alpha: 0.35, prefix: true }]);
    });

    test('selected-dragging is drag shadow then three glows, in order', () => {
        const steps = haloSteps('selected-dragging', 'outline', GLOW);
        expect(steps.map((s) => s.sigma)).toEqual([12, 6, 14, 24]);
        expect(steps.map((s) => s.alpha)).toEqual([0.45, 0.9, 0.7, 0.4]);
        expect(steps[0]!.color).toEqual(BLACK);
        expect(steps[1]!.color).toEqual([1, 0.8, 0.2, 1]);
    });

    test('shadow preset prefixes every non-empty chain', () => {
        for (const state of ['selected', 'dragging', 'selected-dragging'] as const) {
            const plain = haloSteps(state, 'outline', GLOW);
            const shadowed = haloSteps(state, 'shadow', GLOW);
            expect(shadowed[0]).toEqual({ sigma: 4, color: BLACK, alpha: 0.35, prefix: true });
            expect(shadowed.slice(1)).toEqual(plain);
        }
    });

    test('glow alpha scales with the glow color alpha', () => {
        const steps = haloSteps('selected', 'outline', [1, 0, 0, 0.5]);
        expect(steps.map((s) => s.alpha)).toEqual([0.45, 0.35, 0.2].map((a) => expect.closeTo(a, 6)));
        expect(steps[0]!.color).toEqual([1, 0, 0, 1]);
    });
});

describe('haloSteps isolation', () => {
    test('mutating a returned step does not affect later calls', () => {
        const first = haloSteps('selected-dragging', 'shadow', GLOW);
        for (const step of first) {
            (step.color as unknown as number[])[0] = 0.5;
            step.alpha = 0;
            step.sigma = 99;
        }
        expect(haloSteps('selected-dragging', 'shadow', GLOW)).toEqual([
            { sigma: 4, color: BLACK, alpha: 0.35, prefix: true },
            { sigma: 12, color: BLACK, alpha: 0.45 },
            { sigma: 6, color: [1, 0.8, 0.2, 1], alpha: 0.9 },
            { sigma: 14, color: [1, 0.8, 0.2, 1], alpha: 0.7 },
            { sigma: 24, color: [1, 0.8, 0.2, 1], alpha: 0.4 },
        ]);
    });
});

describe('gaussianKernel', () => {
    test('gaussianKernel sums to 1 and is symmetric', () => {
        const k = gaussianKernel(3, 0.5);
        expect(k.length).toBe(2 * Math.ceil(4.5) + 1);
        expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
        for (let i = 0; i < k.length; i++) expect(k[i]).toBe(k[k.length - 1 - i]);
        expect(k[5]).toBeGreaterThan(k[4]!);
    });

    test('every step of every preset and state fits in the blur shader\'s taps', () => {
        for (const preset of OUTLINE_PRESETS) {
            for (const state of HALO_STATES) {
                const steps = haloSteps(state, preset, GLOW);
                for (const step of steps) {
                    expect(gaussianKernel(step.sigma, haloTexelsPerUnit(steps)).length).toBeLessThanOrEqual(MAX_BLUR_TAPS);
                }
            }
        }
    });
});

describe('haloMargin', () => {
    test('is three combined σ, rounded up to a whole texel', () => {
        const steps = haloSteps('selected-dragging', 'shadow', GLOW);
        expect(haloMargin(steps)).toBe(Math.ceil(3 * Math.sqrt(16 + 144 + 36 + 196 + 576) * 0.25) / 0.25);
        expect(haloMargin(steps)).toBe(96);
        expect(haloMargin([])).toBe(0);
    });

    test('never exceeds the summed support of the truncated kernels', () => {
        expect(haloMargin(haloSteps('idle', 'shadow', GLOW))).toBe(12);
        expect(haloMargin(haloSteps('dragging', 'outline', GLOW))).toBe(36);
    });
});

describe('haloTexelsPerUnit', () => {
    test('selected is 0.25', () => {
        expect(haloTexelsPerUnit(haloSteps('selected', 'outline', GLOW))).toBe(0.25);
    });
    test('dragging alone is 0.125', () => {
        expect(haloTexelsPerUnit(haloSteps('dragging', 'outline', GLOW))).toBe(0.125);
    });
    test('shadow idle (prefix alone) is 0.375', () => {
        expect(haloTexelsPerUnit(haloSteps('idle', 'shadow', GLOW))).toBe(0.375);
    });
    test('selected-dragging under shadow is 0.25', () => {
        expect(haloTexelsPerUnit(haloSteps('selected-dragging', 'shadow', GLOW))).toBe(0.25);
    });
    test('caps at 1 texel per unit', () => {
        expect(haloTexelsPerUnit([{ sigma: 1, color: BLACK, alpha: 1 }])).toBe(1);
    });
});
