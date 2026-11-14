import { describe, test, expect } from 'vitest';
import { flattenPath } from './path-flatten.js';
import { generateComposablePuzzle } from '../../puzzle/composable-generator.js';
import { generateFractalPuzzle } from '../../puzzle/fractal/index.js';
import type { Point } from '../../model/types.js';

const TOL = 0.05;

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const u = 1 - t;
    return {
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
}

function distanceToPolyline(p: Point, line: Point[]): number {
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i];
        const b = line[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
    return best;
}

describe('flattenPath', () => {
    test('M L Z gives one closed loop without duplicate end', () => {
        const loops = flattenPath('M0 0 L10 0 L10 10 L0 10 Z', TOL);
        expect(loops).toEqual([[
            { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
        ]]);
    });

    test('H V and relative commands resolve to absolute points', () => {
        const loops = flattenPath('M5 5 H15 V15 h-10 v-5 l0 -5 Z', TOL);
        expect(loops).toEqual([[
            { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 },
            { x: 5, y: 15 }, { x: 5, y: 10 },
        ]]);
    });

    test('cubic C endpoints are exact and interior points lie on the curve within tolerance', () => {
        const p0 = { x: 0, y: 0 };
        const p1 = { x: 20, y: 40 };
        const p2 = { x: 60, y: 40 };
        const p3 = { x: 80, y: 0 };
        const [line] = flattenPath('M0 0 C20 40 60 40 80 0', TOL);
        expect(line[0]).toEqual(p0);
        expect(line[line.length - 1]).toEqual(p3);
        expect(line.length).toBeGreaterThan(3);
        for (let i = 0; i <= 200; i++) {
            const pt = cubicAt(p0, p1, p2, p3, i / 200);
            expect(distanceToPolyline(pt, line)).toBeLessThan(TOL * 4);
        }
    });

    test('reversing a cubic yields the same point set', () => {
        const [fwd] = flattenPath('M0 0 C20 40 60 30 80 5', TOL);
        const [rev] = flattenPath('M80 5 C60 30 20 40 0 0', TOL);
        expect(rev).toEqual([...fwd].reverse());
    });

    test('reversing a quadratic gives bit-identical points', () => {
        const [fwd] = flattenPath('M3 7 Q40 -20 90 11', TOL);
        const [rev] = flattenPath('M90 11 Q40 -20 3 7', TOL);
        expect(rev).toEqual([...fwd].reverse());
    });

    test.each([[0, 0], [0, 1], [1, 0], [1, 1]])(
        'reversing an arc gives bit-identical points (large=%i sweep=%i)',
        (large, sweep) => {
            const [fwd] = flattenPath(`M3 7 A30 20 25 ${large} ${sweep} 50 31`, TOL);
            const [rev] = flattenPath(`M50 31 A30 20 25 ${large} ${1 - sweep} 3 7`, TOL);
            expect(fwd.length).toBeGreaterThan(3);
            expect(rev).toEqual([...fwd].reverse());
        },
    );

    test('reversing a closed-endpoint cubic gives bit-identical points', () => {
        const [fwd] = flattenPath('M0 0 C30 40 -30 40 0 0', TOL);
        const [rev] = flattenPath('M0 0 C-30 40 30 40 0 0', TOL);
        expect(rev).toEqual([...fwd].reverse());
    });

    test('relative c and a match their absolute forms', () => {
        expect(flattenPath('M10 10 c10 20 30 20 40 0', TOL))
            .toEqual(flattenPath('M10 10 C20 30 40 30 50 10', TOL));
        expect(flattenPath('M10 10 a10 10 0 0 1 10 10', TOL))
            .toEqual(flattenPath('M10 10 A10 10 0 0 1 20 20', TOL));
    });

    test('a relative command right after Z starts from the subpath start', () => {
        const loops = flattenPath('M5 5 L15 5 L15 15 Z l10 0 l0 10 Z', TOL);
        expect(loops).toEqual([
            [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }],
            [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }],
        ]);
    });

    test('compact numbers split correctly', () => {
        expect(flattenPath('M1.5.5L-1-2 3-4Z', TOL)).toEqual([
            [{ x: 1.5, y: 0.5 }, { x: -1, y: -2 }, { x: 3, y: -4 }],
        ]);
    });

    test('arc flags without separators parse', () => {
        expect(flattenPath('M0 0a1 1 0 011 1', TOL))
            .toEqual(flattenPath('M0 0a1 1 0 0 1 1 1', TOL));
    });

    test('zero-radius arc is a line and coincident-endpoint arc is skipped', () => {
        expect(flattenPath('M0 0 A0 5 0 0 1 10 10', TOL)).toEqual([[{ x: 0, y: 0 }, { x: 10, y: 10 }]]);
        expect(flattenPath('M0 0 L5 5 A5 5 0 0 1 5 5 L10 0', TOL))
            .toEqual([[{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]]);
    });

    test('S and T reflect the previous control point', () => {
        const [s] = flattenPath('M0 0 C0 10 10 10 10 0 S20 -10 20 0', TOL);
        const [c] = flattenPath('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0', TOL);
        expect(s).toEqual(c);

        const [t] = flattenPath('M0 0 Q5 10 10 0 T20 0', TOL);
        const [q] = flattenPath('M0 0 Q5 10 10 0 Q15 -10 20 0', TOL);
        expect(t).toEqual(q);
    });

    test('A arc: quarter circle r=10 has all points at distance 10±tolerance from centre', () => {
        const [line] = flattenPath('M10 0 A10 10 0 0 1 0 10', TOL);
        expect(line[0]).toEqual({ x: 10, y: 0 });
        const last = line[line.length - 1];
        expect(last.x).toBeCloseTo(0, 9);
        expect(last.y).toBeCloseTo(10, 9);
        expect(line.length).toBeGreaterThan(3);
        for (const p of line) {
            expect(Math.abs(Math.hypot(p.x, p.y) - 10)).toBeLessThanOrEqual(TOL);
        }
    });

    test('A arc with too-small radii scales radii up (F.6.6)', () => {
        const [line] = flattenPath('M0 0 A1 1 0 0 1 20 0', TOL);
        for (const p of line) {
            expect(Math.abs(Math.hypot(p.x - 10, p.y) - 10)).toBeLessThanOrEqual(TOL);
        }
        const last = line[line.length - 1];
        expect(last.x).toBeCloseTo(20, 9);
        expect(last.y).toBeCloseTo(0, 9);
    });

    test('multi-subpath shape gives one loop per M..Z', () => {
        const loops = flattenPath('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z', TOL);
        expect(loops).toHaveLength(2);
        expect(loops[1][0]).toEqual({ x: 20, y: 20 });
    });

    test.each([
        ['M0 0 X1 2', /Unknown path command X at 5: X1 2/],
        ['M0 0 A1 1 0 2 0 5 5', /Invalid arc flag at 12: 2 0 5 5/],
        ['M0 0 Z 7 8', /Invalid path data at 7: 7 8/],
        ['M0 0 L1 #', /Invalid path data at 8: #/],
    ])('parse error for %s quotes the offending text', (d, message) => {
        expect(() => flattenPath(d, TOL)).toThrow(message);
    });

    test('every shape in a generated Venn puzzle and a fractal puzzle flattens without throwing', () => {
        const venn = generateComposablePuzzle(1, 1, { width: 1080, height: 720 }, 1, {
            baseCutGenerator: 'venn',
            baseCutConfig: {
                leftCenter: { x: 432, y: 360 }, leftRadius: 240,
                rightCenter: { x: 648, y: 360 }, rightRadius: 240,
            },
            tabGenerator: 'classic',
            tabConfig: {},
        }).pieces;
        const fractal = generateFractalPuzzle(4, 3, { width: 400, height: 300 }, 42);
        for (const piece of [...venn, ...fractal]) {
            const loops = flattenPath(piece.shape, TOL);
            expect(loops.length).toBeGreaterThan(0);
            for (const loop of loops) {
                expect(loop.length).toBeGreaterThanOrEqual(3);
                for (const p of loop) {
                    expect(Number.isFinite(p.x)).toBe(true);
                    expect(Number.isFinite(p.y)).toBe(true);
                }
            }
        }
    });
});
