import { describe, it, expect } from 'vitest';
import {
    encodePayload,
    decodePayload,
    buildShareUrl,
    parseLocationHash,
    gameStateToPayload,
    hasShareableProgress,
    shareCfToComposableConfig,
    applyStyleConfigs,
    type SharePayload,
} from './share-link.js';
import type { GameState } from '../model/types.js';
import type { CutStyle } from '../game/cut-styles.js';
import { makeGameState } from '../test-helpers/fixtures.js';
import { CURRENT_TRACE_SET_VERSION } from '../puzzle/composable/traces/trace-set-version.js';
import { composePuzzle } from '../puzzle/composable/compose.js';
import { generateTopologyPuzzle } from '../puzzle/topology/generator.js';
import { classicTabTemplate } from '../puzzle/composable/tab-shapes.js';
import type { PieceDefinition } from '../puzzle/composable/types.js';
import { generateComposablePuzzle } from '../puzzle/composable-generator.js';
import { CASES } from '../test-helpers/generated-fill-cases.js';
import { SINE_AMPLITUDE_MAX, SINE_FREQUENCY_MAX } from '../ui/new-game-dialog.js';
import { PUZZLE_SIZE_OPTIONS } from '../game/puzzle-sizes.js';

describe('share-link codec — minimal round-trip', () => {
    it('round-trips a minimal starting payload (no attribution, no progress)', () => {
        const payload: SharePayload = {
            v: 1,
            i: 'https://images.unsplash.com/photo-123?w=1080',
            is: [1080, 720],
            g: [8, 6],
            c: 'classic',
            s: 12345,
            r: 'none',
        };
        const encoded = encodePayload(payload);
        const decoded = decodePayload(encoded);
        expect(decoded).toEqual(payload);
    });

    it('produces a URL-safe base64 string (no "+", "/", "=")', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: 'none',
        };
        const encoded = encodePayload(payload);
        expect(encoded).not.toMatch(/[+/=]/);
    });

    it('preserves the "blank" image sentinel verbatim', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [1080, 720], g: [4, 3], c: 'classic', s: 7, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.i).toBe('blank');
    });
});

describe('share-link codec — attribution scheme validation', () => {
    const base: SharePayload = {
        v: 1,
        i: 'https://images.unsplash.com/photo-123?w=1080',
        is: [1080, 720],
        g: [8, 6],
        c: 'classic',
        s: 12345,
        r: 'none',
    };

    it('round-trips a valid https attribution block', () => {
        const payload: SharePayload = {
            ...base,
            a: {
                n: 'Jane Doe',
                u: 'https://unsplash.com/@janedoe',
                p: 'https://unsplash.com/photos/abc',
            },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('rejects a link whose attribution URL uses the javascript: scheme', () => {
        const encoded = encodePayload({
            ...base,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            a: { n: 'x', u: 'javascript:alert(1)', p: 'https://unsplash.com/p' } as any,
        });
        expect(decodePayload(encoded)).toBeNull();
    });

    it('rejects a link whose photo URL uses a data: scheme', () => {
        const encoded = encodePayload({
            ...base,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            a: { n: 'x', u: 'https://unsplash.com/@x', p: 'data:text/html,<script>' } as any,
        });
        expect(decodePayload(encoded)).toBeNull();
    });

    it('rejects a malformed attribution block (missing / non-string fields)', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const encoded = encodePayload({ ...base, a: { u: 'https://a', p: 'https://b' } as any });
        expect(decodePayload(encoded)).toBeNull();
    });
});

describe('share-link codec — image URL scheme validation', () => {
    const base: SharePayload = {
        v: 1,
        i: 'https://images.unsplash.com/photo-123?w=1080',
        is: [1080, 720],
        g: [8, 6],
        c: 'classic',
        s: 12345,
        r: 'none',
    };

    const withImage = (i: string): SharePayload => ({ ...base, i });

    it.each([
        ['the blank sentinel', 'blank'],
        ['a legacy data: PNG', 'data:image/png;base64,iVBORw0KGgo='],
        ['the bundled image, relative', 'first-puzzle.jpg'],
        ['a root-relative URL', '/puzzle/first-puzzle.jpg'],
        ['an Unsplash https URL', 'https://images.unsplash.com/photo-1?w=1080'],
    ])('accepts %s', (_label, i) => {
        expect(decodePayload(encodePayload(withImage(i)))?.i).toBe(i);
    });

    it.each([
        ['javascript:', 'javascript:alert(1)'],
        ['vbscript:', 'vbscript:msgbox(1)'],
        ['file:', 'file:///etc/passwd'],
        ['a non-image data: URL', 'data:text/html,<script>alert(1)</script>'],
        ['blob:', 'blob:https://example.com/1234'],
    ])('rejects a link whose image URL uses %s', (_label, i) => {
        expect(decodePayload(encodePayload(withImage(i)))).toBeNull();
    });
});

describe('share-link codec — tf/clf block shape (#491)', () => {
    const base = {
        v: 1,
        i: 'blank',
        is: [1080, 720],
        g: [8, 6],
        s: 12345,
        r: 'none',
    };

    // A falsy non-object is the case the clamp can't reach (its guards are plain
    // truthiness), so before validation these survived decode type-lying.
    it.each([
        ['tf', 'triangles', null],
        ['tf', 'triangles', 0],
        ['clf', 'classic', null],
        ['clf', 'classic', 0],
    ])('rejects a falsy non-object %s on a %s link', (key, cutStyle, value) => {
        expect(decodePayload(encodeRaw({ ...base, c: cutStyle, [key]: value }))).toBeNull();
    });

    it.each([
        ['tf', 'triangles', 5],
        ['tf', 'triangles', 'x'],
        ['clf', 'classic', 5],
        ['clf', 'classic', 'x'],
    ])('rejects a truthy non-object %s on a %s link', (key, cutStyle, value) => {
        expect(decodePayload(encodeRaw({ ...base, c: cutStyle, [key]: value }))).toBeNull();
    });

    it('rejects a foreign block on an unrelated cut style, like ff/wf', () => {
        // Ungated by `c`, matching isValidBorderlessBlock's documented choice.
        expect(decodePayload(encodeRaw({ ...base, c: 'classic', tf: null }))).toBeNull();
    });

    it.each([
        ['an unusable tv', { tv: 'x' }],
        ['no tv', {}],
        ['an array', []],
    ])('normalizes a foreign block with %s rather than leaving it type-lying', (_label, tf) => {
        // The shape check is ungated but the clamp used to be gated on `c`, so a
        // triangles block on a classic link skipped normalization, decoding to a
        // type-lying `tf`. Both clamps now run ungated.
        const decoded = decodePayload(encodeRaw({ ...base, c: 'classic', tf }));
        expect(decoded).not.toBeNull();
        expect(decoded?.tf).toBeUndefined();
    });

    it('caps a foreign block carrying a valid tv instead of dropping it', () => {
        const decoded = decodePayload(encodeRaw({
            ...base, c: 'classic', tf: { tv: 9999 },
        }));
        expect(decoded?.tf).toEqual({ tv: CURRENT_TRACE_SET_VERSION });
    });

    it('still accepts a well-formed block', () => {
        const valid = decodePayload(encodeRaw({
            ...base, c: 'classic', clf: { tv: CURRENT_TRACE_SET_VERSION },
        }));
        expect(valid?.clf).toEqual({ tv: CURRENT_TRACE_SET_VERSION });
    });

    it('caps an above-current tv rather than rejecting the link', () => {
        const capped = decodePayload(encodeRaw({ ...base, c: 'classic', clf: { tv: 9999 } }));
        expect(capped?.clf).toEqual({ tv: CURRENT_TRACE_SET_VERSION });
    });

    it.each([
        ['a sub-1 tv', { tv: 0 }],
        ['a non-numeric tv', { tv: 'x' }],
        ['no tv at all', {}],
    ])('leaves %s to the clamp: block dropped, link survives', (_label, clf) => {
        // The object passes the shape check, so rejection is the clamp's call —
        // and the clamp drops the block and falls back to the legacy generator
        // rather than killing a link whose only fault is an unusable trace set.
        const decoded = decodePayload(encodeRaw({ ...base, c: 'classic', clf }));
        expect(decoded).not.toBeNull();
        expect(decoded?.clf).toBeUndefined();
    });
});

describe('share-link codec — grid-size clamp (crafted-link DoS guard)', () => {
    it('clamps an absurd crafted grid to the max dimension', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [1080, 720], g: [100000, 50000],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.g).toEqual([16, 16]);
    });

    it('floors fractional dims and raises non-positive dims to >= 1', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [10, 10], g: [15.9, 0],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.g).toEqual([15, 1]);
    });

    it('leaves a within-bounds grid untouched', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [10, 10], g: [16, 12],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.g).toEqual([16, 12]);
    });
});

