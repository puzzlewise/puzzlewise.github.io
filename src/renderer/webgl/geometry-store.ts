import type { Piece, Point } from '../../model/types.js';
import { CHAIN_EPSILON } from '../../model/build-shape.js';
import type { EdgeOutline, PieceMesh } from './piece-mesh.js';
import {
    KIND_DEBUG_STROKE,
    KIND_FILL,
    KIND_FRINGE,
    KIND_HALO,
    KIND_MATELESS,
    KIND_STROKE,
    MAIN_ATTRIBUTES,
    MAIN_VERTEX_FLOATS,
} from './shaders.js';
import type { IndexRange, StrokeMesh } from './stroke-mesh.js';

const INITIAL_VERTICES = 4096;
const A = MAIN_ATTRIBUTES;

interface PieceInfo {
    slot: number;
    imageOffset: Point;
    edgeIds: number[];
}

export interface StrokeParts {
    band: Uint32Array;
    startCap: Uint32Array;
    endCap: Uint32Array;
}

/** Corners in the reference piece's frame (world units) and their atlas UVs. */
export interface HaloQuad {
    refSlot: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    layer: number;
}

export type StrokeCopyKind = typeof KIND_MATELESS | typeof KIND_DEBUG_STROKE;

export interface EdgeCorners {
    prev: number;
    next: number;
    startConvex: boolean;
    endConvex: boolean;
}

/** Index arrays hold absolute indices into `vertices()`. Halo quads take the first `haloCapacity` × 4 vertices. */
export class GeometryStore {
    readonly haloCapacity: number;
    private data = new Float32Array(INITIAL_VERTICES * MAIN_VERTEX_FLOATS);
    private count = 0;
    private readonly pieces = new Map<number, PieceInfo>();
    private readonly fills = new Map<number, Uint32Array>();
    private readonly fringes = new Map<number, Uint32Array>();
    private readonly parts = new Map<number, StrokeParts>();
    private readonly corners = new Map<number, EdgeCorners>();
    private readonly stroked = new Set<number>();
    private readonly strokeRanges = new Map<number, { base: number; count: number }>();
    private readonly mateless = new Set<number>();
    private readonly copies = new Map<StrokeCopyKind, Map<number, Uint32Array>>();
    private readonly haloIndexCache: Uint32Array[] = [];

    constructor(pieces: readonly Piece[], slotOf: (pieceId: number) => number | undefined, haloCapacity = 0) {
        this.haloCapacity = haloCapacity;
        this.reserve(haloCapacity * 4);
        for (const piece of pieces) {
            const slot = slotOf(piece.id);
            if (slot === undefined) continue;
            this.pieces.set(piece.id, {
                slot,
                imageOffset: piece.imageOffset,
                edgeIds: piece.edges.map((edge) => edge.id),
            });
            for (const edge of piece.edges) {
                if (edge.mateEdgeId === -1) this.mateless.add(edge.id);
            }
        }
    }

    vertices(): Float32Array {
        return this.data.subarray(0, this.count * MAIN_VERTEX_FLOATS);
    }

    /** One slot's 4 vertices, which start `index` × 4 vertices into `vertices()`. */
    haloVertices(index: number): Float32Array {
        return this.data.subarray(index * 4 * MAIN_VERTEX_FLOATS, (index + 1) * 4 * MAIN_VERTEX_FLOATS);
    }

    haloIndices(index: number): Uint32Array {
        let indices = this.haloIndexCache[index];
        if (!indices) {
            const base = index * 4;
            indices = Uint32Array.of(base, base + 1, base + 2, base, base + 2, base + 3);
            this.haloIndexCache[index] = indices;
        }
        return indices;
    }

    /** A null quad collapses the slot's vertices to a point, which draws nothing. */
    writeHalo(index: number, quad: HaloQuad | null): void {
        const q = quad ?? { x0: 0, y0: 0, x1: 0, y1: 0, u0: 0, v0: 0, u1: 0, v1: 0, layer: 0, refSlot: 0 };
        const corners = [[q.x0, q.y0, q.u0, q.v0], [q.x1, q.y0, q.u1, q.v0],
            [q.x1, q.y1, q.u1, q.v1], [q.x0, q.y1, q.u0, q.v1]];
        corners.forEach(([x, y, u, v], corner) => {
            const o = (index * 4 + corner) * MAIN_VERTEX_FLOATS;
            const d = this.data;
            d[o + A.position.offset] = x;
            d[o + A.position.offset + 1] = y;
            d[o + A.normal.offset] = q.layer;
            d[o + A.normal.offset + 1] = 0;
            d[o + A.side.offset] = 0;
            d[o + A.imagePosition.offset] = u;
            d[o + A.imagePosition.offset + 1] = v;
            d[o + A.slot.offset] = q.refSlot;
            d[o + A.kind.offset] = KIND_HALO;
        });
    }

