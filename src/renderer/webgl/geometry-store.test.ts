import { describe, expect, test } from 'vitest';
import { buildShape } from '../../model/build-shape.js';
import type { Edge, Piece, Point } from '../../model/types.js';
import { makeRectPiece } from '../../test-helpers/fixtures.js';
import { GeometryStore } from './geometry-store.js';
import { buildPieceFill, buildPieceStrokes } from './piece-mesh.js';
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
import { buildStrokeMesh, type StrokeMesh } from './stroke-mesh.js';

function vertexCount(store: GeometryStore): number {
    return store.vertices().length / MAIN_VERTEX_FLOATS;
}

function vertex(store: GeometryStore, index: number): Record<keyof typeof MAIN_ATTRIBUTES, number[]> {
    const data = store.vertices();
    const base = index * MAIN_VERTEX_FLOATS;
    const read = ({ offset, size }: { offset: number; size: number }) =>
        Array.from(data.slice(base + offset, base + offset + size));
    return {
        position: read(MAIN_ATTRIBUTES.position),
        normal: read(MAIN_ATTRIBUTES.normal),
        side: read(MAIN_ATTRIBUTES.side),
        imagePosition: read(MAIN_ATTRIBUTES.imagePosition),
        slot: read(MAIN_ATTRIBUTES.slot),
        kind: read(MAIN_ATTRIBUTES.kind),
    };
}

// Two segment quads with exterior (+1) and interior (-1) sides, plus one
// interior-only fan triangle around a hub.
const STROKE: StrokeMesh = {
    centers: new Float32Array([0, 0, 0, 0, 10, 0, 10, 0, 5, 5]),
    normals: new Float32Array([0, -1, 0, 1, 0, -1, 0, 1, 1, 0]),
    sides: new Float32Array([1, -1, 1, -1, 0]),
    indices: new Uint32Array([0, 1, 2, 1, 3, 2, 4, 1, 3]),
    startCap: { offset: 0, count: 0 },
    endCap: { offset: 0, count: 0 },
};

function twoPieces() {
    const pieces = [
        makeRectPiece({ id: 0, col: 0, width: 100, height: 100 }),
        makeRectPiece({ id: 1, col: 1, width: 100, height: 100 }),
    ];
    return { pieces, meshes: pieces.map((p) => buildPieceFill(p, 0.05)) };
}

