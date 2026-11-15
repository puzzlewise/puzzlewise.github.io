import type { Point } from '../../model/types.js';
import type { IndexRange, MeshBuilder, StrokeCorner, StrokeVertex } from './stroke-mesh.js';

export interface InnerTails {
    tail: readonly IndexRange[];
    start: number[];
    end: number[];
    both: number[];
}

export const NO_TAILS: InnerTails = { tail: [], start: [], end: [], both: [] };

const CLIP_EPSILON = 1e-9;
const AREA_EPSILON = 1e-9;
const FIRST_POINT_EPSILON = 1e-6;
// Square corners measure up to about half a degree acute; below 89° the band's square
// end overhangs the neighbor by at most 1.5 * cos(89°) ≈ 0.026 units.
const TIP_MIN_COS = Math.cos((89 * Math.PI) / 180);
const MIN_SIN = Math.sin((3 * Math.PI) / 180);

interface ClipVertex extends StrokeVertex {
    /** -1 until the vertex is added to the mesh. */
    index: number;
    /** On the interior offset line of the segment being clipped. */
    onOffset: boolean;
    point?: number;
}

export interface JointFan {
    range: IndexRange;
    interior: boolean;
}

export interface Strip {
    builder: MeshBuilder;
    points: Point[];
    exteriors: Array<[number, number]>;
    segmentPairs: Array<[number, number]>;
    segmentRanges: IndexRange[];
    fans: Map<number, JointFan>;
}

interface ClipStrip extends Strip {
    centerIndices: Map<number, number>;
}

/**
 * Keeps (x - p)·h ≥ 0, with vertices placed at `extent`; `k` runs along the boundary line.
 */
interface HalfPlane {
    extent: number;
    px: number;
    py: number;
    kx: number;
    ky: number;
    hx: number;
    hy: number;
}

/** The region outside the piece next to a corner, as convex pieces; `reach` bounds the tail. */
interface Cut {
    px: number;
    py: number;
    reach: number;
    regions: HalfPlane[][];
}

interface TailItem {
    range: IndexRange;
    polygons: ClipVertex[][];
    segment?: number;
    inStart: boolean;
    inEnd: boolean;
}

function halfPlane(extent: number, px: number, py: number, hx: number, hy: number): HalfPlane {
    return { extent, px, py, kx: -hy, ky: hx, hx, hy };
}

function flipped(plane: HalfPlane): HalfPlane {
    return { ...plane, hx: -plane.hx, hy: -plane.hy };
}

// Cutting away what lies past the neighbor's own boundary, rather than past a line
// through the corner, removes only stroke outside the piece: a short hook at either
// edge's end cannot cost outline inside it. Each segment of the neighbor contributes the
// strip just outside it, two extents deep; a vertex where the neighbor turns inward adds
// the wedge its two strips leave open. A segment running back against the neighbor's
// chord faces its outside into the corner, so it adds nothing.
function regionsBeyond(
    path: readonly Point[],
    interiorSide: 1 | -1,
    chord: Point,
    limit: number,
    extent: number,
): HalfPlane[][] {
    const regions: HalfPlane[][] = [];
    const depth = 2 * extent;
    let previous: { dx: number; dy: number; mx: number; my: number } | undefined;
    for (let j = 0; j + 1 < path.length; j++) {
        const a = path[j];
        const b = path[j + 1];
        if (Math.hypot(a.x - path[0].x, a.y - path[0].y) > limit) break;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length <= CLIP_EPSILON) continue;
        const dx = (b.x - a.x) / length;
        const dy = (b.y - a.y) / length;
        if (dx * chord.x + dy * chord.y <= 0) {
            previous = undefined;
            continue;
        }
        const mx = -interiorSide * dy;
        const my = interiorSide * dx;
        regions.push([
            halfPlane(extent, a.x, a.y, -mx, -my),
            halfPlane(extent, a.x - depth * mx, a.y - depth * my, mx, my),
            halfPlane(extent, a.x, a.y, dx, dy),
            halfPlane(extent, b.x, b.y, -dx, -dy),
        ]);
        if (previous && (previous.dx * dy - previous.dy * dx) * interiorSide > 0) {
            regions.push([
                halfPlane(extent, a.x, a.y, previous.dx, previous.dy),
                halfPlane(extent, a.x, a.y, -dx, -dy),
                halfPlane(extent, a.x - depth * previous.mx, a.y - depth * previous.my, previous.mx, previous.my),
                halfPlane(extent, a.x - depth * mx, a.y - depth * my, mx, my),
            ]);
        }
        previous = { dx, dy, mx, my };
    }
    return regions;
}

