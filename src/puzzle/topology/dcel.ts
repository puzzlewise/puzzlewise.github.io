/**
 * Given curves that may intersect, finds all enclosed faces — each
 * becomes a puzzle piece. See issue #168 for the design discussion.
 */

import type { Point } from '../../model/types.js';
import { Curve } from './curve.js';
import type { CurveIntersection, BoundingBox } from './curve.js';
import { findComponents } from './components.js';
import { assignHoles } from './holes.js';
import { walkLoop } from './half-edge-loop.js';

export interface Vertex {
    id: number;
    position: Point;
    /** One of the outgoing half-edges (for traversal entry). */
    outgoing: HalfEdge | null;
}

export interface HalfEdge {
    id: number;
    origin: Vertex;
    twin: HalfEdge;
    next: HalfEdge;
    prev: HalfEdge;
    face: Face | null;
    /** Curve this half-edge represents, in its direction of travel. */
    curve: Curve;
}

/**
 * Construction-only shape: the cyclic fields (`twin`, `next`, `prev`)
 * can't be set at allocation, so they start null and are wired by
 * `makeTwinPair` (twins) and `linkHalfEdges` (next/prev), then narrowed
 * to `HalfEdge`.
 */
interface MutableHalfEdge {
    id: number;
    origin: Vertex;
    twin: MutableHalfEdge | null;
    next: MutableHalfEdge | null;
    prev: MutableHalfEdge | null;
    face: Face | null;
    curve: Curve;
}

export interface Face {
    id: number;
    /** One of the half-edges on this face's boundary. */
    outerEdge: HalfEdge;
    /** Whether this is the unbounded outer face. */
    isOuter: boolean;
    /**
     * One starting half-edge per inner-boundary (hole) loop; walk .next
     * to collect each loop. Empty for faces without holes.
     */
    innerBoundaries: HalfEdge[];
}

export interface CutSet {
    curves: Curve[];
    /**
     * Groups of curves known not to intersect; the builder skips
     * intersection checks within each group.
     */
    nonIntersectingGroups?: Curve[][];
}

/**
 * DCEL (Doubly-Connected Edge List): vertices (intersection points),
 * half-edges (oriented arcs carrying a curve), faces (regions enclosed
 * by half-edge cycles). Built once from the input cuts, then never
 * re-derived — later stages operate on it directly.
 */
export interface TopologyGraph {
    vertices: Vertex[];
    halfEdges: HalfEdge[];
    faces: Face[];
    outerFace: Face;
}

/** Distance threshold for merging nearby vertices. */
const VERTEX_MERGE_TOLERANCE = 3;

export function buildDCEL(cutSet: CutSet): TopologyGraph {
    const { curves, nonIntersectingGroups } = cutSet;

    const allIntersections = findAllIntersections(
        curves, nonIntersectingGroups,
    );

    let segments = splitCurvesAtIntersections(curves, allIntersections);

    segments = splitClosedCurves(segments);

    const vertexMap = new VertexPool();
    const halfEdges: HalfEdge[] = [];
    let nextHalfEdgeId = 0;

    for (const segment of segments) {
        const originVertex = vertexMap.getOrCreate(segment.start);
        const targetVertex = vertexMap.getOrCreate(segment.end);

        // Skip zero-length segments
        if (originVertex === targetVertex) continue;

        const [he1, he2] = makeTwinPair(
            nextHalfEdgeId, nextHalfEdgeId + 1,
            originVertex, targetVertex, segment,
        );
        nextHalfEdgeId += 2;

        halfEdges.push(he1, he2);

        if (!originVertex.outgoing) originVertex.outgoing = he1;
        if (!targetVertex.outgoing) targetVertex.outgoing = he2;
    }

    const vertices = vertexMap.all();

    linkHalfEdges(vertices, halfEdges);

    const faces = discoverFaces(halfEdges);

    const outerFace = identifyOuterFace(faces);

    const result: TopologyGraph = { vertices, halfEdges, faces, outerFace };
    const components = findComponents(result);
    assignHoles(result, components);
    return result;
}

interface CurveIntersectionRecord {
    curveIndexA: number;
    curveIndexB: number;
    intersection: CurveIntersection;
}