describe('share-link codec — image-size clamp (crafted-link DoS guard)', () => {
    it('clamps an absurd crafted image size to the max dimension', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [1e9, 1e9], g: [4, 3],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.is).toEqual([8192, 8192]);
    });

    it('floors fractional dims and raises non-positive dims to >= 1', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [1080.9, 0], g: [4, 3],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.is).toEqual([1080, 1]);
    });

    it('raises a negative dim to >= 1', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [-500, 400], g: [4, 3],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.is).toEqual([1, 400]);
    });

    it('leaves a legitimate within-bounds image size untouched', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [1080, 720], g: [4, 3],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodePayload(payload))?.is).toEqual([1080, 720]);
    });

    it('rejects a payload whose image dim is non-finite', () => {
        // A non-finite can't survive JSON: stringify emits `null`, which
        // `isTuple2Number` rejects, so decodePayload returns null before the
        // clamp. Generation never sees a non-finite `is`; the clamp's own guard
        // is defense-in-depth for callers that bypass the codec.
        const bad = {
            v: 1, i: 'blank', is: [Infinity, 100], g: [4, 3],
            c: 'classic', s: 1, r: 'none',
        };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });
});

describe('share-link codec — sine-frequency/amplitude clamp (crafted-link DoS guard)', () => {
    it('clamps absurd crafted hf/vf to the max frequency', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: 0.2, hf: 1e9, va: 0.2, vf: 1e9 },
                tg: 'classic',
                tgc: {},
            },
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.cf?.bgc.hf).toBe(10);
        expect(decoded?.cf?.bgc.vf).toBe(10);
        // In-range amplitudes pass through untouched.
        expect(decoded?.cf?.bgc.ha).toBe(0.2);
        expect(decoded?.cf?.bgc.va).toBe(0.2);
    });

    it('clamps absurd crafted ha/va to the max amplitude', () => {
        // A huge amplitude inflates each sine segment's bbox enough to defeat
        // the Curve.intersect bbox pre-filter, re-inflating the O(segments²)
        // intersection cost the frequency cap otherwise contains.
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: 1e9, hf: 8, va: 1e9, vf: 6 },
                tg: 'classic',
                tgc: {},
            },
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.cf?.bgc.ha).toBe(0.5);
        expect(decoded?.cf?.bgc.va).toBe(0.5);
        // In-range frequencies pass through untouched.
        expect(decoded?.cf?.bgc.hf).toBe(8);
        expect(decoded?.cf?.bgc.vf).toBe(6);
    });

    it('leaves the wavy cut style’s ha/va = 0.5 (the UI ceiling) untouched', () => {
        // The wavy cut style (cut-style-strategies.ts) uses ha = va = 0.5, the
        // exact UI cap, so the clamp must pass it through unchanged.
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: 0.5, hf: 2, va: 0.5, vf: 1.5 },
                tg: 'classic',
                tgc: {},
            },
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.cf?.bgc.ha).toBe(0.5);
        expect(decoded?.cf?.bgc.va).toBe(0.5);
    });

    it('leaves within-bounds hf/vf untouched', () => {
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: 0.2, hf: 8, va: 0.2, vf: 6 },
                tg: 'classic',
                tgc: {},
            },
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.cf?.bgc.hf).toBe(8);
        expect(decoded?.cf?.bgc.vf).toBe(6);
    });

    it('clamps a legacy share link whose huge hf/vf translate onto the sine generator', () => {
        // Legacy { ha, hf, va, vf } payloads are rewritten to bg: 'sine' on
        // decode, so the clamp (which runs after translation) must cover them.
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 1, r: 'none',
            cf: { ha: 0.2, hf: 1e9, va: 0.2, vf: 1e9, dt: false },
        }));
        expect(decoded?.cf?.bg).toBe('sine');
        expect(decoded?.cf?.bgc.hf).toBe(10);
        expect(decoded?.cf?.bgc.vf).toBe(10);
    });

    it('leaves a non-sine base-cut generator config untouched', () => {
        // Only the sine generator reads hf/vf as a frequency; other generators
        // own their opaque bgc, so the clamp must not reach into it.
        const payload: SharePayload = {
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'venn',
                bgc: { ...VENN_CONFIG, hf: 500 },
                tg: 'none',
                tgc: {},
            },
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.cf?.bgc).toEqual({ ...VENN_CONFIG, hf: 500 });
    });

    it.each([
        ['a radius that swamps its center', { leftRadius: 1e22 }],
        ['a center far outside any image', { rightCenter: { x: 1e22, y: 200 } }],
        ['a quoted radius', { rightRadius: '150' }],
        ['a missing center', { leftCenter: undefined }],
    ])('rejects a venn link with %s', (_name, override) => {
        const payload = {
            v: 1, i: 'blank', is: [600, 400], g: [1, 1],
            c: 'composable', s: 1, r: 'none',
            cf: { bg: 'venn', bgc: { ...VENN_CONFIG, ...override }, tg: 'none', tgc: {} },
        };
        expect(decodePayload(encodeRaw(payload))).toBeNull();
    });

    it('does not raise a non-finite crafted hf/ha into a huge number', () => {
        // JSON.stringify turns Infinity/NaN into null, so a crafted non-finite
        // hf/ha decodes to null; the clamp drops it → generator default. The
        // DoS property is just that no billion-scale value survives.
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: Infinity, hf: Infinity, va: 0.2, vf: 6 },
                tg: 'classic',
                tgc: {},
            },
        }));
        expect(decoded?.cf?.bgc.hf).toBeUndefined();
        expect(decoded?.cf?.bgc.ha).toBeUndefined();
        expect(decoded?.cf?.bgc.vf).toBe(6);
        expect(decoded?.cf?.bgc.va).toBe(0.2);
    });
});

describe('share-link codec — optional fields', () => {
    it('round-trips attribution', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [2, 2], c: 'classic', s: 1, r: 'none',
            a: { n: 'Ada', u: 'https://u', p: 'https://p' },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips composable config', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: 0.2, hf: 1, va: 0.3, vf: 2 },
                tg: 'classic',
                tgc: {},
            },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips a triangular composable config', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'triangular',
                bgc: { jitter: 0.3 },
                tg: 'classic',
                tgc: {},
            },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips a triangular composable config with smooth enabled', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'composable', s: 1, r: 'none',
            cf: {
                bg: 'triangular',
                bgc: { jitter: 0.3, smooth: true },
                tg: 'classic',
                tgc: {},
            },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips fractal config with rotation', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [8, 6], c: 'fractal', s: 1, r: 'quarter-turn',
            ff: { bl: true },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips progress with merged groups only', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [3, 2], c: 'classic', s: 1, r: 'none',
            pr: { m: [[0, 1], [2, 3, 4]] },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips progress with rotation fidelity', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [3, 2], c: 'fractal', s: 1, r: 'quarter-turn',
            ff: { bl: false },
            pr: { m: [[0, 1]], mr: [2], sr: [3, 1, 4, 3] },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips classic config with quarter-turn rotation', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'classic', s: 1, r: 'quarter-turn',
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips composable config with quarter-turn rotation', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'composable', s: 1, r: 'quarter-turn',
            cf: {
                bg: 'sine',
                bgc: { ha: 0.2, hf: 1, va: 0.3, vf: 2 },
                tg: 'classic',
                tgc: {},
            },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });
});