/**
 * `[fx, fy]` is the unit direction of the stroke's own segment leaving the corner p. The
 * corner counts as sharp when its chords or its first segments meet under 89°, as some
 * tips are sharp only within a stroke width of the point; a straight corner of angle θ
 * has its band leave the piece only within extent / sin θ of it.
 */
export function cornerCut(
    p: Point,
    [fx, fy]: [number, number],
    corner: StrokeCorner | undefined,
    extent: number,
): Cut | null {
    if (!corner) return null;
    const { own, neighbor, neighborPath, neighborInteriorSide } = corner;
    const cosChord = own.x * neighbor.x + own.y * neighbor.y;
    if (1 - cosChord < CLIP_EPSILON) return null;
    const first = neighborPath.find((q) => Math.hypot(q.x - p.x, q.y - p.y) > FIRST_POINT_EPSILON);
    if (!first) return null;
    const firstLength = Math.hypot(first.x - p.x, first.y - p.y);
    const cosFirst = (fx * (first.x - p.x) + fy * (first.y - p.y)) / firstLength;
    const cos = Math.max(cosChord, cosFirst);
    if (cos <= TIP_MIN_COS) return null;
    const reach = extent / Math.max(Math.sqrt(1 - Math.min(1, cos * cos)), MIN_SIN) + extent;
    const regions = regionsBeyond(neighborPath, neighborInteriorSide, neighbor, reach + extent, extent);
    const nx = (first.x - p.x) / firstLength;
    const ny = (first.y - p.y) / firstLength;
    // Behind the corner along the neighbor's first segment lies outside the corner's wedge
    // when every direction leaving the corner points ahead of that segment.
    const ahead = (x: number, y: number): boolean => x * nx + y * ny > 0;
    if (cosChord > 0 && ahead(fx, fy) && ahead(own.x, own.y) && ahead(neighbor.x, neighbor.y)) {
        const depth = 2 * extent;
        regions.push([
            halfPlane(extent, p.x, p.y, -nx, -ny),
            halfPlane(extent, p.x - depth * nx, p.y - depth * ny, nx, ny),
            halfPlane(extent, p.x - depth * ny, p.y + depth * nx, ny, -nx),
            halfPlane(extent, p.x + depth * ny, p.y - depth * nx, -ny, nx),
        ]);
    }
    return { px: p.x, py: p.y, reach, regions };
}

function keptDistance(v: ClipVertex, plane: HalfPlane): number {
    return (v.cx + v.wx * plane.extent - plane.px) * plane.hx + (v.cy + v.wy * plane.extent - plane.py) * plane.hy;
}

function area(polygon: readonly ClipVertex[], extent: number): number {
    let sum = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j];
        const b = polygon[i];
        sum += (a.cx + a.wx * extent) * (b.cy + b.wy * extent) - (b.cx + b.wx * extent) * (a.cy + a.wy * extent);
    }
    return Math.abs(sum) / 2;
}

function meshVertex(strip: Strip, index: number, onOffset: boolean): ClipVertex {
    return { ...strip.builder.at(index), index, onOffset };
}