function findAllIntersections(
    curves: Curve[],
    nonIntersectingGroups?: Curve[][],
): CurveIntersectionRecord[] {
    const results: CurveIntersectionRecord[] = [];

    const skipPairs = new Set<string>();
    if (nonIntersectingGroups) {
        for (const group of nonIntersectingGroups) {
            const indices = group.map(c => curves.indexOf(c)).filter(i => i >= 0);
            for (let i = 0; i < indices.length; i++) {
                for (let j = i + 1; j < indices.length; j++) {
                    skipPairs.add(`${indices[i]},${indices[j]}`);
                }
            }
        }
    }

    // Spatial broad-phase: test only curve pairs whose boxes are close
    // enough to possibly produce a result, in ascending (i, j) order —
    // identical to the old n²/2 loop minus provably-empty pairs, so the
    // results array and its order-dependent T-junction dedup stay
    // byte-for-byte the same. See curveBroadPhasePairs for the margin proof.
    const boxes = curves.map(c => c.boundingBox());
    const pairs = curveBroadPhasePairs(boxes, BROAD_PHASE_MARGIN);

    for (const [i, j] of pairs) {
        if (skipPairs.has(`${i},${j}`)) continue;

        const intersections = curves[i].intersect(curves[j]);
        for (const ix of intersections) {
            results.push({
                curveIndexA: i,
                curveIndexB: j,
                intersection: ix,
            });
        }

        // T-junction: an endpoint of one curve lying on the other (e.g.
        // an internal cut meeting the border).
        addEndpointOnCurve(curves[i], curves[j], i, j, results);
        addEndpointOnCurve(curves[j], curves[i], j, i, results);
    }

    return results;
}

/**
 * Broad-phase proximity margin, in pixels. A pair can only produce a
 * result within this distance — curve-curve crossings need overlapping
 * segment boxes (0.5px), T-junctions need an endpoint within
 * `2 · VERTEX_MERGE_TOLERANCE` — so the margin covers the larger and any
 * skipped pair provably produces nothing.
 */
const BROAD_PHASE_MARGIN = 2 * VERTEX_MERGE_TOLERANCE;

/**
 * Lower bound on the broad-phase grid cell size, in pixels. Floors the
 * extent-derived cell size so a degenerate all-points input can't collapse
 * the grid to a zero-width cell. The value is arbitrary (cell size never
 * affects correctness, only pruning tightness) and unrelated to
 * VERTEX_MERGE_TOLERANCE despite sharing the value 3.
 */
const MIN_CELL = 3;

/**
 * Conservative spatial broad-phase over curve bounding boxes. Returns
 * curve-index pairs (i < j) whose boxes lie within `margin`, in ascending
 * (i, j) order; any pair not returned is separated by more than `margin`
 * in some axis, so skipping it changes no output.
 *
 * Method: a uniform grid sized to the average curve extent; each curve is
 * rasterized into every cell its margin-expanded box covers, so two curves
 * within `margin` share a cell. Co-occupants are the candidate pairs,
 * sorted to reproduce the original loop's exact (i, j) ordering.
 *
 * Exported for the broad-phase unit test in dcel.test.ts; not public API.
 */
export function curveBroadPhasePairs(
    boxes: BoundingBox[],
    margin: number,
): Array<[number, number]> {
    const n = boxes.length;
    if (n < 2) return [];

    // Cell size = average box max-extent, floored at MIN_CELL so degenerate
    // (point) inputs don't collapse it to ~0. For our distribution
    // (lattice-scale curves + a few full-span borders) this stays ~linear.
    // Worst case — many large mutually-overlapping curves — degrades toward
    // O(n²) pairs, but no current generator emits that geometry.
    let extentSum = 0;
    for (const b of boxes) {
        extentSum += Math.max(b.maxX - b.minX, b.maxY - b.minY);
    }
    const cell = Math.max(extentSum / n, MIN_CELL);

    const grid = new Map<string, number[]>();
    const seen = new Set<number>();
    const pairs: Array<[number, number]> = [];

    for (let i = 0; i < n; i++) {
        const b = boxes[i];
        const gx0 = Math.floor((b.minX - margin) / cell);
        const gx1 = Math.floor((b.maxX + margin) / cell);
        const gy0 = Math.floor((b.minY - margin) / cell);
        const gy1 = Math.floor((b.maxY + margin) / cell);

        for (let gx = gx0; gx <= gx1; gx++) {
            for (let gy = gy0; gy <= gy1; gy++) {
                const key = `${gx},${gy}`;
                const occupants = grid.get(key);
                if (!occupants) {
                    grid.set(key, [i]);
                    continue;
                }
                for (const j of occupants) {
                    // Occupants were inserted earlier, so j < i: emit (j, i).
                    const pairKey = j * n + i;
                    if (!seen.has(pairKey)) {
                        seen.add(pairKey);
                        pairs.push([j, i]);
                    }
                }
                occupants.push(i);
            }
        }
    }

    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return pairs;
}

