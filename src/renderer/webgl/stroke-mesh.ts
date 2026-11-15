import type { Point } from '../../model/types.js';
import {
    cornerCut,
    innerTails,
    type JointFan,
    NO_TAILS,
    type Strip,
} from './inner-tails.js';

/** World units the outline stroke reaches past the piece edge. */
export const OUTLINE_HALF_WIDTH = 1.5;

export interface StrokeVertex {
    cx: number;
    cy: number;
    /** Offset per unit of extent: the vertex sits at center + w * extent. */
    wx: number;
    wy: number;
    side: number;
}

export interface IndexRange {
    offset: number;
    count: number;
}

export interface StrokeMesh {
    centers: Float32Array;
    /** Longer than unit at mitred joints (1 / cos(turn / 2)); the shader must not normalize them. */
    normals: Float32Array;
    sides: Float32Array;
    indices: Uint32Array;
    /** Ranges of `indices`; empty for a closed stroke. */
    startCap: IndexRange;
    endCap: IndexRange;
    /** Ranges of `indices` that an inner tail replaces. */
    tail: readonly IndexRange[];
    /**
     * Interior-only replacements for `tail` with the start, the end, or both ends clipped; empty
     * unless that end pokes past an acute convex corner.
     */
    startInnerTail: Uint32Array;
    endInnerTail: Uint32Array;
    bothInnerTails: Uint32Array;
}

/** Unit directions away from a corner, along this edge and along its neighbor. */
export interface CornerDirections {
    own: Point;
    neighbor: Point;
}

export interface StrokeCorner extends CornerDirections {
    /** The neighboring edge from the corner outward. */
    neighborPath: readonly Point[];
    /** The piece's side of `neighborPath`'s direction of travel, as `interiorSide` is. */
    neighborInteriorSide: 1 | -1;
}

/** Given only at convex corners. */
export interface StrokeNeighbors {
    start?: StrokeCorner;
    end?: StrokeCorner;
}

const NO_CAP: IndexRange = { offset: 0, count: 0 };

const FAN_STEP = Math.PI / 12;
// Below this turn a miter overshoots the round join by under 0.9% of the half-width.
const MITER_MAX_TURN = Math.PI / 12;
const DUPLICATE_EPSILON = 1e-9;

export class MeshBuilder {
    private readonly centers: number[] = [];
    private readonly normals: number[] = [];
    private readonly sides: number[] = [];
    private readonly indices: number[] = [];

    // The shader places the vertex at center + normal * side * halfWidth, so
    // the offset direction is ux,uy and normal = u * side.
    vertex(cx: number, cy: number, ux: number, uy: number, side: -1 | 1): number {
        this.centers.push(cx, cy);
        this.normals.push(ux * side, uy * side);
        this.sides.push(side);
        return this.sides.length - 1;
    }

    pair(cx: number, cy: number, ux: number, uy: number): number {
        const exterior = this.vertex(cx, cy, ux, uy, 1);
        this.vertex(cx, cy, -ux, -uy, -1);
        return exterior;
    }

    hub(cx: number, cy: number): number {
        return this.point({ cx, cy, wx: 0, wy: 0, side: 0 });
    }

    point({ cx, cy, wx, wy, side }: StrokeVertex): number {
        this.centers.push(cx, cy);
        if (side === 0) this.normals.push(1, 0);
        else this.normals.push(wx / side, wy / side);
        this.sides.push(side);
        return this.sides.length - 1;
    }

    at(index: number): StrokeVertex {
        const side = this.sides[index];
        return {
            cx: this.centers[2 * index],
            cy: this.centers[2 * index + 1],
            wx: this.normals[2 * index] * side,
            wy: this.normals[2 * index + 1] * side,
            side,
        };
    }

    trianglesIn({ offset, count }: IndexRange): number[] {
        return this.indices.slice(offset, offset + count);
    }

    triangle(a: number, b: number, c: number): void {
        this.indices.push(a, b, c);
    }

    indexCount(): number {
        return this.indices.length;
    }

    fan(cx: number, cy: number, start: number, sweep: number, side: -1 | 1): IndexRange {
        const offset = this.indices.length;
        const steps = Math.max(1, Math.ceil(Math.abs(sweep) / FAN_STEP));
        const hub = this.hub(cx, cy);
        let previous = -1;
        for (let i = 0; i <= steps; i++) {
            const angle = start + (sweep * i) / steps;
            const index = this.vertex(cx, cy, Math.cos(angle), Math.sin(angle), side);
            if (previous >= 0) this.triangle(hub, previous, index);
            previous = index;
        }
        return { offset, count: this.indices.length - offset };
    }

    build(startCap = NO_CAP, endCap = NO_CAP, tails = NO_TAILS): StrokeMesh {
        return {
            centers: new Float32Array(this.centers),
            normals: new Float32Array(this.normals),
            sides: new Float32Array(this.sides),
            indices: new Uint32Array(this.indices),
            startCap,
            endCap,
            tail: tails.tail,
            startInnerTail: new Uint32Array(tails.start),
            endInnerTail: new Uint32Array(tails.end),
            bothInnerTails: new Uint32Array(tails.both),
        };
    }
}