describe('GeometryStore', () => {
    test('fill vertices carry local position, image position, slot and the fill kind', () => {
        const { pieces, meshes } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id);
        store.addFill(meshes[1]);

        const mesh = meshes[1];
        expect(vertexCount(store)).toBe(mesh.fillVertices.length / 2);
        for (let i = 0; i < vertexCount(store); i++) {
            const x = mesh.fillVertices[2 * i];
            const y = mesh.fillVertices[2 * i + 1];
            expect(vertex(store, i)).toEqual({
                position: [x, y],
                normal: [0, 0],
                side: [0],
                imagePosition: [x + 100, y],
                slot: [1],
                kind: [KIND_FILL],
            });
        }
    });

    test('vertices take their slot from the lookup, not from the piece order', () => {
        const { pieces, meshes } = twoPieces();
        const store = new GeometryStore(pieces, (id) => (id === 1 ? 0 : 1));
        store.addFill(meshes[1]);
        const fillCount = vertexCount(store);
        store.addStrokes({ pieceId: 1, edgeOutlines: [] }, new Map([[5, STROKE]]));

        expect(fillCount).toBeGreaterThan(0);
        expect(vertexCount(store)).toBeGreaterThan(fillCount);
        for (let i = 0; i < vertexCount(store); i++) expect(vertex(store, i).slot).toEqual([0]);
    });

    test('a piece the lookup has no slot for gets no vertices', () => {
        const { pieces, meshes } = twoPieces();
        const store = new GeometryStore(pieces, (id) => (id === 0 ? 0 : undefined));
        store.addFill(meshes[1]);

        expect(vertexCount(store)).toBe(0);
        expect(store.fillIndices(1)).toBeUndefined();
    });

    test('fill indices are offset to the piece\'s first vertex', () => {
        const { pieces, meshes } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id);
        store.addFill(meshes[0]);
        store.addFill(meshes[1]);

        const base = meshes[0].fillVertices.length / 2;
        expect(Array.from(store.fillIndices(0)!)).toEqual(Array.from(meshes[0].fillIndices));
        expect(Array.from(store.fillIndices(1)!)).toEqual(Array.from(meshes[1].fillIndices, (i) => i + base));
    });

    test('stroke vertices carry centers, normals and sides with the stroke kind', () => {
        const { pieces, meshes } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id);
        store.addFill(meshes[0]);
        const base = vertexCount(store);
        store.addStrokes({ pieceId: 1, edgeOutlines: [] }, new Map([[5, STROKE]]));

        expect(Array.from(store.strokeParts(5)!.band)).toEqual(Array.from(STROKE.indices, (i) => i + base));
        expect(vertex(store, base + 1)).toEqual({
            position: [0, 0],
            normal: [0, 1],
            side: [-1],
            imagePosition: [100, 0],
            slot: [1],
            kind: [KIND_STROKE],
        });
        expect(vertex(store, base + 4).kind).toEqual([KIND_STROKE]);
    });

    test('fringe keeps only the triangles that reach outside the piece, with the fringe kind', () => {
        const { pieces } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id);
        store.addStrokes({ pieceId: 0, edgeOutlines: [] }, new Map([[2, STROKE]]));

        const fringe = Array.from(store.fringeIndices(2)!);
        expect(fringe).toHaveLength(6);
        const copies = fringe.map((i) => vertex(store, i));
        expect(copies.every((v) => v.kind[0] === KIND_FRINGE)).toBe(true);
        expect(copies.map((v) => [...v.position, ...v.normal, ...v.side])).toEqual(
            [0, 1, 2, 1, 3, 2].map((i) => [
                STROKE.centers[2 * i], STROKE.centers[2 * i + 1],
                STROKE.normals[2 * i], STROKE.normals[2 * i + 1],
                STROKE.sides[i],
            ]),
        );
        expect(vertexCount(store)).toBe(5 + 4);
    });

    test('an edge without a stroke mesh has no stroke or fringe indices', () => {
        const { pieces } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id);
        store.addStrokes({ pieceId: 0, edgeOutlines: [] }, new Map([[2, STROKE]]));

        expect(store.strokeParts(3)).toBeUndefined();
        expect(store.fringeIndices(3)).toBeUndefined();
    });

    test('the vertex data is trimmed to its used length once every piece has strokes', () => {
        const { pieces, meshes } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id);
        for (const mesh of meshes) store.addFill(mesh);
        store.addStrokes(meshes[0], buildPieceStrokes(meshes[0]));
        expect(store.vertices().buffer.byteLength).toBeGreaterThan(store.vertices().byteLength);

        store.addStrokes(meshes[1], buildPieceStrokes(meshes[1]));

        expect(store.vertices().buffer.byteLength).toBe(store.vertices().byteLength);
    });

    test('edgesOf lists a piece\'s edge ids', () => {
        const { pieces } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id);

        expect(store.edgesOf(1)).toEqual([4, 5, 6, 7]);
        expect(store.edgesOf(9)).toEqual([]);
    });

    test('a stroke splits into its band and the caps at its two ends', () => {
        const piece = makeRectPiece({ id: 0 });
        const mesh = buildPieceFill(piece, 0.05);
        const strokes = buildPieceStrokes(mesh);
        const store = new GeometryStore([piece], (id) => id);
        store.addStrokes(mesh, strokes);

        const { band, startCap, endCap } = store.strokeParts(0)!;
        expect(startCap.length).toBeGreaterThan(0);
        expect(endCap.length).toBeGreaterThan(0);
        expect([...band, ...startCap, ...endCap].sort((a, b) => a - b))
            .toEqual([...strokes.get(0)!.indices].sort((a, b) => a - b));
        const hubAt = (cap: Uint32Array) => [...cap]
            .map((i) => vertex(store, i))
            .filter((v) => v.side[0] === 0)
            .map((v) => v.position);
        expect(new Set(hubAt(startCap).map(String))).toEqual(new Set(['0,0']));
        expect(new Set(hubAt(endCap).map(String))).toEqual(new Set(['100,0']));
    });

    test('a near-duplicate final point still yields an end cap', () => {
        const polyline = [{ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1e-10 }];
        const store = new GeometryStore([makeRectPiece({ id: 0 })], (id) => id);
        store.addStrokes(
            { pieceId: 0, edgeOutlines: [{ edgeId: 0, polyline, interiorSide: 1, loop: 0 }] },
            new Map([[0, buildStrokeMesh(polyline, false, 1)]]),
        );

        const { startCap, endCap } = store.strokeParts(0)!;
        const hubs = (cap: Uint32Array) => new Set([...cap]
            .map((i) => vertex(store, i))
            .filter((v) => v.side[0] === 0)
            .map((v) => String(v.position)));
        expect(hubs(startCap)).toEqual(new Set(['10,0']));
        expect(hubs(endCap)).toEqual(new Set(['0,0']));
    });

    test('corners link each edge to its loop neighbors and tell convex from reflex', () => {
        // An L: the corner at (50, 50) is reflex, every other corner convex.
        const piece = polygonPiece([
            { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
            { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 },
        ]);
        const mesh = buildPieceFill(piece, 0.05);
        const store = new GeometryStore([piece], (id) => id);
        store.addStrokes(mesh, buildPieceStrokes(mesh));

        expect(store.cornersOf(0)).toEqual({ prev: 5, next: 1, startConvex: true, endConvex: true });
        expect(store.cornersOf(2)).toEqual({ prev: 1, next: 3, startConvex: true, endConvex: false });
        expect(store.cornersOf(3)).toEqual({ prev: 2, next: 4, startConvex: false, endConvex: true });
        expect(store.cornersOf(5)).toEqual({ prev: 4, next: 0, startConvex: true, endConvex: true });
    });

    test('corners wrap within each loop of a piece with a hole', () => {
        const piece = polygonPiece(
            [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
            [{ x: 25, y: 25 }, { x: 25, y: 75 }, { x: 75, y: 75 }, { x: 75, y: 25 }],
        );
        const mesh = buildPieceFill(piece, 0.05);
        const store = new GeometryStore([piece], (id) => id);
        store.addStrokes(mesh, buildPieceStrokes(mesh));

        expect(store.cornersOf(3)).toEqual({ prev: 2, next: 0, startConvex: true, endConvex: true });
        expect(store.cornersOf(4)).toEqual({ prev: 7, next: 5, startConvex: false, endConvex: false });
    });
});