/**
 * Curve A endpoints lying on curve B are added as intersection
 * records (T-junctions).
 */
function addEndpointOnCurve(
    curveA: Curve,
    curveB: Curve,
    indexA: number,
    indexB: number,
    results: CurveIntersectionRecord[],
): void {
    const lastSeg = curveA.segments.length - 1;
    const endpoints = [
        { point: curveA.start, tA: 0, segA: 0, tLocalA: 0 },
        { point: curveA.end, tA: 1, segA: lastSeg, tLocalA: 1 },
    ];

    for (const { point, tA, segA, tLocalA } of endpoints) {
        const result = findPointOnCurve(curveB, point);
        if (result === null) continue;

        // Skip shared endpoints (both curves meet at their own endpoint).
        if ((result.globalT < 1e-4 || result.globalT > 1 - 1e-4) &&
            (tA < 1e-4 || tA > 1 - 1e-4)) {
            continue;
        }

        const isDuplicate = results.some(
            r => pointDist(r.intersection.point, point) < VERTEX_MERGE_TOLERANCE,
        );
        if (isDuplicate) continue;

        results.push({
            curveIndexA: indexA,
            curveIndexB: indexB,
            intersection: {
                point,
                tSelf: tA,
                tOther: result.globalT,
                segSelf: segA,
                tLocalSelf: tLocalA,
                segOther: result.segmentIndex,
                tLocalOther: result.localT,
            },
        });
    }
}

interface PointOnCurveResult {
    globalT: number;
    segmentIndex: number;
    localT: number;
}

/**
 * Where a point lies on a curve (within tolerance), or null. Returns
 * global t plus segment-level info for precise splitting.
 */
function findPointOnCurve(curve: Curve, point: Point): PointOnCurveResult | null {
    const n = curve.segments.length;
    let bestSeg = 0;
    let bestLocalT = 0;
    let bestDist = Infinity;

    for (let i = 0; i < n; i++) {
        const proj = curve['beziers'][i].project({ x: point.x, y: point.y });
        const d = pointDist(proj, point);
        if (d < bestDist) {
            bestDist = d;
            bestSeg = i;
            bestLocalT = proj.t ?? 0;
        }
    }

    if (bestDist >= VERTEX_MERGE_TOLERANCE * 2) return null;

    return {
        globalT: (bestSeg + bestLocalT) / n,
        segmentIndex: bestSeg,
        localT: bestLocalT,
    };
}

/**
 * A split point identified by segment index + local t (exact, no
 * global-t conversion).
 */
interface SegmentSplit {
    segmentIndex: number;
    localT: number;
}