describe('share-link: composable v2 cf shape', () => {
    it('round-trips the new {bg, bgc, tg, tgc} shape', () => {
        const payload: SharePayload = {
            v: 1,
            i: 'blank',
            is: [600, 400],
            g: [4, 3],
            c: 'composable',
            s: 12345,
            r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: 0.2, hf: 1.5, va: 0.2, vf: 1.5 },
                tg: 'classic',
                tgc: {},
            },
        } as SharePayload;
        const encoded = encodePayload(payload);
        const decoded = decodePayload(encoded);
        expect(decoded).toEqual(payload);
    });

    it('round-trips a venn base-cut generator end-to-end via gameStateToPayload', () => {
        // Venn diagrams are a non-sine base-cut generator; pin the codec's
        // ability to carry an arbitrary baseCutGenerator id + opaque config
        // through the gameState → payload → encode → decode chain.
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'venn',
                baseCutConfig: VENN_CONFIG,
                tabGenerator: 'none',
                tabConfig: {},
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.cf?.bg).toBe('venn');
        expect(decoded?.cf?.bgc).toEqual(VENN_CONFIG);
        expect(decoded?.cf?.tg).toBe('none');
    });

    it('round-trips minPieceArea (mpa) when the sender sets it', () => {
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.1, hf: 1, va: 0.1, vf: 1 },
                tabGenerator: 'classic',
                tabConfig: {},
                minPieceArea: 9,
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf?.mpa).toBe(9);
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.cf?.mpa).toBe(9);
    });

    it('omits mpa from the payload when the sender did not set minPieceArea', () => {
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: {},
                tabGenerator: 'classic',
                tabConfig: {},
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf).toBeDefined();
        expect(payload.cf?.mpa).toBeUndefined();
    });
});

describe('shareCfToComposableConfig', () => {
    it('round-trips a non-default minPieceArea end-to-end', () => {
        // Sender ships mpa=25; receiver must apply it, otherwise auto-grouping
        // behavior silently diverges (the default 4 absorbs only sub-pixel
        // numerical noise, while 25 absorbs visible slivers).
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.1, hf: 1, va: 0.1, vf: 1 },
                tabGenerator: 'classic',
                tabConfig: {},
                minPieceArea: 25,
            },
        });
        const encoded = encodePayload(gameStateToPayload(state, { includeProgress: false }));
        const decoded = decodePayload(encoded);
        expect(decoded?.cf).toBeDefined();
        const projected = shareCfToComposableConfig(decoded!.cf!);
        expect(projected.minPieceArea).toBe(25);
        expect(projected.baseCutGenerator).toBe('sine');
        expect(projected.tabGenerator).toBe('classic');
    });

    it('omits minPieceArea on the projected config when the sender did not set it', () => {
        // Receivers should fall back to the generator's own default, not a
        // sentinel value, when `mpa` is absent from the wire payload.
        const cf: NonNullable<SharePayload['cf']> = {
            bg: 'sine',
            bgc: { ha: 0.1, hf: 1, va: 0.1, vf: 1 },
            tg: 'classic',
            tgc: {},
        };
        const projected = shareCfToComposableConfig(cf);
        expect(projected.minPieceArea).toBeUndefined();
    });

    it('passes baseCutConfig and tabConfig through opaquely', () => {
        const cf: NonNullable<SharePayload['cf']> = {
            bg: 'venn',
            bgc: { sets: 3, separation: 0.4 },
            tg: 'none',
            tgc: { customKey: 'value' },
            mpa: 9,
        };
        const projected = shareCfToComposableConfig(cf);
        expect(projected.baseCutGenerator).toBe('venn');
        expect(projected.baseCutConfig).toEqual({ sets: 3, separation: 0.4 });
        expect(projected.tabGenerator).toBe('none');
        expect(projected.tabConfig).toEqual({ customKey: 'value' });
        expect(projected.minPieceArea).toBe(9);
    });
});

describe('share-link: legacy composable cf shape', () => {
    it('decodes a legacy {ha, hf, va, vf, dt} payload as the new shape', () => {
        const legacy = {
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 12345, r: 'none',
            cf: { ha: 0.2, hf: 1.5, va: 0.2, vf: 1.5, dt: false },
        };
        const encoded = encodePayload(legacy as unknown as SharePayload);
        const decoded = decodePayload(encoded);
        expect(decoded).not.toBeNull();
        expect(decoded!.cf).toEqual({
            bg: 'sine',
            bgc: { ha: 0.2, hf: 1.5, va: 0.2, vf: 1.5 },
            tg: 'classic',
            tgc: {},
        });
    });

    it('decodes a legacy payload with dt=true as tg="none"', () => {
        const legacy = {
            v: 1, i: 'blank', is: [600, 400], g: [4, 3],
            c: 'composable', s: 12345, r: 'none',
            cf: { ha: 0.2, hf: 1.5, va: 0.2, vf: 1.5, dt: true },
        };
        const encoded = encodePayload(legacy as unknown as SharePayload);
        const decoded = decodePayload(encoded);
        expect(decoded!.cf!.tg).toBe('none');
    });
});

describe('share-link: legacy → working puzzle smoke test', () => {
    // Same 16×12 sine + classic-tab pipeline as repro-bug.test.ts —
    // runs at ~3.5s locally but can exceed vitest's 5s default on slower
    // CI runners. See repro-bug.test.ts for context.
    it('a legacy-shape link decodes and produces a non-empty piece array', () => {
        const legacy = {
            v: 1, i: 'blank', is: [1080, 720], g: [16, 12],
            c: 'composable', s: 124741785, r: 'none',
            cf: { ha: 0.13, hf: 7.1, va: 0.08, vf: 6.9, dt: false },
        };
        const encoded = encodePayload(legacy as unknown as SharePayload);
        const decoded = decodePayload(encoded)!;

        const { pieces } = generateComposablePuzzle(
            decoded.g[0], decoded.g[1],
            { width: decoded.is[0], height: decoded.is[1] },
            decoded.s,
            {
                baseCutGenerator: decoded.cf!.bg,
                baseCutConfig: decoded.cf!.bgc,
                tabGenerator: decoded.cf!.tg,
                tabConfig: decoded.cf!.tgc,
            },
        );

        expect(pieces.length).toBeGreaterThan(0);
        // We don't assert exactly 192 — old links won't necessarily
        // produce the same puzzle. We just assert "produces a puzzle."
    }, 15000);
});

