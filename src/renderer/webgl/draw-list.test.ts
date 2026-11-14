import { describe, expect, test } from 'vitest';
import { makeGameState, makeRectPiece } from '../../test-helpers/fixtures.js';
import type { GameState, Piece, PieceGroup } from '../../model/types.js';
import type { RendererAppearance } from '../appearance.js';
import { addDebugStrokes, assembleIndices, drawPasses, type DrawPasses, silhouetteIndices } from './draw-list.js';
import { GeometryStore } from './geometry-store.js';
import { buildPieceFill, buildPieceStrokes } from './piece-mesh.js';
import { Scene } from './scene.js';
import { KIND_DEBUG_STROKE, KIND_MATELESS } from './shaders.js';

const APPEARANCE: RendererAppearance = {
    outline: 'outline',
    outlineColor: [0, 0, 0, 1],
    constantWidth: false,
    innerOutline: false,
    selectionGlowColor: [1, 1, 1, 1],
    backgroundColor: [0, 0, 0, 1],
    pieceOpacity: 1,
    debugPieces: false,
    matelessEdges: false,
};

const NO_DEBUG = { debugStrokes: false, mateless: false };
const OUTLINE: DrawPasses = { strokesUnder: true, fringe: true, strokesOver: false, ...NO_DEBUG };
const INNER: DrawPasses = { strokesUnder: false, fringe: true, strokesOver: true, ...NO_DEBUG };
const FILLS_ONLY: DrawPasses = { strokesUnder: false, fringe: false, strokesOver: false, ...NO_DEBUG };

// Piece 0's right edge (1) mates piece 1's left edge (7).
function matedPieces(): Piece[] {
    const pieces = [makeRectPiece({ id: 0, col: 0 }), makeRectPiece({ id: 1, col: 1 })];
    Object.assign(pieces[0].edges[1], { matePieceId: 1, mateEdgeId: 7 });
    Object.assign(pieces[1].edges[3], { matePieceId: 0, mateEdgeId: 1 });
    return pieces;
}

function group(id: number, pieces: [number, number][]): PieceGroup {
    return {
        id,
        pieces: new Map(pieces.map(([pieceId, x]) => [pieceId, { x, y: 0 }])),
        position: { x: 0, y: 0 },
        rotation: 0,
    };
}

function setup(groups: PieceGroup[], withStrokes = true): { state: GameState; scene: Scene; store: GeometryStore } {
    const pieces = matedPieces();
    const state = makeGameState({ pieces, groups });
    const meshes = pieces.map((p) => buildPieceFill(p, 0.05));
    const scene = new Scene(meshes, state);
    const store = new GeometryStore(pieces, (id) => scene.slotOfPiece(id));
    for (const mesh of meshes) store.addFill(mesh);
    if (withStrokes) for (const mesh of meshes) store.addStrokes(mesh, buildPieceStrokes(mesh));
    return { state, scene, store };
}

function wholeStroke(store: GeometryStore, edgeId: number): Uint32Array {
    const { band, startCap, endCap } = store.strokeParts(edgeId)!;
    return Uint32Array.from([...band, ...startCap, ...endCap]);
}

function concat(...parts: (Uint32Array | undefined)[]): number[] {
    return parts.flatMap((part) => Array.from(part!));
}

describe('drawPasses', () => {
    test('outline draws strokes under the fills', () => {
        expect(drawPasses(APPEARANCE, true)).toEqual(OUTLINE);
    });

    test('inner outline draws strokes over the fills instead', () => {
        expect(drawPasses({ ...APPEARANCE, innerOutline: true }, true)).toEqual(INNER);
    });

    test('none and shadow draw no strokes', () => {
        const none = { strokesUnder: false, fringe: true, strokesOver: false, ...NO_DEBUG };
        expect(drawPasses({ ...APPEARANCE, outline: 'none' }, true)).toEqual(none);
        expect(drawPasses({ ...APPEARANCE, outline: 'shadow', innerOutline: true }, true)).toEqual(none);
    });

    test('before strokes are built only fills are drawn', () => {
        expect(drawPasses({ ...APPEARANCE, innerOutline: true, debugPieces: true, matelessEdges: true }, false))
            .toEqual(FILLS_ONLY);
    });

    test('the debug toggles add their stroke passes', () => {
        expect(drawPasses({ ...APPEARANCE, debugPieces: true }, true)).toEqual({ ...OUTLINE, debugStrokes: true });
        expect(drawPasses({ ...APPEARANCE, outline: 'none', matelessEdges: true }, true))
            .toEqual({ strokesUnder: false, fringe: true, strokesOver: false, debugStrokes: false, mateless: true });
    });
});

