/**
 * Ports of bezier-js 6.1.4 internals, reworked for speed while staying
 * bit-identical: generated geometry is a reproducibility contract, so
 * every float operation mirrors the original in value and order (#686).
 * The digest tripwires (see CLAUDE.md) guard that equivalence.
 *
 * bezier-js — Copyright (c) Mike "Pomax" Kamermans, MIT License.
 * https://github.com/Pomax/bezierjs
 */

import type { Bezier } from 'bezier-js';

const REDUCE_STEP = 0.01;

/**
 * `curve.reduce()` for a 2D cubic. bezier-js builds ~4 throwaway `Bezier`
 * objects per 0.01 step just to ask `simple()` of each trial split; this
 * evaluates the trial on raw control points. Parts that are returned
 * still come from the real `split()`. Keeps the original's `return []`
 * inside the per-segment loop, which drops a range — `completeReduction`
 * repairs that, and fixing it here would move geometry.
 */
export function reduce(curve: Bezier): Bezier[] {
    if (curve.order !== 3 || curve._3d) return curve.reduce();

    let extrema = curve.extrema().values;
    if (extrema.indexOf(0) === -1) extrema = [0].concat(extrema);
    if (extrema.indexOf(1) === -1) extrema.push(1);

    const pass1: Bezier[] = [];
    for (let t1 = extrema[0], i = 1; i < extrema.length; i++) {
        const t2 = extrema[i];
        const segment = curve.split(t1, t2);
        segment._t1 = t1;
        segment._t2 = t2;
        pass1.push(segment);
        t1 = t2;
    }

    const pass2: Bezier[] = [];
    nextSegment: for (const p1 of pass1) {
        const points = controlPoints(p1);
        let t1 = 0;
        let t2 = 0;
        while (t2 <= 1) {
            for (t2 = t1 + REDUCE_STEP; t2 <= 1 + REDUCE_STEP; t2 += REDUCE_STEP) {
                if (!isSimpleSplit(points, t1, t2)) {
                    t2 -= REDUCE_STEP;
                    if (Math.abs(t1 - t2) < REDUCE_STEP) continue nextSegment;
                    const segment = p1.split(t1, t2);
                    segment._t1 = map(t1, 0, 1, p1._t1, p1._t2);
                    segment._t2 = map(t2, 0, 1, p1._t1, p1._t2);
                    pass2.push(segment);
                    t1 = t2;
                    break;
                }
            }
        }
        if (t1 < 1) {
            const segment = p1.split(t1, 1);
            segment._t1 = map(t1, 0, 1, p1._t1, p1._t2);
            segment._t2 = p1._t2;
            pass2.push(segment);
        }
    }
    return pass2;
}

/** Cubic control points as `[x0, y0, x1, y1, x2, y2, x3, y3]`. */
type Cubic = Float64Array;

function controlPoints(curve: Bezier): Cubic {
    const [p0, p1, p2, p3] = curve.points;
    return Float64Array.of(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
}

const trialRight: Cubic = new Float64Array(8);
const trialSplit: Cubic = new Float64Array(8);

/** `curve.split(t1, t2).simple()`, for `0 <= t1 < t2`. */
function isSimpleSplit(points: Cubic, t1: number, t2: number): boolean {
    if (t1 === 0) {
        halve(points, t2, trialSplit, true);
    } else if (t2 === 1) {
        halve(points, t1, trialSplit, false);
    } else {
        halve(points, t1, trialRight, false);
        halve(trialRight, map(t2, t1, 1, 0, 1), trialSplit, true);
    }
    return isSimple(trialSplit);
}

/**
 * The left or right part of `Bezier.split(t)`: bezier-js's `hull(t)`
 * points `[p0, q4, q7, q9]` or `[q9, q8, q6, p3]`.
 */
function halve(src: Cubic, t: number, out: Cubic, left: boolean): void {
    for (let axis = 0; axis < 2; axis++) {
        const p0 = src[axis], p1 = src[axis + 2], p2 = src[axis + 4], p3 = src[axis + 6];
        const q4 = lerp(t, p0, p1);
        const q5 = lerp(t, p1, p2);
        const q6 = lerp(t, p2, p3);
        const q7 = lerp(t, q4, q5);
        const q8 = lerp(t, q5, q6);
        const q9 = lerp(t, q7, q8);
        if (left) {
            out[axis] = p0; out[axis + 2] = q4; out[axis + 4] = q7; out[axis + 6] = q9;
        } else {
            out[axis] = q9; out[axis + 2] = q8; out[axis + 4] = q6; out[axis + 6] = p3;
        }
    }
}

/** `Bezier.simple()` for a 2D cubic. */
function isSimple(c: Cubic): boolean {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = c;
    const a1 = angle(x0, y0, x3, y3, x1, y1);
    const a2 = angle(x0, y0, x3, y3, x2, y2);
    if ((a1 > 0 && a2 < 0) || (a1 < 0 && a2 > 0)) return false;

    const d1x = 3 * (x1 - x0), d1y = 3 * (y1 - y0);
    const d2x = 3 * (x3 - x2), d2y = 3 * (y3 - y2);
    const q1 = Math.sqrt(d1x * d1x + d1y * d1y);
    const q2 = Math.sqrt(d2x * d2x + d2y * d2y);
    const s = (-d1y / q1) * (-d2y / q2) + (d1x / q1) * (d2x / q2);
    return Math.abs(Math.acos(s)) < Math.PI / 3;
}

function lerp(r: number, a: number, b: number): number {
    return a + r * (b - a);
}

function angle(ox: number, oy: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx1 = x1 - ox, dy1 = y1 - oy;
    const dx2 = x2 - ox, dy2 = y2 - oy;
    return Math.atan2(dx1 * dy2 - dy1 * dx2, dx1 * dx2 + dy1 * dy2);
}

function map(v: number, ds: number, de: number, ts: number, te: number): number {
    return ts + (te - ts) * ((v - ds) / (de - ds));
}
