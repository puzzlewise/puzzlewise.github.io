import earcut from 'earcut';
import { CHAIN_EPSILON, edgePathD } from '../../model/build-shape.js';
import type { Edge, Piece, PieceBounds, Point } from '../../model/types.js';
import { flattenPath } from './path-flatten.js';
import {
    buildStrokeMesh,
    type CornerDirections,
    OUTLINE_HALF_WIDTH,
    simplifyPolyline,
    type StrokeMesh,
    type StrokeNeighbors,
} from './stroke-mesh.js';

export interface PieceMesh {
    pieceId: number;
    /** Piece-local xy pairs. */
    fillVertices: Float32Array;
    fillIndices: Uint32Array;
    /** For hit-testing, even-odd. */
    loops: Point[][];
    bounds: PieceBounds;
    /** Outlines of one loop are contiguous, in boundary order. */
    edgeOutlines: EdgeOutline[];
    tolerance: number;
    fillOmitted: boolean;
    fillError?: unknown;
}

export interface EdgeOutline {
    edgeId: number;
    polyline: Point[];
    interiorSide: 1 | -1;
    loop: number;
}

interface EdgeLoop {
    edges: Edge[];
    polylines: Point[][];
    points: Point[];
}

function signedArea(loop: Point[]): number {
    let sum = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        sum += loop[j].x * loop[i].y - loop[i].x * loop[j].y;
    }
    return sum / 2;
}

export function insideEvenOdd(loops: readonly Point[][], x: number, y: number): boolean {
    let inside = false;
    for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const a = loop[i];
            const b = loop[j];
            if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }
    }
    return inside;
}

function distanceToLoop(loop: Point[], p: Point): number {
    let best = Infinity;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const a = loop[j];
        const b = loop[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
    return best;
}

const BOUNDARY_EPSILON = 1e-4;
// Strokes only: fills keep every flattened point so mate seams stay bit-identical.
const STROKE_SIMPLIFY_FRACTION = 0.25;
const DIRECTION_EPSILON = 1e-9;
// World units: half a CSS pixel at the maximum zoom of 5.
export const FLATTEN_TOLERANCE = 0.1;

// earcut turns quadratic or worse on comb-shaped and dense outlines (#759).
// Compactness is perimeter² / 4π·area.
export const SPIKY_MIN_POINTS = 1024;
export const MAX_COMPACTNESS = 64;
export const MAX_FILL_POINTS = 3000;

// Sibling regions of a piece often touch along shared edges, so a vertex of
// `inner` can lie on `outer`'s boundary; only a vertex clear of it is decisive.
function loopInside(inner: Point[], outer: Point[]): boolean {
    const probe = inner.find(p => distanceToLoop(outer, p) > BOUNDARY_EPSILON);
    return probe !== undefined && insideEvenOdd([outer], probe.x, probe.y);
}

interface LoopClassification {
    depth: number[];
    containers: number[][];
}

function classifyLoops(loops: Point[][]): LoopClassification {
    const area = loops.map(loop => Math.abs(signedArea(loop)));
    const containers = loops.map((loop, i) =>
        loops.flatMap((other, j) => (j !== i && area[j] > area[i] && loopInside(loop, other) ? [j] : [])));
    return { depth: containers.map(c => c.length), containers };
}

function chainLoops(piece: Piece, tolerance: number): EdgeLoop[] {
    const loops: EdgeLoop[] = [];
    let current: EdgeLoop | null = null;
    let prevEnd: Point | null = null;
    for (const edge of piece.edges) {
        const polyline = flattenPath(edgePathD(edge), tolerance)[0];
        if (polyline === undefined) continue;
        const continuesChain = prevEnd !== null
            && Math.abs(prevEnd.x - edge.start.x) < CHAIN_EPSILON
            && Math.abs(prevEnd.y - edge.start.y) < CHAIN_EPSILON;
        if (!continuesChain || current === null) {
            current = { edges: [], polylines: [], points: [] };
            loops.push(current);
        }
        current.edges.push(edge);
        current.polylines.push(polyline);
        current.points.push(...(current.points.length === 0 ? polyline : polyline.slice(1)));
        prevEnd = edge.end;
    }
    for (const loop of loops) {
        const first = loop.points[0];
        const last = loop.points[loop.points.length - 1];
        if (loop.points.length > 1 && first.x === last.x && first.y === last.y) loop.points.pop();
    }
    return loops;
}

function boundsOf(loops: Point[][]): PieceBounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const loop of loops) {
        for (const p of loop) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
    }
    return { minX, minY, maxX, maxY };
}