describe('GeometryStore debug stroke copies', () => {
    // Piece 0's right edge (1) mates piece 1's left edge (7).
    function matedStore(stroked: number[] = [0, 1]) {
        const { pieces, meshes } = twoPieces();
        Object.assign(pieces[0].edges[1], { matePieceId: 1, mateEdgeId: 7 });
        Object.assign(pieces[1].edges[3], { matePieceId: 0, mateEdgeId: 1 });
        const store = new GeometryStore(pieces, (id) => id);
        for (const mesh of meshes) store.addFill(mesh);
        for (const i of stroked) store.addStrokes(meshes[i], buildPieceStrokes(meshes[i]));
        return store;
    }
    const whole = (store: GeometryStore, edgeId: number) => {
        const { band, startCap, endCap } = store.strokeParts(edgeId)!;
        return [...band, ...startCap, ...endCap];
    };
    const attributes = (store: GeometryStore, indices: Iterable<number>) =>
        [...indices].map((i) => {
            const { kind: _kind, ...rest } = vertex(store, i);
            return rest;
        });

    test('mateless copies cover only edges without a mate, with the stroke vertices under the mateless kind', () => {
        const store = matedStore();
        const before = vertexCount(store);

        expect(store.addStrokeCopies(KIND_MATELESS)).toBe(true);

        expect(vertexCount(store)).toBeGreaterThan(before);
        expect(store.strokeCopy(KIND_MATELESS, 1)).toBeUndefined();
        expect(store.strokeCopy(KIND_MATELESS, 7)).toBeUndefined();
        for (const edgeId of [0, 2, 3, 4, 5, 6]) {
            const copy = store.strokeCopy(KIND_MATELESS, edgeId)!;
            expect(Math.min(...copy)).toBeGreaterThanOrEqual(before);
            expect(new Set([...copy].map((i) => vertex(store, i).kind[0]))).toEqual(new Set([KIND_MATELESS]));
            expect(attributes(store, copy)).toEqual(attributes(store, whole(store, edgeId)));
        }
    });

    test('debug copies cover every edge', () => {
        const store = matedStore();

        expect(store.addStrokeCopies(KIND_DEBUG_STROKE)).toBe(true);

        for (let edgeId = 0; edgeId < 8; edgeId++) {
            const copy = store.strokeCopy(KIND_DEBUG_STROKE, edgeId)!;
            expect(vertex(store, copy[0]).kind).toEqual([KIND_DEBUG_STROKE]);
            expect(attributes(store, copy)).toEqual(attributes(store, whole(store, edgeId)));
        }
    });

    test('copies are made once', () => {
        const store = matedStore();
        store.addStrokeCopies(KIND_MATELESS);
        const count = vertexCount(store);

        expect(store.addStrokeCopies(KIND_MATELESS)).toBe(false);
        expect(vertexCount(store)).toBe(count);
    });

    test('no copies before every piece has strokes', () => {
        const store = matedStore([0]);
        const count = vertexCount(store);

        expect(store.addStrokeCopies(KIND_DEBUG_STROKE)).toBe(false);
        expect(vertexCount(store)).toBe(count);
        expect(store.strokeCopy(KIND_DEBUG_STROKE, 0)).toBeUndefined();
    });
});

