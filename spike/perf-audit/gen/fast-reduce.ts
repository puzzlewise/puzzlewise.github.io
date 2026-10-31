import { Bezier } from '/Users/bot/src/puzzle/node_modules/bezier-js/src/bezier.js';
import { utils } from '/Users/bot/src/puzzle/node_modules/bezier-js/src/utils.js';

type P = { x: number; y: number };
const lerp = (r: number, a: P, b: P): P => ({ x: a.x + r * (b.x - a.x), y: a.y + r * (b.y - a.y) });
function hull(p: P[], t: number) {
    const q4 = lerp(t, p[0], p[1]), q5 = lerp(t, p[1], p[2]), q6 = lerp(t, p[2], p[3]);
    const q7 = lerp(t, q4, q5), q8 = lerp(t, q5, q6);
    const q9 = lerp(t, q7, q8);
    return [p[0], p[1], p[2], p[3], q4, q5, q6, q7, q8, q9];
}
const left = (q: P[]) => [q[0], q[4], q[7], q[9]];
const right = (q: P[]) => [q[9], q[8], q[6], q[3]];
// mirrors Bezier.prototype.split(t1, t2) control points for a cubic
function splitPts(p: P[], t1: number, t2: number): P[] {
    if (t1 === 0 && !!t2) return left(hull(p, t2));
    if (t2 === 1) return right(hull(p, t1));
    const r = right(hull(p, t1));
    if (!t2) return r; // not reached in reduce
    const t2m = utils.map(t2, t1, 1, 0, 1);
    return left(hull(r, t2m));
}
// mirrors Bezier.prototype.simple() for a 2D cubic
function simplePts(p: P[]): boolean {
    const a1 = utils.angle(p[0], p[3], p[1]);
    const a2 = utils.angle(p[0], p[3], p[2]);
    if ((a1 > 0 && a2 < 0) || (a1 < 0 && a2 > 0)) return false;
    const d1x = 3 * (p[1].x - p[0].x), d1y = 3 * (p[1].y - p[0].y);
    const d2x = 3 * (p[3].x - p[2].x), d2y = 3 * (p[3].y - p[2].y);
    const q1 = Math.sqrt(d1x * d1x + d1y * d1y), q2 = Math.sqrt(d2x * d2x + d2y * d2y);
    const n1x = -d1y / q1, n1y = d1x / q1, n2x = -d2y / q2, n2y = d2x / q2;
    const s = n1x * n2x + n1y * n2y;
    return Math.abs(Math.acos(s)) < Math.PI / 3;
}

export function fastReduce(this: any): any[] {
    if (this.order !== 3 || this._3d) return origReduce.call(this);
    let i, t1 = 0, t2 = 0;
    const step = 0.01;
    let segment: any;
    const pass1: any[] = [], pass2: any[] = [];
    let extrema = this.extrema().values;
    if (extrema.indexOf(0) === -1) extrema = [0].concat(extrema);
    if (extrema.indexOf(1) === -1) extrema.push(1);
    for (t1 = extrema[0], i = 1; i < extrema.length; i++) {
        t2 = extrema[i];
        segment = this.split(t1, t2);
        segment._t1 = t1; segment._t2 = t2;
        pass1.push(segment);
        t1 = t2;
    }
    pass1.forEach(function (p1: any) {
        const pts = p1.points;
        t1 = 0; t2 = 0;
        while (t2 <= 1) {
            for (t2 = t1 + step; t2 <= 1 + step; t2 += step) {
                if (!simplePts(splitPts(pts, t1, t2))) {
                    t2 -= step;
                    if (Math.abs(t1 - t2) < step) return [];
                    segment = p1.split(t1, t2);
                    segment._t1 = utils.map(t1, 0, 1, p1._t1, p1._t2);
                    segment._t2 = utils.map(t2, 0, 1, p1._t1, p1._t2);
                    pass2.push(segment);
                    t1 = t2;
                    break;
                }
            }
        }
        if (t1 < 1) {
            segment = p1.split(t1, 1);
            segment._t1 = utils.map(t1, 0, 1, p1._t1, p1._t2);
            segment._t2 = p1._t2;
            pass2.push(segment);
        }
    });
    return pass2;
}
export const origReduce = (Bezier.prototype as any).reduce;
