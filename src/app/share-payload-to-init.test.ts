import { describe, it, expect } from 'vitest';
import type { SharePayload } from '../sharing/index.js';
import { shareInitOptions } from './share-payload-to-init.js';

/**
 * Minimal decoded payload: the required fields `{ v, i, is, g, c, s, r }` with
 * no optional blocks. Callers override what each test cares about.
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

describe('shareInitOptions', () => {
    it('carries seed, cut style and rotation mode through', () => {
        const options = shareInitOptions(payload({ c: 'wavy', s: 1234, r: 'free' }));
        expect(options.cutStyle).toBe('wavy');
        expect(options.seed).toBe(1234);
        expect(options.rotationMode).toBe('free');
    });

    it('reconstructs the per-style configs the payload carries', () => {
        const options = shareInitOptions(payload({
            c: 'wavy',
            wf: { bl: true, tv: 2 },
        }));
        expect(options.wavyConfig).toEqual({ borderless: true, traceSetVersion: 2 });
    });

    it('omits configs the payload does not carry', () => {
        const options = shareInitOptions(payload({ c: 'classic' }));
        expect(options.classicConfig).toBeUndefined();
        expect(options.wavyConfig).toBeUndefined();
        expect(options.trianglesConfig).toBeUndefined();
        expect(options.composableConfig).toBeUndefined();
    });

    it('reconstructs the classicConfig the payload carries', () => {
        // classicConfig's presence discriminates the sine-based Classic
        // generator from the legacy straight-grid one, so its populated mapping
        // needs its own assertion. tv: 4 is distinct from every other fixture's
        // tv so a cross-wired mapping can't pass.
        const options = shareInitOptions(payload({ c: 'classic', clf: { tv: 4 } }));
        expect(options.classicConfig).toEqual({ traceSetVersion: 4 });
    });

    it('reconstructs a composable config via shareCfToComposableConfig', () => {
        const options = shareInitOptions(payload({
            c: 'composable',
            cf: { bg: 'sine', bgc: { hf: 2 }, tg: 'classic', tgc: {}, bl: true },
        }));
        expect(options.composableConfig).toEqual({
            baseCutGenerator: 'sine',
            baseCutConfig: { hf: 2 },
            tabGenerator: 'classic',
            tabConfig: {},
            borderless: true,
        });
    });

    it('reconstructs fractal and triangles configs', () => {
        const fractalOptions = shareInitOptions(payload({ c: 'fractal', ff: { bl: true } }));
        expect(fractalOptions.fractalConfig).toEqual({ borderless: true });

        const trianglesOptions = shareInitOptions(payload({ c: 'triangles', tf: { tv: 3 } }));
        expect(trianglesOptions.trianglesConfig).toEqual({ traceSetVersion: 3 });
    });
});
