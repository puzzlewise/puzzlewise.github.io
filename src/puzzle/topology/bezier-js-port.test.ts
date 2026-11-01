import { describe, it, expect } from 'vitest';
import { Bezier } from 'bezier-js';
import { createSeededRandom } from '../seeded-random.js';
import { curveIntersects, reduce } from './bezier-js-port.js';

/**
 * Exact identity, not closeness: `-0` vs `0` or a last-ULP difference
 * would still move generated geometry.
 */
function expectIdenticalParts(actual: Bezier[], expected: Bezier[]): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((part, i) => {
        const want = expected[i];
        expect(part._t1, `part ${i} _t1`).toBe(want._t1);
        expect(part._t2, `part ${i} _t2`).toBe(want._t2);
        part.points.forEach((p, j) => {
            expect(p.x, `part ${i} point ${j} x`).toBe(want.points[j].x);
            expect(p.y, `part ${i} point ${j} y`).toBe(want.points[j].y);
        });
    });
}

const EDGE_CASES: Record<string, () => Bezier> = {
    tightLoop: () => new Bezier(0, 0, 200, 100, -200, 100, 0, 0.001),
    simpleArc: () => new Bezier(0, 0, 30, 40, 70, 40, 100, 0),
    droppedTail: () => new Bezier(
        94.8845119780905, 654.5454545454545,
        94.477045388968, 676.3636363636364,
        91.92740345570223, 698.1818181818181,
        89.43080069151513, 720,
    ),
    cusp: () => new Bezier(0, 0, 100, 100, 0, 100, 100, 0),
    sharpReversal: () => new Bezier(0, 0, 100, 0, -100, 0, 0, 0),
    point: () => new Bezier(0, 0, 0, 0, 0, 0, 0, 0),
    straightLine: () => new Bezier(0, 0, 10, 10, 20, 20, 30, 30),
    collapsedHandles: () => new Bezier(0, 0, 0, 0, 50, 50, 50, 50),
};

describe('reduce', () => {
    it.each(Object.keys(EDGE_CASES))('matches bezier-js on %s', (name) => {
        const curve = EDGE_CASES[name]();
        expectIdenticalParts(reduce(curve), curve.reduce());
    });

    it('matches bezier-js on random cubics across scales', () => {
        const random = createSeededRandom(686);
        for (let i = 0; i < 200; i++) {
            const scale = 10 ** (random() * 4 - 1);
            const coords = Array.from({ length: 8 }, () => (random() - 0.5) * scale);
            const curve = new Bezier(coords);
            expectIdenticalParts(reduce(curve), curve.reduce());
        }
    });

    it('defers to bezier-js for curves the port does not cover', () => {
        const quadratic = new Bezier(0, 0, 50, 100, 100, 0);
        expectIdenticalParts(reduce(quadratic), quadratic.reduce());
    });
});

describe('curveIntersects', () => {
    function randomCubic(random: () => number): Bezier {
        return new Bezier(Array.from({ length: 8 }, () => random() * 100));
    }

    it('matches bezier-js, including on repeat calls with the same parts', () => {
        const random = createSeededRandom(1686);
        let pairsWithHits = 0;
        for (let i = 0; i < 100; i++) {
            const a = randomCubic(random).reduce();
            const b = randomCubic(random).reduce();
            const expected = new Bezier(0, 0, 1, 1, 2, 2, 3, 3).curveintersects(a, b);
            if (expected.length > 0) pairsWithHits++;

            expect(curveIntersects(a, b)).toEqual(expected);
            expect(curveIntersects(a, b)).toEqual(expected);
        }
        expect(pairsWithHits).toBeGreaterThan(30);
    });

    it('treats boxes that only touch as not overlapping, like bezier-js', () => {
        const flat = new Bezier(0, 50, 30, 50, 70, 50, 100, 50).reduce();
        const risingFromFlat = new Bezier(50, 50, 60, 80, 80, 90, 100, 100).reduce();
        const expected = new Bezier(0, 0, 1, 1, 2, 2, 3, 3).curveintersects(flat, risingFromFlat);

        expect(expected).toEqual([]);
        expect(curveIntersects(flat, risingFromFlat)).toEqual(expected);
    });
});