function segmentPolygon(strip: Strip, i: number): ClipVertex[] {
    const center = (point: number): ClipVertex => ({
        cx: strip.points[point].x, cy: strip.points[point].y, wx: 0, wy: 0, side: 0, index: -1, onOffset: false, point,
    });
    const [a, b] = strip.segmentPairs[i];
    return [center(i), center(i + 1), meshVertex(strip, b + 1, true), meshVertex(strip, a + 1, true)];
}

// Clip points on a segment's centerline or interior offset line are placed where the
// boundary line meets that line, so they stay on it at every extent; only which lines
// it crosses is decided at the reference extent.
function crossing(strip: Strip, a: ClipVertex, b: ClipVertex, plane: HalfPlane, segment?: number): ClipVertex {
    if (segment !== undefined && a.onOffset && b.onOffset) {
        const [ex, ey] = strip.exteriors[segment];
        const along = -(plane.kx * ex + plane.ky * ey);
        if (Math.abs(along) > CLIP_EPSILON) {
            const origin = strip.points[segment];
            const s = -((origin.x - plane.px) * ex + (origin.y - plane.py) * ey) / along;
            return {
                cx: plane.px + s * plane.kx,
                cy: plane.py + s * plane.ky,
                wx: plane.kx / along,
                wy: plane.ky / along,
                side: -1,
                index: -1,
                onOffset: true,
            };
        }
    }
    const fa = keptDistance(a, plane);
    const t = fa / (fa - keptDistance(b, plane));
    const lerp = (p: number, q: number): number => p + (q - p) * t;
    return {
        cx: lerp(a.cx, b.cx),
        cy: lerp(a.cy, b.cy),
        wx: lerp(a.wx, b.wx),
        wy: lerp(a.wy, b.wy),
        side: lerp(a.side, b.side),
        index: -1,
        onOffset: a.onOffset && b.onOffset,
    };
}

function clip(strip: Strip, polygon: ClipVertex[], plane: HalfPlane, segment?: number): ClipVertex[] {
    const kept: ClipVertex[] = [];
    polygon.forEach((a, i) => {
        const b = polygon[(i + 1) % polygon.length];
        const aKept = keptDistance(a, plane) >= -CLIP_EPSILON;
        if (aKept) kept.push(a);
        if (aKept !== keptDistance(b, plane) >= -CLIP_EPSILON) kept.push(crossing(strip, a, b, plane, segment));
    });
    return kept;
}

function overlaps(strip: Strip, polygon: ClipVertex[], region: HalfPlane[], segment?: number): boolean {
    let inside = polygon;
    for (const plane of region) {
        inside = clip(strip, inside, plane, segment);
        if (area(inside, plane.extent) <= AREA_EPSILON) return false;
    }
    return true;
}

// A convex polygon minus a convex region: the parts outside each of its half-planes in turn.
function subtract(strip: Strip, polygons: ClipVertex[][], region: HalfPlane[], segment?: number): ClipVertex[][] {
    const out: ClipVertex[][] = [];
    for (const polygon of polygons) {
        if (!overlaps(strip, polygon, region, segment)) {
            out.push(polygon);
            continue;
        }
        let rest = polygon;
        for (const plane of region) {
            const outside = clip(strip, rest, flipped(plane), segment);
            if (area(outside, plane.extent) > AREA_EPSILON) out.push(outside);
            rest = clip(strip, rest, plane, segment);
            if (area(rest, plane.extent) <= AREA_EPSILON) break;
        }
    }
    return out;
}

// The tail ends before the first segment that lies wholly inside the piece and leaves
// the corner's stroke-width neighborhood, so a reversal a fraction of a unit long right
// at the corner does not end it.
function tailLength(strip: Strip, cut: Cut | null, extent: number, fromStart: boolean): number {
    if (!cut) return 0;
    const segmentCount = strip.segmentPairs.length;
    const distance = (point: Point): number => Math.hypot(point.x - cut.px, point.y - cut.py);
    let length = 0;
    for (let n = 0; n < segmentCount; n++) {
        const near = strip.points[fromStart ? n : segmentCount - n];
        const far = strip.points[fromStart ? n + 1 : segmentCount - n - 1];
        if (distance(near) > cut.reach) break;
        const segment = fromStart ? n : segmentCount - 1 - n;
        const polygon = segmentPolygon(strip, segment);
        if (cut.regions.some((region) => overlaps(strip, polygon, region, segment))) length = n + 1;
        else if (distance(far) > extent) break;
    }
    return length;
}