function polygonPiece(...loops: Point[][]): Piece {
    const edges: Edge[] = loops.flatMap((points, l) => points.map((start, i) => {
        const end = points[(i + 1) % points.length];
        const id = loops.slice(0, l).reduce((n, loop) => n + loop.length, 0) + i;
        return { id, mateEdgeId: -1, matePieceId: -1, path: `L ${end.x} ${end.y}`, start, end };
    }));
    return {
        id: 0,
        edges,
        shape: buildShape(edges),
        imageOffset: { x: 0, y: 0 },
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    };
}

describe('GeometryStore halo quads', () => {
    test('take the first vertices, before any fill', () => {
        const { pieces, meshes } = twoPieces();
        const store = new GeometryStore(pieces, (id) => id, 3);
        store.addFill(meshes[0]);
        expect(Math.min(...store.fillIndices(0)!)).toBe(12);

        store.writeHalo(2, { refSlot: 7, x0: -5, y0: -6, x1: 50, y1: 60, u0: 0.1, v0: 0.2, u1: 0.3, v1: 0.4, layer: 1 });
        expect(Array.from(store.haloIndices(2))).toEqual([8, 9, 10, 8, 10, 11]);
        expect([8, 9, 10, 11].map((i) => vertex(store, i))).toEqual([
            [-5, -6, 0.1, 0.2], [50, -6, 0.3, 0.2], [50, 60, 0.3, 0.4], [-5, 60, 0.1, 0.4],
        ].map(([x, y, u, v]) => ({
            position: [x, y],
            normal: [1, 0],
            side: [0],
            imagePosition: [expect.closeTo(u, 6), expect.closeTo(v, 6)],
            slot: [7],
            kind: [KIND_HALO],
        })));
        expect(store.haloVertices(2)).toEqual(store.vertices().subarray(8 * MAIN_VERTEX_FLOATS, 12 * MAIN_VERTEX_FLOATS));
        expect(store.haloIndices(2)).toBe(store.haloIndices(2));

        store.writeHalo(2, null);
        const positions = [8, 9, 10, 11].map((i) => vertex(store, i).position);
        expect(new Set(positions.map((p) => p.join()))).toEqual(new Set(['0,0']));
    });
});