describe('share-link codec — rejection paths', () => {
    it('rejects unsupported schema version', () => {
        const bad = { v: 2, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: 'none' };
        const encoded = encodeRaw(bad);
        expect(decodePayload(encoded)).toBeNull();
    });

    it('rejects malformed base64', () => {
        expect(decodePayload('!!!not base64!!!')).toBeNull();
    });

    it('rejects JSON whose shape is wrong', () => {
        const encoded = encodeRaw({ hello: 'world' });
        expect(decodePayload(encoded)).toBeNull();
    });

    it('rejects invalid cut style', () => {
        const bad = { v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'bogus', s: 0, r: 'none' };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });

    it('rejects invalid rotation mode', () => {
        const bad = { v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: 'quarter turn' };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });

    it('rejects a non-string cut style that stringifies to a known one', () => {
        // `hasOwnProperty` coerces its key, so `['classic']` would pass
        // membership without the predicate's `typeof` check, then read as an
        // unknown style downstream.
        const bad = { v: 1, i: 'x', is: [1, 1], g: [2, 2], c: ['classic'], s: 0, r: 'none' };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });

    it('rejects a non-string rotation mode that stringifies to a known one', () => {
        const bad = { v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: ['none'] };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });

    it('throws when tuple values are non-finite', () => {
        const bad: SharePayload = {
            v: 1, i: 'x', is: [NaN, 1], g: [2, 2], c: 'classic', s: 0, r: 'none',
        };
        expect(() => encodePayload(bad)).toThrow(/finite/i);
    });

    it('throws when seed is non-finite', () => {
        const bad: SharePayload = {
            v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: Infinity, r: 'none',
        };
        expect(() => encodePayload(bad)).toThrow(/finite/i);
    });

    // Without these guards a crafted link that passes the surface schema but
    // feeds bad data through `applyProgress` would throw (or write garbage into
    // `group.rotation`). These pin the rejection contract.
    const baseValid = {
        v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: 'none',
    };

    it('rejects pr that is not an object', () => {
        expect(decodePayload(encodeRaw({ ...baseValid, pr: 'oops' }))).toBeNull();
    });

    it('rejects pr.m that is not an array', () => {
        expect(decodePayload(encodeRaw({ ...baseValid, pr: { m: 'oops' } }))).toBeNull();
    });

    it('rejects pr.m entries that are not arrays', () => {
        expect(decodePayload(encodeRaw({ ...baseValid, pr: { m: [42] } }))).toBeNull();
    });

    it('rejects pr.m piece IDs that are not integers', () => {
        expect(decodePayload(encodeRaw({ ...baseValid, pr: { m: [[0, 1.5]] } }))).toBeNull();
        expect(decodePayload(encodeRaw({ ...baseValid, pr: { m: [['a']] } }))).toBeNull();
    });

    it('rejects pr.mr that is not an array', () => {
        expect(decodePayload(encodeRaw({
            ...baseValid, pr: { m: [[0, 1]], mr: 'oops' },
        }))).toBeNull();
    });

    it('rejects pr.mr that contains a non-finite number', () => {
        expect(decodePayload(encodeRaw({
            ...baseValid, pr: { m: [[0, 1]], mr: [null] },
        }))).toBeNull();
    });

    it('rejects pr.sr with odd length', () => {
        expect(decodePayload(encodeRaw({
            ...baseValid, pr: { m: [[0, 1]], sr: [2, 90, 3] },
        }))).toBeNull();
    });

    it('rejects pr.sr that contains a non-finite number', () => {
        expect(decodePayload(encodeRaw({
            ...baseValid, pr: { m: [[0, 1]], sr: [2, 'oops'] },
        }))).toBeNull();
    });

    it('rejects pr.sr piece IDs that are not integers', () => {
        // Even-indexed entries are piece IDs and must be integers, matching
        // the pr.m guard. Odd indices are rotation values (any finite number).
        expect(decodePayload(encodeRaw({
            ...baseValid, pr: { m: [[0, 1]], sr: [2.5, 90] },
        }))).toBeNull();
    });

    // A crafted composable payload with a generator id we don't know
    // would otherwise survive surface validation and throw inside
    // generateTopologyPuzzle. Reject at the gate instead.
    const baseComposable = {
        v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'composable', s: 0, r: 'none',
    };

    it('rejects cf.tg that is not a registered TabGenerator id', () => {
        expect(decodePayload(encodeRaw({
            ...baseComposable,
            cf: { bg: 'sine', bgc: {}, tg: 'bogus', tgc: {} },
        }))).toBeNull();
    });

    it('rejects cf.bg that is not a registered BaseCutGenerator id', () => {
        expect(decodePayload(encodeRaw({
            ...baseComposable,
            cf: { bg: 'bogus', bgc: {}, tg: 'classic', tgc: {} },
        }))).toBeNull();
    });
});

describe('buildShareUrl', () => {
    it('appends "#p=<encoded>" to a bare URL', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: 'none',
        };
        const url = buildShareUrl('https://example.com/puzzle/', payload);
        expect(url.startsWith('https://example.com/puzzle/#p=')).toBe(true);
    });

    it('strips an existing hash before appending', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: 'none',
        };
        const url = buildShareUrl('https://example.com/puzzle/#stale', payload);
        expect(url.includes('#stale')).toBe(false);
        expect(url.includes('#p=')).toBe(true);
    });

    it("drops the sharer's query params so ?userid= or ?tabDebug= never reach the recipient", () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 0, r: 'none',
        };
        const url = buildShareUrl('https://example.com/puzzle/?userid=adrian&tabDebug=1#stale', payload);
        expect(url.startsWith('https://example.com/puzzle/#p=')).toBe(true);
    });
});

describe('parseLocationHash', () => {
    it('returns null for empty hash', () => {
        expect(parseLocationHash('')).toBeNull();
    });

    it('returns null for unrelated hash', () => {
        expect(parseLocationHash('#section')).toBeNull();
    });

    it('returns the payload when the hash is a valid share link', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'classic', s: 42, r: 'none',
        };
        const hash = '#p=' + encodePayload(payload);
        expect(parseLocationHash(hash)).toEqual(payload);
    });

    it('returns null for #p= with malformed body', () => {
        expect(parseLocationHash('#p=!!!')).toBeNull();
    });
});

// Helper that mirrors encodePayload without shape-validation, so we can
// craft malformed-but-well-encoded payloads for rejection tests.
const VENN_CONFIG = { leftCenter: { x: 200, y: 200 }, leftRadius: 150, rightCenter: { x: 400, y: 200 }, rightRadius: 150 };