function dedupe(polyline: Point[], closed: boolean): Point[] {
    const points: Point[] = [];
    for (const p of polyline) {
        const last = points[points.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > DUPLICATE_EPSILON) {
            points.push(p);
        }
    }
    if (closed && points.length > 1) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) <= DUPLICATE_EPSILON) {
            points.pop();
        }
    }
    return points;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
    if (points.length < 3) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const spans: Array<[number, number]> = [[0, points.length - 1]];
    while (spans.length > 0) {
        const [first, last] = spans.pop()!;
        let worst = -1;
        let worstDistance = tolerance;
        for (let i = first + 1; i < last; i++) {
            const distance = distanceToSegment(points[i], points[first], points[last]);
            if (distance > worstDistance) {
                worst = i;
                worstDistance = distance;
            }
        }
        if (worst === -1) continue;
        keep[worst] = 1;
        spans.push([first, worst], [worst, last]);
    }
    return points.filter((_, i) => keep[i] === 1);
}

/**
 * `interiorSide` names which side of the direction of travel the piece interior
 * is on: 1 for the left normal (-dy, dx), -1 for the right one.
 */
export function buildStrokeMesh(
    polyline: Point[],
    closed: boolean,
    interiorSide: 1 | -1,
    neighbors: StrokeNeighbors = {},
): StrokeMesh {
    const points = dedupe(polyline, closed);
    const builder = new MeshBuilder();
    const count = points.length;
    if (count < 2 || (closed && count < 3)) return builder.build();

    const segmentCount = closed ? count : count - 1;
    const dirs: Array<[number, number]> = [];
    const exteriors: Array<[number, number]> = [];
    for (let i = 0; i < segmentCount; i++) {
        const a = points[i];
        const b = points[(i + 1) % count];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const dx = (b.x - a.x) / length;
        const dy = (b.y - a.y) / length;
        dirs.push([dx, dy]);
        exteriors.push([interiorSide * dy, -interiorSide * dx]);
    }

    const turns = new Float64Array(count);
    const joinStart = closed ? 0 : 1;
    const joinEnd = closed ? count : count - 1;
    for (let i = joinStart; i < joinEnd; i++) {
        const [d0x, d0y] = dirs[(i - 1 + segmentCount) % segmentCount];
        const [d1x, d1y] = dirs[i];
        turns[i] = Math.atan2(d0x * d1y - d0y * d1x, d0x * d1x + d0y * d1y);
    }
    const isMitred = (i: number): boolean => i >= joinStart && i < joinEnd && Math.abs(turns[i]) < MITER_MAX_TURN;

    const mitrePairs = new Map<number, number>();
    const mitrePair = (i: number): number => {
        let pair = mitrePairs.get(i);
        if (pair === undefined) {
            const [ax, ay] = exteriors[(i - 1 + segmentCount) % segmentCount];
            const [bx, by] = exteriors[i];
            const scale = 1 + ax * bx + ay * by;
            pair = builder.pair(points[i].x, points[i].y, (ax + bx) / scale, (ay + by) / scale);
            mitrePairs.set(i, pair);
        }
        return pair;
    };
    const segmentPairs: Array<[number, number]> = [];
    const segmentRanges: IndexRange[] = [];
    for (let i = 0; i < segmentCount; i++) {
        const j = (i + 1) % count;
        const [ox, oy] = exteriors[i];
        const a = isMitred(i) ? mitrePair(i) : builder.pair(points[i].x, points[i].y, ox, oy);
        const b = isMitred(j) ? mitrePair(j) : builder.pair(points[j].x, points[j].y, ox, oy);
        const offset = builder.indexCount();
        builder.triangle(a, a + 1, b);
        builder.triangle(a + 1, b + 1, b);
        segmentPairs.push([a, b]);
        segmentRanges.push({ offset, count: builder.indexCount() - offset });
    }

    const fans = new Map<number, JointFan>();
    for (let i = joinStart; i < joinEnd; i++) {
        if (isMitred(i)) continue;
        const turn = turns[i];
        const [d0x, d0y] = dirs[(i - 1 + segmentCount) % segmentCount];
        // The outer side of a left turn is the right-hand normal (dy, -dx).
        const turnSign = turn > 0 ? 1 : -1;
        const start = Math.atan2(-turnSign * d0x, turnSign * d0y);
        const side = (turnSign * interiorSide) as -1 | 1;
        fans.set(i, { range: builder.fan(points[i].x, points[i].y, start, turn, side), interior: side === -1 });
    }

    if (closed) return builder.build();
    const [startX, startY] = dirs[0];
    const [endX, endY] = dirs[segmentCount - 1];
    const startCap = addCap(builder, points[0], -startX, -startY, -interiorSide as -1 | 1);
    const endCap = addCap(builder, points[count - 1], endX, endY, interiorSide);
    const strip: Strip = { builder, points, exteriors, segmentPairs, segmentRanges, fans };
    const startCut = cornerCut(points[0], dirs[0], neighbors.start, OUTLINE_HALF_WIDTH);
    const endCut = cornerCut(points[count - 1], [-endX, -endY], neighbors.end, OUTLINE_HALF_WIDTH);
    return builder.build(startCap, endCap, innerTails(strip, startCut, endCut, OUTLINE_HALF_WIDTH));
}

// A cap is a half-turn fan pointing along the outward tangent (tx, ty);
// `interiorSide` is relative to that tangent. The exterior half gets side +1
// and the interior half side -1.
function addCap(
    builder: MeshBuilder,
    p: Point,
    tx: number,
    ty: number,
    interiorSide: 1 | -1,
): IndexRange {
    const offset = builder.indexCount();
    const tip = Math.atan2(ty, tx);
    const quarter = interiorSide * (Math.PI / 2);
    builder.fan(p.x, p.y, tip - quarter, quarter, 1);
    builder.fan(p.x, p.y, tip, quarter, -1);
    return { offset, count: builder.indexCount() - offset };
}