function splitCurvesAtIntersections(
    curves: Curve[],
    intersections: CurveIntersectionRecord[],
): Curve[] {
    // Segment-level splits (exact Bézier segment + local t), avoiding
    // global-t round-trip imprecision.
    const splitsByCurve: Map<number, SegmentSplit[]> = new Map();

    for (const record of intersections) {
        const { curveIndexA, curveIndexB, intersection } = record;

        if (!splitsByCurve.has(curveIndexA)) splitsByCurve.set(curveIndexA, []);
        if (!splitsByCurve.has(curveIndexB)) splitsByCurve.set(curveIndexB, []);

        splitsByCurve.get(curveIndexA)!.push({
            segmentIndex: intersection.segSelf,
            localT: intersection.tLocalSelf,
        });
        splitsByCurve.get(curveIndexB)!.push({
            segmentIndex: intersection.segOther,
            localT: intersection.tLocalOther,
        });
    }

    const allSegments: Curve[] = [];

    for (let i = 0; i < curves.length; i++) {
        const splits = splitsByCurve.get(i);
        if (!splits || splits.length === 0) {
            allSegments.push(curves[i]);
            continue;
        }

        const numSegs = curves[i].segments.length;

        const filtered = splits.filter(s =>
            !(s.segmentIndex === 0 && s.localT < 1e-4) &&
            !(s.segmentIndex === numSegs - 1 && s.localT > 1 - 1e-4),
        );

        filtered.sort((a, b) =>
            a.segmentIndex !== b.segmentIndex
                ? a.segmentIndex - b.segmentIndex
                : a.localT - b.localT,
        );

        const deduped: SegmentSplit[] = [];
        for (const s of filtered) {
            const last = deduped[deduped.length - 1];
            if (last && last.segmentIndex === s.segmentIndex &&
                Math.abs(last.localT - s.localT) < 1e-3) {
                continue;
            }
            deduped.push(s);
        }

        if (deduped.length === 0) {
            allSegments.push(curves[i]);
            continue;
        }

        // Split end-to-start to preserve segment indices; when multiple
        // splits hit one segment, remap localT after each (segment shrinks).
        let current = curves[i];
        const pieces: Curve[] = [];

        // Track the consumed portion of each segment to remap later splits
        // on the same segment.
        let lastSplitSeg = -1;
        let lastSplitLocalT = 1; // upper bound of remaining segment

        for (let j = deduped.length - 1; j >= 0; j--) {
            const { segmentIndex, localT } = deduped[j];

            let adjustedLocalT: number;
            if (segmentIndex === lastSplitSeg) {
                // Previous split truncated this segment at lastSplitLocalT;
                // remap localT from [0, lastSplitLocalT] → [0, 1].
                adjustedLocalT = localT / lastSplitLocalT;
            } else {
                adjustedLocalT = localT;
                lastSplitSeg = segmentIndex;
            }
            lastSplitLocalT = localT; // in original segment space

            const [before, after] = current.splitAtSegmentLocal(segmentIndex, adjustedLocalT);
            pieces.unshift(after);
            current = before;
        }
        pieces.unshift(current);

        allSegments.push(...pieces);
    }

    return allSegments;
}

/**
 * Split still-closed curves (start === end within VERTEX_MERGE_TOLERANCE)
 * at t=0.5 into two half-edges. Runs AFTER intersection-splitting: only
 * free-floating closed inputs (e.g. an isolated `Curve.circle`) survive
 * still-closed, and the DCEL would otherwise reject them as zero-length
 * self-loops. The t=0.5 split is arbitrary; fine for current generators.
 */
function splitClosedCurves(segments: Curve[]): Curve[] {
    const result: Curve[] = [];

    for (const segment of segments) {
        const startDist = pointDist(segment.start, segment.end);
        if (startDist < VERTEX_MERGE_TOLERANCE) {
            const [first, second] = segment.splitAt(0.5);
            result.push(first, second);
        } else {
            result.push(segment);
        }
    }

    return result;
}

/**
 * Tolerance-based vertex dedup via a spatial hash. Buckets vertices into
 * a uniform grid with cell size {@link VERTEX_MERGE_TOLERANCE}; a query
 * point can only merge within its own cell or the 8 neighbors (cell size =
 * merge radius), so lookup is O(1) amortized vs a naive O(V²) scan.
 *
 * Byte-identity with the old linear scan (preserves the share-link
 * contract): among vertices within tolerance the scan took the first
 * inserted = lowest id, which is what {@link getOrCreate} picks across the
 * 9 cells.
 *
 * Exported for the merge-equivalence test in dcel.test.ts; not public API.
 */
export class VertexPool {
    private vertices: Vertex[] = [];
    private nextId = 0;
    /** cellKey → vertices whose position falls in that cell. */
    private buckets = new Map<string, Vertex[]>();

    getOrCreate(point: Point): Vertex {
        const cx = Math.floor(point.x / VERTEX_MERGE_TOLERANCE);
        const cy = Math.floor(point.y / VERTEX_MERGE_TOLERANCE);

        // Scan the cell + 8 neighbors; pick the lowest-id vertex within
        // tolerance to match the old scan's "first inserted wins".
        let best: Vertex | null = null;
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
            for (let gy = cy - 1; gy <= cy + 1; gy++) {
                const bucket = this.buckets.get(`${gx},${gy}`);
                if (!bucket) continue;
                for (const v of bucket) {
                    if (pointDist(v.position, point) < VERTEX_MERGE_TOLERANCE &&
                        (best === null || v.id < best.id)) {
                        best = v;
                    }
                }
            }
        }
        if (best !== null) return best;