export function measureOutlineGroup(group: readonly Point[][]): { points: number; compactness: number } {
    let points = 0;
    let perimeter = 0;
    let area = 0;
    group.forEach((loop, k) => {
        points += loop.length;
        area += (k === 0 ? 1 : -1) * Math.abs(signedArea(loop));
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            perimeter += Math.hypot(loop[i].x - loop[j].x, loop[i].y - loop[j].y);
        }
    });
    return { points, compactness: area > 0 ? (perimeter * perimeter) / (4 * Math.PI * area) : Infinity };
}

function fillable(group: Point[][]): boolean {
    const { points, compactness } = measureOutlineGroup(group);
    if (points > MAX_FILL_POINTS) return false;
    return points <= SPIKY_MIN_POINTS || compactness <= MAX_COMPACTNESS;
}

const NO_FILL = { vertices: new Float32Array(0), indices: new Uint32Array(0) };

function fillGroups(loops: Point[][], { depth, containers }: LoopClassification): Point[][][] {
    return loops.flatMap((outer, i) => (depth[i] % 2 !== 0 ? [] : [[
        outer,
        ...loops.filter((_, j) => depth[j] === depth[i] + 1 && containers[j].includes(i)),
    ]]));
}

export function outlineGroups(loops: Point[][]): Point[][][] {
    return fillGroups(loops, classifyLoops(loops));
}

function triangulate(
    loops: Point[][],
    classification: LoopClassification,
): { vertices: Float32Array; indices: Uint32Array } | null {
    const groups = fillGroups(loops, classification);
    if (!groups.every(fillable)) return null;
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const group of groups) {
        const flat: number[] = [];
        const holeStarts: number[] = [];
        for (const loop of group) {
            if (loop !== group[0]) holeStarts.push(flat.length / 2);
            for (const p of loop) flat.push(p.x, p.y);
        }
        const base = vertices.length / 2;
        for (const v of flat) vertices.push(v);
        for (const index of earcut(flat, holeStarts)) indices.push(base + index);
    }
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

export function buildPieceFill(piece: Piece, tolerance: number, triangulateFill = true): PieceMesh {
    const edgeLoops = chainLoops(piece, tolerance);
    const loops = edgeLoops.map(loop => loop.points);
    const areas = loops.map(signedArea);
    const classification = classifyLoops(loops);
    const { depth } = classification;

    const edgeOutlines: EdgeOutline[] = [];
    edgeLoops.forEach((loop, i) => {
        const counterClockwise = areas[i] > 0;
        const isHole = depth[i] % 2 !== 0;
        // The loop's own interior is on the left when it winds counterclockwise;
        // a hole's piece interior is outside its loop.
        const interiorSide = counterClockwise !== isHole ? 1 : -1;
        loop.edges.forEach((edge, k) => {
            edgeOutlines.push({ edgeId: edge.id, polyline: loop.polylines[k], interiorSide, loop: i });
        });
    });

    let fill: { vertices: Float32Array; indices: Uint32Array } | null = null;
    let fillError: unknown;
    try {
        if (triangulateFill) fill = triangulate(loops, classification);
    } catch (error) {
        fillError = error;
    }
    const { vertices, indices } = fill ?? NO_FILL;
    return {
        pieceId: piece.id,
        fillVertices: vertices,
        fillIndices: indices,
        loops,
        bounds: boundsOf(loops),
        edgeOutlines,
        tolerance,
        fillOmitted: fill === null,
        ...(fillError === undefined ? {} : { fillError }),
    };
}

