import { describe, it, expect } from 'vitest';
import { Bezier } from 'bezier-js';
import { completeReduction } from './complete-reduction.js';

/**
 * Curves probed from bezier-js 6.1.4, one per shape of `reduce()`
 * result; the per-field docs record what its `reduce()` returns.
 */
const CURVES = {
    /** Reduces cleanly, covering [0, 1] in 9 parts. */
    tightLoop: () => new Bezier(0, 0, 200, 100, -200, 100, 0, 0.001),
    /** Plain, simple arc — reduces to full coverage. */
    simpleArc: () => new Bezier(0, 0, 30, 40, 70, 40, 100, 0),
    /** #498: x-extremum at t=0.9758 leaves a dropped tail [0.9758, 1]. */
    droppedTail: () => new Bezier(
        94.8845119780905, 654.5454545454545,
        94.477045388968, 676.3636363636364,
        91.92740345570223, 698.1818181818181,
        89.43080069151513, 720,
    ),
    /** Cusp — reduces to a single part [0, 0.495], dropping the rest. */
    cusp: () => new Bezier(0, 0, 100, 100, 0, 100, 100, 0),
    /** Reduces to [0, 0.209] and [0.5, 0.786]: a middle gap AND a tail gap. */
    sharpReversal: () => new Bezier(0, 0, 100, 0, -100, 0, 0, 0),
    /** Degenerate: `reduce()` returns nothing at all. */
    point: () => new Bezier(0, 0, 0, 0, 0, 0, 0, 0),
};

/**
 * Structural identity of a part: a separate `reduce()` recomputes fresh
 * `Bezier` objects, so parts match by shape, not reference.
 */
function shapeOf(part: Bezier): string {
    return JSON.stringify([part._t1, part._t2, part.points]);
}

function expectCoversWholeCurve(parts: Bezier[]): void {
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0]._t1).toBeCloseTo(0, 9);
    for (const part of parts) {
        // Adjacency alone accepts an inverted part: [0,0.5],[0.5,0.3],
        // [0.3,1] is "gap-free" end to end.
        expect(part._t2).toBeGreaterThan(part._t1);
    }
    for (let i = 1; i < parts.length; i++) {
        expect(parts[i]._t1).toBeCloseTo(parts[i - 1]._t2, 9);
    }
    expect(parts[parts.length - 1]._t2).toBeCloseTo(1, 9);
}

/**
 * A stand-in `reduce()` result: parts of `curve` covering exactly `ranges`.
 *
 * Real `reduce()` always walks `t` forwards, so a stand-in is the only way
 * to reach the cursor's `Math.max` guard against an out-of-order part
 * rewinding over already-covered `t`. The failure it prevents is a
 * redundant fill (duplicating a sub-curve, or turning a pass-through
 * into a modified array), not an inverted range.
 */
function partsCovering(curve: Bezier, ranges: ReadonlyArray<[number, number]>): Bezier[] {
    return ranges.map(([t1, t2]) => {
        const part = curve.split(t1, t2);
        part._t1 = t1;
        part._t2 = t2;
        return part;
    });
}

describe('completeReduction', () => {
    describe('curves bezier-js already reduces correctly', () => {
        it.each(['tightLoop', 'simpleArc'] as const)(
            'returns %s\'s own reduce() output unchanged',
            (name) => {
                const curve = CURVES[name]();
                // Assert the block's premise: bezier-js already covers these
                // end to end, so a bump that opens a gap fails here as
                // "premise broken" rather than as an opaque array diff below.
                expectCoversWholeCurve(curve.reduce());
                // Same count/t-ranges/control points as `intersects()` would
                // pair off — keeps generated geometry bit-identical so
                // existing share links and saves survive.
                expect(completeReduction(curve).map(shapeOf))
                    .toEqual(curve.reduce().map(shapeOf));
            },
        );
    });

    describe('curves with a dropped tail', () => {
        it('fills the tail bezier-js omitted', () => {
            const curve = CURVES.droppedTail();
            expect(curve.reduce().at(-1)!._t2).toBeCloseTo(0.9758, 3);

            expectCoversWholeCurve(completeReduction(curve));
        });

        it('adds the tail without disturbing the parts bezier-js returned', () => {
            const curve = CURVES.droppedTail();
            const original = curve.reduce().map(shapeOf);

            const completed = completeReduction(curve).map(shapeOf);

            expect(completed.slice(0, original.length)).toEqual(original);
            expect(completed).toHaveLength(original.length + 1);
        });

        it('fills the much larger tail dropped after a cusp', () => {
            expectCoversWholeCurve(completeReduction(CURVES.cusp()));
        });
    });

    it('fills a gap in the middle as well as at the end', () => {
        const curve = CURVES.sharpReversal();
        // Two parts with a hole between them, and a third hole at the end.
        expect(curve.reduce().map(p => [p._t1, p._t2])).toHaveLength(2);

        const completed = completeReduction(curve);

        expectCoversWholeCurve(completed);
        expect(completed).toHaveLength(4);
    });

    it('returns the whole curve when reduce() returns nothing', () => {
        const curve = CURVES.point();
        expect(curve.reduce()).toHaveLength(0);

        const completed = completeReduction(curve);

        expect(completed).toHaveLength(1);
        expectCoversWholeCurve(completed);
    });

    describe('parts that arrive out of order', () => {
        it('fills the tail from where coverage ends, not from the last part', () => {
            const curve = CURVES.simpleArc();
            const parts = partsCovering(curve, [[0, 0.8], [0.4, 0.6]]);

            const completed = completeReduction(curve, parts);

            expect(completed).toHaveLength(3);
            expect(completed.at(-1)!._t1).toBeCloseTo(0.8, 9);
            expect(completed.at(-1)!._t2).toBe(1);
        });

        it('still passes reduce() through when an earlier part already reached the end', () => {
            const curve = CURVES.simpleArc();
            const parts = partsCovering(curve, [[0, 1], [0.4, 0.6]]);

            expect(completeReduction(curve, parts)).toBe(parts);
        });
    });

    describe('the filled-in pieces are geometrically faithful', () => {
        it.each(['droppedTail', 'cusp', 'sharpReversal'] as const)(
            'every part of %s matches the original curve over its own t-range',
            (name) => {
                const curve = CURVES[name]();

                for (const part of completeReduction(curve)) {
                    for (const local of [0, 0.25, 0.5, 0.75, 1]) {
                        const onPart = part.get(local);
                        const onCurve = curve.get(part._t1 + local * (part._t2 - part._t1));
                        expect(onPart.x).toBeCloseTo(onCurve.x, 6);
                        expect(onPart.y).toBeCloseTo(onCurve.y, 6);
                    }
                }
            },
        );

        it('tags the filled tail with absolute t-bounds', () => {
            // `pairiteration` maps hits through `_t1`/`_t2`, so a filled
            // piece tagged with the wrong range would place the crossing
            // elsewhere entirely.
            const curve = CURVES.droppedTail();
            const tail = completeReduction(curve).at(-1)!;

            expect(tail._t1).toBeCloseTo(0.9758, 3);
            expect(tail._t2).toBe(1);
            expect(tail.get(0).x).toBeCloseTo(curve.get(tail._t1).x, 6);
            expect(tail.get(1).x).toBeCloseTo(curve.get(1).x, 6);
        });
    });
});