        const v: Vertex = {
            id: this.nextId++,
            position: { x: point.x, y: point.y },
            outgoing: null,
        };
        this.vertices.push(v);
        const key = `${cx},${cy}`;
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(v);
        else this.buckets.set(key, [v]);
        return v;
    }

    all(): Vertex[] {
        return this.vertices;
    }
}

/**
 * Allocate a twin half-edge pair for a segment. Wires the `twin` field
 * (unsettable at allocation) and seeds `next`/`prev` as self-pointers;
 * `linkHalfEdges` overwrites those once the angular ordering is known.
 * Narrowed to `HalfEdge` — all cyclic fields are non-null on return.
 */
function makeTwinPair(
    id1: number,
    id2: number,
    originA: Vertex,
    originB: Vertex,
    curve: Curve,
): [HalfEdge, HalfEdge] {
    const he1: MutableHalfEdge = {
        id: id1, origin: originA, curve,
        twin: null, next: null, prev: null, face: null,
    };
    const he2: MutableHalfEdge = {
        id: id2, origin: originB, curve: curve.reverse(),
        twin: null, next: null, prev: null, face: null,
    };
    he1.twin = he2;
    he2.twin = he1;
    he1.next = he1; he1.prev = he1;
    he2.next = he2; he2.prev = he2;
    return [he1 as HalfEdge, he2 as HalfEdge];
}

function linkHalfEdges(_vertices: Vertex[], halfEdges: HalfEdge[]): void {
    const outgoingByVertex = new Map<number, HalfEdge[]>();

    for (const he of halfEdges) {
        const vid = he.origin.id;
        if (!outgoingByVertex.has(vid)) outgoingByVertex.set(vid, []);
        outgoingByVertex.get(vid)!.push(he);
    }

    // Screen coords (Y-down): atan2 ascending = CW visual order. For CW
    // inner-face traversal we take the rightmost turn at each vertex:
    // outgoing[i].twin.next = outgoing[i-1] (previous edge in CW order).
    for (const [_vid, outgoing] of outgoingByVertex) {
        if (outgoing.length <= 1) {
            if (outgoing.length === 1) {
                outgoing[0].twin.next = outgoing[0];
                outgoing[0].prev = outgoing[0].twin;
            }
            continue;
        }

        outgoing.sort((a, b) => outgoingAngle(a) - outgoingAngle(b));

        const n = outgoing.length;
        for (let i = 0; i < n; i++) {
            const prevInCW = outgoing[(i - 1 + n) % n];
            outgoing[i].twin.next = prevInCW;
            prevInCW.prev = outgoing[i].twin;
        }
    }
}

function outgoingAngle(he: HalfEdge): number {
    const t = he.curve.tangentAt(0);
    return Math.atan2(t.y, t.x);
}

function discoverFaces(halfEdges: HalfEdge[]): Face[] {
    const visited = new Set<number>();
    const faces: Face[] = [];
    let nextFaceId = 0;

    for (const he of halfEdges) {
        if (visited.has(he.id)) continue;

        const face: Face = {
            id: nextFaceId++,
            outerEdge: he,
            isOuter: false,
            innerBoundaries: [],
        };

        for (const current of walkLoop(he)) {
            visited.add(current.id);
            current.face = face;
        }

        faces.push(face);
    }

    return faces;
}

function identifyOuterFace(faces: Face[]): Face {
    // Outer face = most negative signed area (CW winding, Y-down screen coords).
    let outerFace = faces[0];
    let mostNegativeArea = Infinity;

    for (const face of faces) {
        const area = computeSignedArea(face);
        if (area < mostNegativeArea) {
            mostNegativeArea = area;
            outerFace = face;
        }
    }

    outerFace.isOuter = true;
    return outerFace;
}

/**
 * Signed area in screen coords (Y-down): positive = CCW (inner face),
 * negative = CW (outer face).
 */
function computeSignedArea(face: Face): number {
    let area = 0;
    for (const current of walkLoop(face.outerEdge)) {
        const a = current.origin.position;
        const b = current.twin.origin.position;
        area += (a.x * b.y - b.x * a.y);
    }
    return area / 2;
}

export function getFaceVertices(face: Face): Point[] {
    return walkLoop(face.outerEdge).map(he => he.origin.position);
}

export function getFaceEdges(face: Face): HalfEdge[] {
    return walkLoop(face.outerEdge);
}

export function countFaceEdges(face: Face): number {
    return walkLoop(face.outerEdge).length;
}

function pointDist(a: Point, b: Point): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

