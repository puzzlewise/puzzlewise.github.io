import earcut from 'earcut';
import { CHAIN_EPSILON, edgePathD } from '../../model/build-shape.js';
import type { Edge, Piece, PieceBounds, Point } from '../../model/types.js';
import { flattenPath } from './path-flatten.js';
import { buildStrokeMesh, simplifyPolyline, type StrokeMesh } from './stroke-mesh.js';

export interface PieceMesh {
    pieceId: number;
    /** Piece-local xy pairs. */
    fillVertices: Float32Array;
    fillIndices: Uint32Array;
    /** For hit-testing, even-odd. */
    loops: Point[][];
    bounds: PieceBounds;
    edgeOutlines: EdgeOutline[];
    tolerance: number;
}

export interface EdgeOutline {
    edgeId: number;
    polyline: Point[];
    interiorSide: 1 | -1;
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

function triangulate(
    loops: Point[][],
    { depth, containers }: LoopClassification,
): { vertices: Float32Array; indices: Uint32Array } {
    const vertices: number[] = [];
    const indices: number[] = [];

    loops.forEach((outer, i) => {
        if (depth[i] % 2 !== 0) return;
        const holes = loops.filter((_, j) =>
            depth[j] === depth[i] + 1 && containers[j].includes(i));
        const flat: number[] = [];
        const holeStarts: number[] = [];
        for (const loop of [outer, ...holes]) {
            if (loop !== outer) holeStarts.push(flat.length / 2);
            for (const p of loop) flat.push(p.x, p.y);
        }
        const base = vertices.length / 2;
        vertices.push(...flat);
        for (const index of earcut(flat, holeStarts)) indices.push(base + index);
    });

    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

export function buildPieceFill(piece: Piece, tolerance: number): PieceMesh {
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
            edgeOutlines.push({ edgeId: edge.id, polyline: loop.polylines[k], interiorSide });
        });
    });

    const { vertices, indices } = triangulate(loops, classification);
    return {
        pieceId: piece.id,
        fillVertices: vertices,
        fillIndices: indices,
        loops,
        bounds: boundsOf(loops),
        edgeOutlines,
        tolerance,
    };
}

export function buildPieceStrokes(mesh: PieceMesh): Map<number, StrokeMesh> {
    const strokes = new Map<number, StrokeMesh>();
    for (const { edgeId, polyline, interiorSide } of mesh.edgeOutlines) {
        const simplified = simplifyPolyline(polyline, mesh.tolerance * STROKE_SIMPLIFY_FRACTION);
        strokes.set(edgeId, buildStrokeMesh(simplified, false, interiorSide));
    }
    return strokes;
}