    fillIndices(pieceId: number): Uint32Array | undefined {
        return this.fills.get(pieceId);
    }

    fringeIndices(edgeId: number): Uint32Array | undefined {
        return this.fringes.get(edgeId);
    }

    edgesOf(pieceId: number): readonly number[] {
        return this.pieces.get(pieceId)?.edgeIds ?? [];
    }

    addFill(mesh: PieceMesh): void {
        const info = this.pieces.get(mesh.pieceId);
        if (!info) return;
        const vertexCount = mesh.fillVertices.length / 2;
        const base = this.reserve(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            this.write(base + i, info, mesh.fillVertices[2 * i], mesh.fillVertices[2 * i + 1], 0, 0, 0, KIND_FILL);
        }
        this.fills.set(mesh.pieceId, offsetIndices(mesh.fillIndices, base));
    }

    strokeParts(edgeId: number): StrokeParts | undefined {
        return this.parts.get(edgeId);
    }

    cornersOf(edgeId: number): EdgeCorners | undefined {
        return this.corners.get(edgeId);
    }

    addStrokes(mesh: Pick<PieceMesh, 'pieceId' | 'edgeOutlines'>, strokes: ReadonlyMap<number, StrokeMesh>): void {
        const info = this.pieces.get(mesh.pieceId);
        if (!info) return;
        for (const [edgeId, stroke] of strokes) {
            const base = this.reserve(stroke.sides.length);
            for (let i = 0; i < stroke.sides.length; i++) this.writeStrokeVertex(base + i, info, stroke, i, KIND_STROKE);
            this.strokeRanges.set(edgeId, { base, count: stroke.sides.length });
            this.parts.set(edgeId, splitCaps(stroke, offsetIndices(stroke.indices, base)));
            this.fringes.set(edgeId, this.addFringe(info, stroke));
        }
        for (const [edgeId, corners] of findCorners(mesh.edgeOutlines)) this.corners.set(edgeId, corners);
        this.stroked.add(mesh.pieceId);
        if (this.stroked.size === this.pieces.size) this.data = this.data.slice(0, this.count * MAIN_VERTEX_FLOATS);
    }

    strokeCopy(kind: StrokeCopyKind, edgeId: number): Uint32Array | undefined {
        return this.copies.get(kind)?.get(edgeId);
    }

    /** A vertex's kind picks its look within the one draw call, so restyled strokes need their own vertices. */
    addStrokeCopies(kind: StrokeCopyKind): boolean {
        if (this.copies.has(kind) || this.stroked.size !== this.pieces.size) return false;
        const edges = [...this.strokeRanges].filter(([edgeId]) => kind !== KIND_MATELESS || this.mateless.has(edgeId));
        let base = this.reserve(edges.reduce((sum, [, range]) => sum + range.count, 0));
        const copies = new Map<number, Uint32Array>();
        const F = MAIN_VERTEX_FLOATS;
        for (const [edgeId, range] of edges) {
            this.data.copyWithin(base * F, range.base * F, (range.base + range.count) * F);
            for (let i = 0; i < range.count; i++) this.data[(base + i) * F + A.kind.offset] = kind;
            const { band, startCap, endCap } = this.parts.get(edgeId)!;
            const shift = base - range.base;
            copies.set(edgeId, Uint32Array.from([...band, ...startCap, ...endCap], (index) => index + shift));
            base += range.count;
        }
        this.copies.set(kind, copies);
        return edges.length > 0;
    }

    // The fringe only draws outside the edge, so triangles with no exterior
    // vertex would be discarded entirely by the shader.
    private addFringe(info: PieceInfo, stroke: StrokeMesh): Uint32Array {
        const { indices, sides } = stroke;
        const remap = new Int32Array(sides.length).fill(-1);
        const kept: number[] = [];
        let used = 0;
        for (let t = 0; t < indices.length; t += 3) {
            const a = indices[t];
            const b = indices[t + 1];
            const c = indices[t + 2];
            if (sides[a] <= 0 && sides[b] <= 0 && sides[c] <= 0) continue;
            for (const v of [a, b, c]) {
                if (remap[v] === -1) remap[v] = used++;
                kept.push(remap[v]);
            }
        }
        const base = this.reserve(used);
        remap.forEach((target, source) => {
            if (target !== -1) this.writeStrokeVertex(base + target, info, stroke, source, KIND_FRINGE);
        });
        return offsetIndices(kept, base);
    }