function cutTriangles(strip: ClipStrip, item: TailItem, cuts: Cut[]): number[] {
    const triangles: number[] = [];
    for (const polygon of item.polygons) {
        let pieces = [polygon];
        for (const cut of cuts) {
            for (const region of cut.regions) pieces = subtract(strip, pieces, region, item.segment);
        }
        for (const piece of pieces) {
            const indices = piece.map((v) => vertexIndex(strip, v));
            for (let i = 2; i < indices.length; i++) triangles.push(indices[0], indices[i - 1], indices[i]);
        }
    }
    return triangles;
}

function vertexIndex(strip: ClipStrip, v: ClipVertex): number {
    if (v.index >= 0) return v.index;
    if (v.point === undefined) {
        v.index = strip.builder.point(v);
    } else {
        v.index = strip.centerIndices.get(v.point) ?? strip.builder.point(v);
        strip.centerIndices.set(v.point, v.index);
    }
    return v.index;
}

function tailItems(strip: Strip, startLength: number, endLength: number): TailItem[] {
    const segmentCount = strip.segmentPairs.length;
    const items: TailItem[] = [];
    for (let i = 0; i < segmentCount; i++) {
        const inStart = i < startLength;
        const inEnd = i >= segmentCount - endLength;
        if (!inStart && !inEnd) continue;
        items.push({ range: strip.segmentRanges[i], polygons: [segmentPolygon(strip, i)], segment: i, inStart, inEnd });
    }
    for (const [joint, { range, interior }] of strip.fans) {
        const inStart = joint <= startLength;
        const inEnd = joint >= segmentCount - endLength;
        if (!inStart && !inEnd) continue;
        const triangles = interior ? strip.builder.trianglesIn(range) : [];
        const polygons: ClipVertex[][] = [];
        for (let t = 0; t < triangles.length; t += 3) {
            polygons.push(triangles.slice(t, t + 3).map((index) => meshVertex(strip, index, false)));
        }
        items.push({ range, polygons, inStart, inEnd });
    }
    return items;
}

// Ends whose tails share segments are cut together, so each combination of cut ends
// gets its own replacement for the whole tail.
export function innerTails(strip: Strip, startCut: Cut | null, endCut: Cut | null, extent: number): InnerTails {
    const startLength = tailLength(strip, startCut, extent, true);
    const endLength = tailLength(strip, endCut, extent, false);
    if (startLength === 0 && endLength === 0) return NO_TAILS;
    const clipStrip: ClipStrip = { ...strip, centerIndices: new Map() };
    const tail: IndexRange[] = [];
    const tails: InnerTails = { tail, start: [], end: [], both: [] };
    for (const item of tailItems(strip, startLength, endLength)) {
        const band = strip.builder.trianglesIn(item.range);
        const atStart = item.inStart ? cutTriangles(clipStrip, item, [startCut!]) : null;
        const atEnd = item.inEnd ? cutTriangles(clipStrip, item, [endCut!]) : null;
        tail.push(item.range);
        tails.start.push(...(atStart ?? band));
        tails.end.push(...(atEnd ?? band));
        if (atStart && atEnd) tails.both.push(...cutTriangles(clipStrip, item, [startCut!, endCut!]));
        else tails.both.push(...(atStart ?? atEnd!));
    }
    if (startLength === 0) tails.start = [];
    if (endLength === 0) tails.end = [];
    if (startLength === 0 || endLength === 0) tails.both = [];
    return tails;
}