function encodeRaw(obj: unknown): string {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildState(partial: Partial<GameState>): GameState {
    return makeGameState({
        imageUrl: null,
        imageSize: { width: 1080, height: 720 },
        gridSize: { cols: 4, rows: 3 },
        seed: 42,
        cutStyle: 'classic',
        rotationMode: 'none',
        ...partial,
    });
}

describe('gameStateToPayload', () => {
    it('maps a starting classic puzzle to a minimal payload', () => {
        const state = buildState({});
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload).toEqual({
            v: 1, i: 'blank', is: [1080, 720], g: [4, 3],
            c: 'classic', s: 42, r: 'none',
        });
    });

    it('emits a real image URL verbatim', () => {
        // The other half of `i: state.imageUrl ?? 'blank'`. Without this,
        // hardcoding `i: 'blank'` passes the whole suite while turning every
        // photo puzzle's share link into a blank one for the recipient.
        const url = 'https://images.unsplash.com/photo-1?w=1080';
        const payload = gameStateToPayload(buildState({ imageUrl: url }), {
            includeProgress: false,
        });
        expect(payload.i).toBe(url);
    });

    it('emits the blank sentinel for a puzzle with no image', () => {
        const payload = gameStateToPayload(buildState({ imageUrl: null }), {
            includeProgress: false,
        });
        expect(payload.i).toBe('blank');
    });

    it('includes attribution when present', () => {
        const state = buildState({
            attribution: {
                photographerName: 'Ada',
                photographerUrl: 'https://u',
                photoUrl: 'https://p',
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.a).toEqual({ n: 'Ada', u: 'https://u', p: 'https://p' });
    });

    it('includes fractalConfig with rotation mode', () => {
        const state = buildState({
            cutStyle: 'fractal',
            rotationMode: 'quarter-turn',
            fractalConfig: { borderless: true },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.c).toBe('fractal');
        expect(payload.r).toBe('quarter-turn');
        expect(payload.ff).toEqual({ bl: true });
    });

    it('emits r: quarter-turn for a rotated classic puzzle', () => {
        const state = buildState({
            cutStyle: 'classic',
            rotationMode: 'quarter-turn',
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.c).toBe('classic');
        expect(payload.r).toBe('quarter-turn');
        expect(payload.ff).toBeUndefined();
    });

    it('includes composableConfig', () => {
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.2, hf: 1, va: 0.3, vf: 2 },
                tabGenerator: 'classic',
                tabConfig: {},
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf).toEqual({
            bg: 'sine',
            bgc: { ha: 0.2, hf: 1, va: 0.3, vf: 2 },
            tg: 'classic',
            tgc: {},
        });
    });

    it('omits progress when includeProgress is false', () => {
        const state = buildState({
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.pr).toBeUndefined();
    });

    it('captures merged-group piece IDs when includeProgress is true', () => {
        const state = buildState({
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        expect(payload.pr?.m).toEqual([[0, 1]]);
        expect(payload.pr?.mr).toBeUndefined();
        expect(payload.pr?.sr).toBeUndefined();
    });

    it('sorts merged groups deterministically by smallest piece ID', () => {
        const state = buildState({
            groups: [
                { id: 7, pieces: new Map([[5, { x: 0, y: 0 }], [6, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 3, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 9, pieces: new Map([[2, { x: 0, y: 0 }], [3, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        expect(payload.pr?.m).toEqual([[0, 1], [2, 3], [5, 6]]);
    });

    it('mr parallels the sorted m array, not the original group order', () => {
        const state = buildState({
            rotationMode: 'quarter-turn',
            groups: [
                { id: 7, pieces: new Map([[5, { x: 0, y: 0 }], [6, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 270 },
                { id: 3, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 90 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        expect(payload.pr?.m).toEqual([[0, 1], [5, 6]]);
        expect(payload.pr?.mr).toEqual([1, 3]);
    });

    it('fills composable defaults from generator when sub-fields are undefined', () => {
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {},
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf).toEqual({
            bg: 'sine',
            bgc: {},
            tg: 'classic',
            tgc: {},
        });
    });

    it('captures rotation fidelity in quarter-turn mode', () => {
        const state = buildState({
            rotationMode: 'quarter-turn',
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 180 },
                { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 90 },
                { id: 3, pieces: new Map([[3, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        expect(payload.pr?.m).toEqual([[0, 1]]);
        expect(payload.pr?.mr).toEqual([2]);
        // Solo rotations: only non-zero ones are encoded.
        expect(payload.pr?.sr).toEqual([2, 1]);
    });
});

describe('free-mode rotation encoding', () => {
    it('encodes free-mode merged-group rotations as integer 0..359 in mr', () => {
        const state = buildState({
            rotationMode: 'free',
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 47.3 },
                { id: 2, pieces: new Map([[2, { x: 0, y: 0 }], [3, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 312.8 },
                { id: 4, pieces: new Map([[4, { x: 0, y: 0 }], [5, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        expect(payload.r).toBe('free');
        expect(payload.pr?.mr).toEqual([47, 313, 0]);
    });

    it('wraps 360 to 0 when float rounds up to 360', () => {
        const state = buildState({
            rotationMode: 'free',
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 359.6 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        expect(payload.pr?.mr).toEqual([0]);
    });

    it('encodes free-mode solo-piece rotations as integer 0..359 in sr, omitting zeros', () => {
        const state = buildState({
            rotationMode: 'free',
            groups: [
                // One merged group (needed to trigger extractProgress)
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 123.4 },
                { id: 3, pieces: new Map([[3, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 4, pieces: new Map([[4, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 271.6 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        // Piece 3 is at 0° — should be omitted.
        expect(payload.pr?.sr).toEqual([2, 123, 4, 272]);
    });

    it('round-trips free-mode merged-group rotations within 0.5°', () => {
        const originalDegrees = [47, 180, 312];
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'classic', s: 1, r: 'free',
            pr: { m: [[0, 1], [2, 3], [4, 5]], mr: originalDegrees },
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.pr?.mr).toEqual(originalDegrees);
    });

    it('round-trips free-mode sr pairs within 0.5°', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'classic', s: 1, r: 'free',
            pr: { m: [[0, 1]], sr: [2, 47, 3, 312] },
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.pr?.sr).toEqual([2, 47, 3, 312]);
    });

    it('does not affect quarter-turn encoding (mr carries 0..3)', () => {
        const state = buildState({
            rotationMode: 'quarter-turn',
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 270 },
            ],
        });
        const payload = gameStateToPayload(state, { includeProgress: true });
        expect(payload.r).toBe('quarter-turn');
        expect(payload.pr?.mr).toEqual([3]);
    });
});

describe('hasShareableProgress', () => {
    it('is false when the puzzle has no merged groups', () => {
        const state = buildState({
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        expect(hasShareableProgress(state)).toBe(false);
    });

    it('is false when the puzzle is complete', () => {
        const state = buildState({
            completed: true,
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        expect(hasShareableProgress(state)).toBe(false);
    });

    it('is true when there is at least one multi-piece group and the puzzle is in progress', () => {
        const state = buildState({
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        expect(hasShareableProgress(state)).toBe(true);
    });
});

// Regression test for #285: every consumer that resolves an undefined
// `disableTabs` must produce the same value, otherwise sharing/loading
// drifts the flag silently.
describe('disableTabs default agreement (#285)', () => {
    function seededRandom(seed: number): () => number {
        let s = seed;
        return () => {
            s = (s * 1664525 + 1013904223) & 0x7fffffff;
            return s / 0x7fffffff;
        };
    }

    it('share-link encodes an undefined tabGenerator as the canonical default', () => {
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.1, hf: 1, va: 0.1, vf: 1 },
                // tabGenerator intentionally left undefined — receiver should
                // fall back to the canonical default of 'classic' (tabs on).
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf?.tg).toBe('classic');
    });

    it('topology generator treats undefined tabGeneratorId identically to the canonical default', () => {
        const args = {
            cols: 3, rows: 3,
            imageSize: { width: 90, height: 90 },
            shared: {
                baseCutGeneratorId: 'sine' as const,
                baseCutConfig: { ha: 0.1, hf: 1, va: 0.1, vf: 1 },
            },
        };
        const fromUndefined = generateTopologyPuzzle(
            args.cols, args.rows, args.imageSize, seededRandom(42),
            { ...args.shared },
        );
        const fromExplicit = generateTopologyPuzzle(
            args.cols, args.rows, args.imageSize, seededRandom(42),
            // The canonical default is tabs-enabled → tabGeneratorId 'classic'.
            { ...args.shared, tabGeneratorId: 'classic' },
        );
        expect(fromUndefined.pieces.map((p) => p.shape))
            .toEqual(fromExplicit.pieces.map((p) => p.shape));
    });

    it('compose treats undefined disableTabs identically to the canonical default', () => {
        const pieceDefs: PieceDefinition[] = [
            {
                id: 0,
                imageOffset: { x: 0, y: 0 },
                edges: [
                    { id: 0, start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
                      mateEdgeId: -1, matePieceId: -1 },
                    { id: 1, start: { x: 10, y: 0 }, end: { x: 10, y: 10 },
                      mateEdgeId: 4, matePieceId: 1, sharedEdgeKey: 'a', isFirstSide: true },
                    { id: 2, start: { x: 10, y: 10 }, end: { x: 0, y: 10 },
                      mateEdgeId: -1, matePieceId: -1 },
                    { id: 3, start: { x: 0, y: 10 }, end: { x: 0, y: 0 },
                      mateEdgeId: -1, matePieceId: -1 },
                ],
            },
            {
                id: 1,
                imageOffset: { x: 10, y: 0 },
                edges: [
                    { id: 4, start: { x: 0, y: 0 }, end: { x: 0, y: 10 },
                      mateEdgeId: 1, matePieceId: 0, sharedEdgeKey: 'a', isFirstSide: false },
                    { id: 5, start: { x: 0, y: 10 }, end: { x: 10, y: 10 },
                      mateEdgeId: -1, matePieceId: -1 },
                    { id: 6, start: { x: 10, y: 10 }, end: { x: 10, y: 0 },
                      mateEdgeId: -1, matePieceId: -1 },
                    { id: 7, start: { x: 10, y: 0 }, end: { x: 0, y: 0 },
                      mateEdgeId: -1, matePieceId: -1 },
                ],
            },
        ];
        const fromUndefined = composePuzzle(
            pieceDefs, classicTabTemplate, seededRandom(42),
        );
        const fromExplicit = composePuzzle(
            pieceDefs, classicTabTemplate, seededRandom(42),
            { disableTabs: false },
        );
        expect(fromUndefined.map((p) => p.shape))
            .toEqual(fromExplicit.map((p) => p.shape));
    });
});

describe('share-link tg = "traced"', () => {
    it('round-trips an encoded payload with tg: "traced"', () => {
        const payload: SharePayload = {
            v: 1,
            i: 'blank',
            is: [800, 600],
            g: [4, 3],
            c: 'composable',
            s: 12345,
            r: 'none',
            cf: {
                bg: 'sine',
                bgc: { ha: 0.15, hf: 1.5, va: 0.15, vf: 1.5 },
                tg: 'traced',
                tgc: {},
            },
        };
        const encoded = encodePayload(payload);
        const decoded = decodePayload(encoded);
        expect(decoded).toEqual(payload);
    });

    it('decodes legacy "dt: true" (no tg) as tg: "none"', () => {
        // translateLegacyComposable in share-link.ts should map dt → tg.
        const legacyJson = JSON.stringify({
            v: 1, i: 'blank', is: [800, 600], g: [4, 3], c: 'composable',
            s: 1, r: 'none',
            cf: { ha: 0.1, hf: 1, va: 0.1, vf: 1, dt: true },
        });
        const encoded = encodeRaw(JSON.parse(legacyJson));
        const decoded = decodePayload(encoded);
        expect(decoded?.cf?.tg).toBe('none');
    });
});

describe('share-link: composable borderless (bl)', () => {
    it('round-trips composable config with borderless: true', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'composable', s: 1, r: 'none',
            cf: { bg: 'sine', bgc: { ha: 0.2, hf: 1, va: 0.3, vf: 2 }, tg: 'classic', tgc: {}, bl: true },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('shareCfToComposableConfig maps bl: true to borderless: true', () => {
        const cf: NonNullable<SharePayload['cf']> = {
            bg: 'sine',
            bgc: { ha: 0.2, hf: 1, va: 0.3, vf: 2 },
            tg: 'classic',
            tgc: {},
            bl: true,
        };
        expect(shareCfToComposableConfig(cf).borderless).toBe(true);
    });

    it('shareCfToComposableConfig omits borderless when bl is absent', () => {
        const cf: NonNullable<SharePayload['cf']> = {
            bg: 'sine',
            bgc: {},
            tg: 'classic',
            tgc: {},
        };
        expect(shareCfToComposableConfig(cf).borderless).toBeUndefined();
    });

    it('gameStateToPayload encodes composableConfig.borderless as cf.bl', () => {
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.2, hf: 1, va: 0.3, vf: 2 },
                tabGenerator: 'classic',
                tabConfig: {},
                borderless: true,
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf?.bl).toBe(true);
    });

    it('gameStateToPayload omits cf.bl when borderless is not set', () => {
        const state = buildState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: {},
                tabGenerator: 'classic',
                tabConfig: {},
            },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf?.bl).toBeUndefined();
    });

    it('isValidComposableCf rejects cf.bl that is not a boolean', () => {
        const bad = {
            v: 1, i: 'x', is: [1, 1], g: [2, 2], c: 'composable', s: 0, r: 'none',
            cf: { bg: 'sine', bgc: {}, tg: 'classic', tgc: {}, bl: 'yes' },
        };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });
});

describe('share-link: wavy and fractal borderless (wf/ff)', () => {
    it('round-trips a wavy borderless payload (wf)', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'wavy', s: 7, r: 'none',
            wf: { bl: true },
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('gameStateToPayload emits wf for a borderless wavy state', () => {
        const state = makeGameState({
            cutStyle: 'wavy',
            seed: 7,
            wavyConfig: { borderless: true },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.wf).toEqual({ bl: true });
    });

    it('gameStateToPayload omits wf for a non-wavy state', () => {
        const state = makeGameState({ cutStyle: 'classic', seed: 7 });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.wf).toBeUndefined();
    });

    it.each([
        ['a string', 'yes'],
        ['a number', 1],
        ['an object', {}],
        ['null', null],
        ['missing', undefined],
    ])('rejects wf.bl that is %s', (_label, bl) => {
        // `bl` is typed boolean but flowed to GameState unchecked, so a crafted
        // link could park text in `wavyConfig.borderless` — ignored by the
        // generator's `=== true` read but carried verbatim into the repro block,
        // a re-share, and the piece-count-mismatch event. `cf.bl` has always
        // been checked; this closes the same hole. The `missing` row is
        // deliberate: `bl` is REQUIRED here (see `isValidBorderlessBlock`).
        const bad = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'wavy', s: 7, r: 'none',
            wf: { bl },
        };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });

    it('rejects a wf that is not an object', () => {
        const bad = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'wavy', s: 7, r: 'none',
            wf: 'borderless',
        };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });

    it('rejects ff.bl that is not a boolean', () => {
        // Fractal's block is the same shape and reached GameState the same
        // unchecked way.
        const bad = {
            v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'fractal', s: 7, r: 'none',
            ff: { bl: 'yes' },
        };
        expect(decodePayload(encodeRaw(bad))).toBeNull();
    });

    it.each([
        ['wavy', 'wavyConfig', 'wf'],
        ['fractal', 'fractalConfig', 'ff'],
    ] as const)(
        'encodes a non-boolean %s borderless as false rather than emitting an undecodable link',
        (cutStyle, configKey, block) => {
            // The encoder/decoder must agree. A state restored from a pre-tightening
            // build can carry a crafted `bl: 'yes'`, and a `?? false` encoder would
            // hand it back to the wire for `isValidBorderlessBlock` to reject — a
            // link nobody can open. `=== true` is also faithful: every generator
            // treats non-`true` as off, so `false` is what this state generated.
            const state = makeGameState({
                cutStyle,
                seed: 7,
                [configKey]: { borderless: 'yes' },
            } as unknown as Partial<GameState>);

            const payload = gameStateToPayload(state, { includeProgress: false });

            expect(payload[block]).toEqual({ bl: false });
            expect(decodePayload(encodePayload(payload))).toEqual(payload);
        },
    );

    it('encodes a non-boolean composable borderless as false rather than emitting an undecodable link', () => {
        // The third arm of the same tightening (separate from the it.each only
        // because `cf` has four more required fields). `isValidComposableCf` has
        // always required a boolean `bl`, so a `?? false` encoder would emit an
        // undecodable `cf`.
        const state = makeGameState({
            cutStyle: 'composable',
            seed: 7,
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: {},
                tabGenerator: 'classic',
                tabConfig: {},
                borderless: 'yes',
            },
        } as unknown as Partial<GameState>);

        const payload = gameStateToPayload(state, { includeProgress: false });

        expect(payload.cf?.bl).toBe(false);
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('still accepts every wf/ff shape this app emits', () => {
        // `applyStyleConfigs` writes a boolean `bl` on both paths, so the
        // tightening above cannot reject a legitimately produced link.
        for (const bl of [true, false]) {
            const wavy: SharePayload = {
                v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'wavy', s: 7, r: 'none',
                wf: { bl },
            };
            expect(decodePayload(encodePayload(wavy))).toEqual(wavy);

            const wavyTraced: SharePayload = { ...wavy, wf: { bl, tv: 1 } };
            expect(decodePayload(encodePayload(wavyTraced))).toEqual(wavyTraced);

            const fractal: SharePayload = {
                v: 1, i: 'x', is: [100, 100], g: [4, 3], c: 'fractal', s: 7, r: 'none',
                ff: { bl },
            };
            expect(decodePayload(encodePayload(fractal))).toEqual(fractal);
        }
    });
});

describe('share-link codec — wavy', () => {
    it('round-trips a wavy payload with no cf', () => {
        const payload: SharePayload = {
            v: 1,
            i: 'x',
            is: [1080, 720],
            g: [6, 4],
            c: 'wavy',
            s: 42,
            r: 'none',
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('round-trips a wavy payload with free rotation', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1080, 720], g: [8, 6],
            c: 'wavy', s: 7, r: 'free',
        };
        expect(decodePayload(encodePayload(payload))).toEqual(payload);
    });

    it('gameStateToPayload emits no cf for a wavy state', () => {
        // Wavy's config is derived from gridSize; cf is composable-only.
        const state = makeGameState({
            seed: 7,
            cutStyle: 'wavy',
            rotationMode: 'none',
            gridSize: { cols: 6, rows: 4 },
        });
        const payload = gameStateToPayload(state, { includeProgress: false });
        expect(payload.cf).toBeUndefined();
        expect(payload.c).toBe('wavy');
    });
});

describe('share-link wavy traceSetVersion (wf.tv)', () => {
    function wavyState(traceSetVersion?: number): GameState {
        return buildState({
            cutStyle: 'wavy',
            wavyConfig: traceSetVersion === undefined
                ? { borderless: false }
                : { borderless: false, traceSetVersion },
        });
    }

    it('encodes wf.tv when the wavy config carries a trace-set version', () => {
        const payload = gameStateToPayload(wavyState(1), { includeProgress: false });
        expect(payload.wf).toEqual({ bl: false, tv: 1 });
    });

    it('omits wf.tv for a legacy wavy puzzle (classic tabs)', () => {
        const payload = gameStateToPayload(wavyState(undefined), { includeProgress: false });
        expect(payload.wf).toEqual({ bl: false });
    });

    it('round-trips wf.tv through encode/decode', () => {
        const payload = gameStateToPayload(wavyState(1), { includeProgress: false });
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded!.wf).toEqual({ bl: false, tv: 1 });
    });

    it('leaves a legacy wavy link (no tv) without a version', () => {
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'wavy', s: 1, r: 'none',
            wf: { bl: false },
        }));
        expect(decoded!.wf!.tv).toBeUndefined();
    });

    it('clamps a future tv down to the newest known version', () => {
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'wavy', s: 1, r: 'none',
            wf: { bl: false, tv: 999 },
        }));
        expect(decoded!.wf!.tv).toBe(CURRENT_TRACE_SET_VERSION);
    });

    it('drops a non-positive or non-number tv (reproduces as classic)', () => {
        for (const bad of [0, -3, 'x', null] as unknown[]) {
            const decoded = decodePayload(encodeRaw({
                v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'wavy', s: 1, r: 'none',
                wf: { bl: false, tv: bad },
            }));
            expect(decoded!.wf!.tv).toBeUndefined();
        }
    });
});

describe('share-link triangles traceSetVersion (tf)', () => {
    function trianglesState(traceSetVersion?: number): GameState {
        return buildState({
            cutStyle: 'triangles',
            trianglesConfig: traceSetVersion === undefined ? {} : { traceSetVersion },
        });
    }

    it('encodes tf.tv from the triangles config', () => {
        const payload = gameStateToPayload(trianglesState(1), { includeProgress: false });
        expect(payload.c).toBe('triangles');
        expect(payload.tf).toEqual({ tv: 1 });
    });

    it('omits tf when the config carries no version', () => {
        const payload = gameStateToPayload(trianglesState(undefined), { includeProgress: false });
        expect(payload.tf).toBeUndefined();
    });

    it('round-trips tf.tv through encode/decode', () => {
        const payload = gameStateToPayload(trianglesState(1), { includeProgress: false });
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded!.c).toBe('triangles');
        expect(decoded!.tf).toEqual({ tv: 1 });
    });

    it('accepts a triangles payload without tf', () => {
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'triangles', s: 1, r: 'none',
        }));
        expect(decoded).not.toBeNull();
        expect(decoded!.tf).toBeUndefined();
    });

    it('clamps a future tv down to the newest known version', () => {
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'triangles', s: 1, r: 'none',
            tf: { tv: 999 },
        }));
        expect(decoded!.tf!.tv).toBe(CURRENT_TRACE_SET_VERSION);
    });

    it('drops the tf block entirely on an invalid tv', () => {
        for (const bad of [0, -3, 'x', null] as unknown[]) {
            const decoded = decodePayload(encodeRaw({
                v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'triangles', s: 1, r: 'none',
                tf: { tv: bad },
            }));
            expect(decoded).not.toBeNull();
            expect(decoded!.tf).toBeUndefined();
        }
    });

    it('round-trips a triangles payload with free rotation', () => {
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'triangles', s: 7, r: 'free',
            tf: { tv: 1 },
        }));
        expect(decoded!.r).toBe('free');
    });
});

describe('share-link classic traceSetVersion (clf)', () => {
    function classicState(traceSetVersion?: number): GameState {
        return buildState({
            cutStyle: 'classic',
            classicConfig: traceSetVersion === undefined ? {} : { traceSetVersion },
        });
    }

    it('encodes clf.tv from the classic config', () => {
        const payload = gameStateToPayload(classicState(1), { includeProgress: false });
        expect(payload.c).toBe('classic');
        expect(payload.clf).toEqual({ tv: 1 });
    });

    it('omits clf for a legacy classic puzzle', () => {
        const payload = gameStateToPayload(classicState(undefined), { includeProgress: false });
        expect(payload.clf).toBeUndefined();
    });

    it('round-trips clf.tv through encode/decode', () => {
        const payload = gameStateToPayload(classicState(1), { includeProgress: false });
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded!.c).toBe('classic');
        expect(decoded!.clf).toEqual({ tv: 1 });
    });

    it('accepts a legacy classic payload without clf', () => {
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'classic', s: 1, r: 'none',
        }));
        expect(decoded).not.toBeNull();
        expect(decoded!.clf).toBeUndefined();
    });

    it('clamps a future tv down to the newest known version', () => {
        const decoded = decodePayload(encodeRaw({
            v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'classic', s: 1, r: 'free',
            clf: { tv: 999 },
        }));
        expect(decoded!.clf!.tv).toBe(CURRENT_TRACE_SET_VERSION);
    });

    it('drops the clf block entirely on an invalid tv (→ legacy generator)', () => {
        for (const bad of [0, -3, 'x', null] as unknown[]) {
            const decoded = decodePayload(encodeRaw({
                v: 1, i: 'blank', is: [1080, 720], g: [8, 6], c: 'classic', s: 1, r: 'free',
                clf: { tv: bad },
            }));
            expect(decoded).not.toBeNull();
            expect(decoded!.clf).toBeUndefined();
        }
    });
});

describe('share-link background color (bgc)', () => {
    it('round-trips a payload with bgc', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1080, 722], g: [8, 6],
            c: 'classic', s: 42, r: 'none',
            bgc: 'indigo-darker',
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded?.bgc).toBe('indigo-darker');
    });

    it('tolerates an absent bgc (pre-feature links)', () => {
        const payload: SharePayload = {
            v: 1, i: 'x', is: [1080, 722], g: [8, 6],
            c: 'classic', s: 42, r: 'none',
        };
        const decoded = decodePayload(encodePayload(payload));
        expect(decoded).not.toBeNull();
        expect(decoded?.bgc).toBeUndefined();
    });

    it('rejects a non-string bgc', () => {
        const payload = {
            v: 1, i: 'x', is: [1080, 722], g: [8, 6],
            c: 'classic', s: 42, r: 'none',
            bgc: 7,
        } as unknown as SharePayload;
        expect(decodePayload(encodePayload(payload))).toBeNull();
    });

    it('gameStateToPayload writes bgc from options and omits it otherwise', () => {
        const state = makeGameState({ cutStyle: 'classic', seed: 7 });
        const withColor = gameStateToPayload(state, {
            includeProgress: false,
            backgroundColorId: 'green-darker',
        });
        expect(withColor.bgc).toBe('green-darker');

        const without = gameStateToPayload(state, { includeProgress: false });
        expect(without.bgc).toBeUndefined();
    });
});

describe('share-link codec — every wire cut style round-trips', () => {
    // Total Record over the game CutStyle union (not the wire union): adding a
    // style won't compile until it declares its wire key and a sample here, and
    // the round-trip then stays red until encode/decode — and `SharePayload['c']`
    // — handle the block. Keying on CutStyle forces the wire touch point from the
    // style's first sub-step, which a `SharePayload['c']`-keyed record would not.
    const STYLE_WIRE: Record<
        CutStyle,
        { wireKey: keyof SharePayload; state: Partial<GameState> }
    > = {
        classic: {
            wireKey: 'clf',
            state: { cutStyle: 'classic', seed: 7, classicConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION } },
        },
        fractal: {
            wireKey: 'ff',
            state: { cutStyle: 'fractal', seed: 7, fractalConfig: { borderless: false } },
        },
        wavy: {
            wireKey: 'wf',
            state: { cutStyle: 'wavy', seed: 7, wavyConfig: { borderless: false, traceSetVersion: CURRENT_TRACE_SET_VERSION } },
        },
        triangles: {
            wireKey: 'tf',
            state: { cutStyle: 'triangles', seed: 7, trianglesConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION } },
        },
        composable: {
            wireKey: 'cf',
            state: {
                cutStyle: 'composable',
                seed: 7,
                composableConfig: { baseCutGenerator: 'sine', baseCutConfig: {}, tabGenerator: 'traced', tabConfig: {} },
            },
        },
    };

    it.each(Object.entries(STYLE_WIRE))(
        'emits and round-trips %s\'s wire config block',
        (_style, { wireKey, state }) => {
            const payload = gameStateToPayload(makeGameState(state), { includeProgress: false });
            expect(payload[wireKey]).toBeDefined();
            expect(decodePayload(encodePayload(payload))).toEqual(payload);
        },
    );
});

describe('links from the frozen legacy build', () => {
    it('still decode', () => {
        const hash = '#p=eyJ2IjoxLCJpIjoiaHR0cHM6Ly9pbWFnZXMudW5zcGxhc2guY29tL3Bob3RvLTEyMz93PTEwODAiLCJpcyI6WzEwODAsNzIwXSwiZyI6WzgsNl0sImMiOiJjbGFzc2ljIiwicyI6MTIzNDUsInIiOiJub25lIn0';
        expect(parseLocationHash(hash)).toEqual({
            v: 1, i: 'https://images.unsplash.com/photo-123?w=1080', is: [1080, 720],
            g: [8, 6], c: 'classic', s: 12345, r: 'none',
        });
    });
});

describe('share-link limits match what the app can write (#759)', () => {
    const sine = (bgc: Record<string, unknown>): SharePayload => ({
        v: 1, i: 'blank', is: [600, 400], g: [4, 3], c: 'composable', s: 1, r: 'none',
        cf: { bg: 'sine', bgc, tg: 'classic', tgc: {} },
    });
    const gridOf = (g: [number, number]): SharePayload['g'] | undefined =>
        decodePayload(encodePayload({ v: 1, i: 'blank', is: [600, 400], g, c: 'classic', s: 1, r: 'none' }))?.g;
    const largestSide = Math.max(...PUZZLE_SIZE_OPTIONS.flatMap((o) => [o.cols, o.rows]));

    it('caps frequency at the dialog maximum and passes 10 and fractions through', () => {
        expect(SINE_FREQUENCY_MAX).toBe(10);
        const decode = (hf: number, vf: number) =>
            decodePayload(encodePayload(sine({ ha: 0.1, hf, va: 0.1, vf })))?.cf?.bgc;
        expect(decode(10, 9.9)).toMatchObject({ hf: 10, vf: 9.9 });
        expect(decode(10.1, 10.0001)).toMatchObject({ hf: 10, vf: 10 });
        expect(decode(0.1, 1.55)).toMatchObject({ hf: 0.1, vf: 1.55 });
    });

    it('drops a sine value that is not a finite number, so a quoted number cannot pass the caps', () => {
        const bgc = decodePayload(encodeRaw(sine({ ha: '5', hf: '400', va: 0.1, vf: { n: 78 } })))?.cf?.bgc;
        expect(bgc).toEqual({ va: 0.1 });
    });

    it('keeps the amplitude cap equal to the dialog maximum', () => {
        const bgc = decodePayload(encodePayload(sine({ ha: SINE_AMPLITUDE_MAX + 0.01, hf: 1, va: SINE_AMPLITUDE_MAX, vf: 1 })))?.cf?.bgc;
        expect(bgc).toMatchObject({ ha: SINE_AMPLITUDE_MAX, va: SINE_AMPLITUDE_MAX });
    });

    it('caps each grid side at the largest side a dialog size offers', () => {
        expect(largestSide).toBe(16);
        expect(gridOf([largestSide, largestSide - 1])).toEqual([16, 15]);
        expect(gridOf([largestSide + 1, 40])).toEqual([16, 16]);
        expect(gridOf([3, 17])).toEqual([3, 16]);
    });

    const FREEZERS: [string, [number, number]][] = [
        ['eyJ2IjoxLCJpIjoiYmxhbmsiLCJpcyI6WzIzMSwyMzFdLCJnIjpbNSw1XSwiYyI6ImNvbXBvc2FibGUiLCJzIjo4NDIsInIiOiJub25lIiwiY2YiOnsiYmciOiJzaW5lIiwiYmdjIjp7ImhhIjowLjAzLCJoZiI6MTAwLCJ2YSI6MC4wMywidmYiOjEwMH0sInRnIjoibm9uZSIsInRnYyI6e319fQ', [5, 5]],
        ['eyJ2IjoxLCJpIjoiYmxhbmsiLCJpcyI6WzUwLDUwXSwiZyI6WzIsNF0sImMiOiJjb21wb3NhYmxlIiwicyI6MjM0LCJyIjoibm9uZSIsImNmIjp7ImJnIjoic2luZSIsImJnYyI6eyJoYSI6MC4xLCJoZiI6NjAsInZhIjowLjAzLCJ2ZiI6MzB9LCJ0ZyI6ImNsYXNzaWMiLCJ0Z2MiOnt9fX0', [2, 4]],
        ['eyJ2IjoxLCJpIjoiYmxhbmsiLCJpcyI6WzIwNCw3MV0sImciOls1NSw0XSwiYyI6ImNvbXBvc2FibGUiLCJzIjo5NzEwOSwiciI6Im5vbmUiLCJjZiI6eyJiZyI6InNpbmUiLCJiZ2MiOnsiaGEiOjAuMDI5LCJoZiI6NzgsInZhIjowLjUsInZmIjoyMH0sInRnIjoibm9uZSIsInRnYyI6e319fQ', [16, 4]],
    ];

    it.each(FREEZERS)('clamps the review freezing link %#', (link, grid) => {
        const decoded = decodePayload(link);
        expect(decoded!.g).toEqual(grid);
        const bgc = decoded!.cf!.bgc as { hf: number; vf: number };
        expect([bgc.hf, bgc.vf]).toEqual([10, 10]);
    });

    describe('every link the dialog can write decodes unchanged', () => {
        const zeroNumbers = (bgc: Record<string, unknown> | undefined): Record<string, unknown> =>
            Object.fromEntries(Object.entries(bgc ?? {}).map(([k, v]) => [k, typeof v === 'number' ? 0 : v]));
        const sizes = [...PUZZLE_SIZE_OPTIONS].sort((a, b) => a.pieceCount - b.pieceCount);
        const grids = [sizes[0], sizes[sizes.length - 1]].flatMap((o) => [[o.cols, o.rows], [o.rows, o.cols]] as [number, number][]);

        for (const [name, { style }] of Object.entries(CASES).flatMap(([, group]) => Object.entries(group))) {
            it(name, () => {
                const config = style.cutStyle === 'composable' ? style.composableConfig : undefined;
                const variants = [style];
                if (config) {
                    variants.push({ ...style, composableConfig: { ...config, baseCutConfig: zeroNumbers(config.baseCutConfig) } } as typeof style);
                }
                for (const variant of variants) {
                    for (const g of grids) {
                        const payload: SharePayload = { v: 1, i: 'blank', is: [1080, 720], g, c: variant.cutStyle, s: 7, r: 'none' };
                        applyStyleConfigs(payload, variant);
                        expect(decodePayload(encodePayload(payload))).toEqual(payload);
                    }
                }
            });
        }
    });
});