    private writeStrokeVertex(index: number, info: PieceInfo, stroke: StrokeMesh, i: number, kind: number): void {
        this.write(
            index, info,
            stroke.centers[2 * i], stroke.centers[2 * i + 1],
            stroke.normals[2 * i], stroke.normals[2 * i + 1],
            stroke.sides[i], kind,
        );
    }

    private write(
        index: number, info: PieceInfo,
        x: number, y: number, nx: number, ny: number, side: number, kind: number,
    ): void {
        const d = this.data;
        const o = index * MAIN_VERTEX_FLOATS;
        d[o + A.position.offset] = x;
        d[o + A.position.offset + 1] = y;
        d[o + A.normal.offset] = nx;
        d[o + A.normal.offset + 1] = ny;
        d[o + A.side.offset] = side;
        d[o + A.imagePosition.offset] = x - info.imageOffset.x;
        d[o + A.imagePosition.offset + 1] = y - info.imageOffset.y;
        d[o + A.slot.offset] = info.slot;
        d[o + A.kind.offset] = kind;
    }

    private reserve(vertexCount: number): number {
        const base = this.count;
        const needed = (base + vertexCount) * MAIN_VERTEX_FLOATS;
        if (needed > this.data.length) {
            const grown = new Float32Array(Math.max(needed, this.data.length * 2));
            grown.set(this.data.subarray(0, base * MAIN_VERTEX_FLOATS));
            this.data = grown;
        }
        this.count += vertexCount;
        return base;
    }
}

function offsetIndices(indices: ArrayLike<number>, base: number): Uint32Array {
    const out = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = indices[i] + base;
    return out;
}

function splitCaps(stroke: StrokeMesh, indices: Uint32Array): StrokeParts {
    const { startCap, endCap } = stroke;
    const within = (i: number, range: IndexRange): boolean => i >= range.offset && i < range.offset + range.count;
    const slice = (range: IndexRange): Uint32Array => indices.slice(range.offset, range.offset + range.count);
    return {
        band: indices.filter((_, i) => !within(i, startCap) && !within(i, endCap)),
        startCap: slice(startCap),
        endCap: slice(endCap),
    };
}

function direction(from: Point, to: Point): Point {
    return { x: to.x - from.x, y: to.y - from.y };
}

function samePoint(a: Point, b: Point): boolean {
    return Math.abs(a.x - b.x) < CHAIN_EPSILON && Math.abs(a.y - b.y) < CHAIN_EPSILON;
}

/** A corner is convex when the boundary turns toward the piece interior there. */
function findCorners(outlines: readonly EdgeOutline[]): Map<number, EdgeCorners> {
    const corners = new Map<number, EdgeCorners>();
    const cornersOf = (edgeId: number): EdgeCorners => {
        let entry = corners.get(edgeId);
        if (!entry) {
            entry = { prev: -1, next: -1, startConvex: false, endConvex: false };
            corners.set(edgeId, entry);
        }
        return entry;
    };
    const link = (a: EdgeOutline, b: EdgeOutline): void => {
        const pa = a.polyline;
        const pb = b.polyline;
        if (pa.length < 2 || pb.length < 2 || !samePoint(pa[pa.length - 1], pb[0])) return;
        const da = direction(pa[pa.length - 2], pa[pa.length - 1]);
        const db = direction(pb[0], pb[1]);
        const convex = (da.x * db.y - da.y * db.x) * a.interiorSide > 0;
        Object.assign(cornersOf(a.edgeId), { next: b.edgeId, endConvex: convex });
        Object.assign(cornersOf(b.edgeId), { prev: a.edgeId, startConvex: convex });
    };
    let loopStart = 0;
    outlines.forEach((outline, i) => {
        const next = outlines[i + 1];
        if (next?.loop === outline.loop) {
            link(outline, next);
        } else {
            link(outline, outlines[loopStart]);
            loopStart = i + 1;
        }
    });
    return corners;
}