export function emptyPieceMesh(piece: Piece, tolerance: number, fillError: unknown): PieceMesh {
    return {
        pieceId: piece.id,
        fillVertices: new Float32Array(0),
        fillIndices: new Uint32Array(0),
        loops: [],
        bounds: piece.bounds,
        edgeOutlines: [],
        tolerance,
        fillOmitted: true,
        fillError,
    };
}

export function buildPieceStrokes(mesh: PieceMesh): Map<number, StrokeMesh> {
    const outlines = mesh.edgeOutlines;
    const neighbors = loopNeighbors(outlines);
    const corners = mesh.fillOmitted ? undefined : outlines.map((_, k) => endCorner(outlines, k, neighbors.next[k]));
    const strokes = new Map<number, StrokeMesh>();
    outlines.forEach(({ edgeId, polyline, interiorSide }, k) => {
        const simplified = simplifyPolyline(polyline, mesh.tolerance * STROKE_SIMPLIFY_FRACTION);
        const cut = corners ? cornerNeighbors(outlines, corners, neighbors.prev[k], k, neighbors.next[k]) : {};
        strokes.set(edgeId, buildStrokeMesh(simplified, false, interiorSide, cut));
    });
    return strokes;
}

function cornerNeighbors(
    outlines: readonly EdgeOutline[],
    corners: readonly (Corner | undefined)[],
    prev: number,
    k: number,
    next: number,
): StrokeNeighbors {
    const start = corners[prev];
    const end = corners[k];
    return {
        start: start?.convex ? {
            own: start.neighbor,
            neighbor: start.own,
            neighborPath: [...outlines[prev].polyline].reverse(),
            neighborInteriorSide: -outlines[prev].interiorSide as 1 | -1,
        } : undefined,
        end: end?.convex ? {
            own: end.own,
            neighbor: end.neighbor,
            neighborPath: outlines[next].polyline,
            neighborInteriorSide: outlines[next].interiorSide,
        } : undefined,
    };
}

export function loopNeighbors(outlines: readonly EdgeOutline[]): { prev: number[]; next: number[] } {
    const prev: number[] = [];
    const next: number[] = [];
    for (let first = 0; first < outlines.length;) {
        let last = first;
        while (outlines[last + 1]?.loop === outlines[first].loop) last++;
        for (let k = first; k <= last; k++) {
            prev[k] = k === first ? last : k - 1;
            next[k] = k === last ? first : k + 1;
        }
        first = last + 1;
    }
    return { prev, next };
}

export interface Corner extends CornerDirections {
    convex: boolean;
}

/**
 * The corner where outline `k` ends and the next outline of its loop starts; undefined
 * when they do not meet or either side has no length. Its directions are chords a stroke
 * width long, so a hook at an edge's end shorter than the stroke is wide does not decide it.
 */
export function endCorner(outlines: readonly EdgeOutline[], k: number, next: number): Corner | undefined {
    const a = outlines[k];
    const b = outlines[next];
    const corner = a.polyline[a.polyline.length - 1];
    const start = b.polyline[0];
    if (!corner || !start || Math.abs(start.x - corner.x) >= CHAIN_EPSILON || Math.abs(start.y - corner.y) >= CHAIN_EPSILON) {
        return undefined;
    }
    const own = chordDirection([...a.polyline].reverse(), corner);
    const neighbor = chordDirection(b.polyline, corner);
    if (!own || !neighbor) return undefined;
    const convex = (neighbor.x * own.y - neighbor.y * own.x) * a.interiorSide > 0;
    return { own, neighbor, convex };
}

function chordDirection(polyline: readonly Point[], from: Point): Point | undefined {
    let to = from;
    for (const p of polyline) {
        to = p;
        if (Math.hypot(p.x - from.x, p.y - from.y) >= OUTLINE_HALF_WIDTH) break;
    }
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length <= DIRECTION_EPSILON) return undefined;
    return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}