describe('assembleIndices', () => {
    test('outline: per group in z-order, outer-edge strokes, then fills, then fringe', () => {
        const { scene, store } = setup([group(10, [[0, 0]]), group(11, [[1, 200]])]);
        scene.bringToFront(10);
        const s = (id: number) => wholeStroke(store, id);
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, OUTLINE))).toEqual(concat(
            s(4), s(5), s(6), s(7), store.fillIndices(1), f(4), f(5), f(6), f(7),
            s(0), s(1), s(2), s(3), store.fillIndices(0), f(0), f(1), f(2), f(3),
        ));
    });

    test('inner outline: fills, then fringe, then outer-edge bands on top, without caps at convex outer corners', () => {
        const { scene, store } = setup([group(10, [[0, 0]])]);
        const b = (id: number) => store.strokeParts(id)!.band;
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, INNER))).toEqual(concat(
            store.fillIndices(0), f(0), f(1), f(2), f(3), b(0), b(1), b(2), b(3),
        ));
    });

    test('inner outline keeps the caps where an outer edge meets an edge shared inside the group', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])]);
        const parts = (id: number) => store.strokeParts(id)!;
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, INNER))).toEqual(concat(
            store.fillIndices(0), store.fillIndices(1),
            f(0), f(2), f(3), f(4), f(5), f(6),
            parts(0).band, parts(0).endCap, parts(2).band, parts(2).startCap, parts(3).band,
            parts(4).band, parts(4).startCap, parts(5).band, parts(6).band, parts(6).endCap,
        ));
    });

    test('edges shared inside a group are left out', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])]);
        const s = (id: number) => wholeStroke(store, id);
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, OUTLINE))).toEqual(concat(
            s(0), s(2), s(3), s(4), s(5), s(6),
            store.fillIndices(0), store.fillIndices(1),
            f(0), f(2), f(3), f(4), f(5), f(6),
        ));
    });

    test('fills only when no stroke pass is enabled', () => {
        const { scene, store } = setup([group(10, [[0, 0]]), group(11, [[1, 200]])], false);
        expect(Array.from(assembleIndices(scene, store, FILLS_ONLY)))
            .toEqual(concat(store.fillIndices(0), store.fillIndices(1)));
    });

    test('writes into the scratch buffer when it is large enough', () => {
        const { scene, store } = setup([group(10, [[0, 0]])]);
        const scratch = new Uint32Array(100_000);

        const indices = assembleIndices(scene, store, OUTLINE, scratch);

        expect(indices.buffer).toBe(scratch.buffer);
        expect(Array.from(indices)).toEqual(Array.from(assembleIndices(scene, store, OUTLINE)));
    });

    test('each group\'s halos go first, under its strokes and fills, in z-order', () => {
        const { scene, store } = setup([group(10, [[0, 0]]), group(11, [[1, 200]])]);
        const halo = (n: number) => Uint32Array.of(n, n, n);
        const halos = (groupId: number) => (groupId === 10 ? [halo(900), halo(901)] : [halo(911)]);

        expect(Array.from(assembleIndices(scene, store, FILLS_ONLY, undefined, halos))).toEqual(concat(
            halo(900), halo(901), store.fillIndices(0), halo(911), store.fillIndices(1),
        ));
    });
});

describe('assembleIndices debug strokes', () => {
    const copies = (store: GeometryStore) => {
        store.addStrokeCopies(KIND_MATELESS);
        store.addStrokeCopies(KIND_DEBUG_STROKE);
        return {
            m: (id: number) => store.strokeCopy(KIND_MATELESS, id),
            d: (id: number) => store.strokeCopy(KIND_DEBUG_STROKE, id),
        };
    };

    test('mateless strokes go over the fills and fringe, under the inner outline', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])]);
        const { m } = copies(store);
        const parts = (id: number) => store.strokeParts(id)!;
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, { ...INNER, mateless: true }))).toEqual(concat(
            store.fillIndices(0), store.fillIndices(1),
            f(0), f(2), f(3), f(4), f(5), f(6),
            m(0), m(2), m(3), m(4), m(5), m(6),
            parts(0).band, parts(0).endCap, parts(2).band, parts(2).startCap, parts(3).band,
            parts(4).band, parts(4).startCap, parts(5).band, parts(6).band, parts(6).endCap,
        ));
    });

    test('with debug pieces, mateless strokes go under the fills, and every piece edge gets a debug stroke over them', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])]);
        const { m, d } = copies(store);
        const s = (id: number) => wholeStroke(store, id);
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, { ...OUTLINE, debugStrokes: true, mateless: true }))).toEqual(concat(
            s(0), s(2), s(3), s(4), s(5), s(6),
            m(0), m(2), m(3), m(4), m(5), m(6),
            store.fillIndices(0), store.fillIndices(1),
            f(0), f(2), f(3), f(4), f(5), f(6),
            d(0), d(1), d(2), d(3), d(4), d(5), d(6), d(7),
        ));
    });

    test('without the debug passes no copies are drawn, even when they exist', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])]);
        const before = Array.from(assembleIndices(scene, store, OUTLINE));
        copies(store);

        expect(Array.from(assembleIndices(scene, store, OUTLINE))).toEqual(before);
    });
});

describe('addDebugStrokes', () => {
    test('copies only the strokes the passes draw, and reports when vertices were added', () => {
        const { store } = setup([group(10, [[0, 0]]), group(11, [[1, 200]])]);

        expect(addDebugStrokes(store, OUTLINE)).toBe(false);
        expect(store.strokeCopy(KIND_MATELESS, 0)).toBeUndefined();
        expect(addDebugStrokes(store, { ...OUTLINE, mateless: true })).toBe(true);
        expect(store.strokeCopy(KIND_MATELESS, 0)).toBeDefined();
        expect(store.strokeCopy(KIND_DEBUG_STROKE, 0)).toBeUndefined();
        expect(addDebugStrokes(store, { ...OUTLINE, mateless: true })).toBe(false);
        expect(addDebugStrokes(store, { ...OUTLINE, mateless: true, debugStrokes: true })).toBe(true);
        expect(store.strokeCopy(KIND_DEBUG_STROKE, 0)).toBeDefined();
    });
});

describe('silhouetteIndices', () => {
    test('fills plus whole outer strokes with the stroke, fills plus outer fringes without', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])]);
        const s = (id: number) => wholeStroke(store, id);
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(silhouetteIndices(scene, store, 10, true))).toEqual(concat(
            store.fillIndices(0), store.fillIndices(1), s(0), s(2), s(3), s(4), s(5), s(6),
        ));
        expect(Array.from(silhouetteIndices(scene, store, 10, false))).toEqual(concat(
            store.fillIndices(0), store.fillIndices(1), f(0), f(2), f(3), f(4), f(5), f(6),
        ));
    });
});
