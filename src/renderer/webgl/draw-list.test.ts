import { describe, expect, test } from 'vitest';
import { buildShape } from '../../model/build-shape.js';
import { makeGameState, makeRectPiece } from '../../test-helpers/fixtures.js';
import type { Edge, GameState, Piece, PieceGroup, Point } from '../../model/types.js';
import type { RendererAppearance } from '../appearance.js';
import { addDebugStrokes, assembleIndices, drawPasses, type DrawPasses, silhouetteIndices } from './draw-list.js';
import { GeometryStore } from './geometry-store.js';
import { buildPieceFill, buildPieceStrokes, insideEvenOdd } from './piece-mesh.js';
import { Scene } from './scene.js';
import { KIND_DEBUG_STROKE, KIND_MATELESS, KIND_STROKE, MAIN_ATTRIBUTES, MAIN_VERTEX_FLOATS } from './shaders.js';
import { OUTLINE_HALF_WIDTH } from './stroke-mesh.js';

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

function polygonPiece(id: number, firstEdgeId: number, points: Point[]): Piece {
    const edges: Edge[] = points.map((start, i) => {
        const end = points[(i + 1) % points.length];
        return { id: firstEdgeId + i, mateEdgeId: -1, matePieceId: -1, path: `L ${end.x} ${end.y}`, start, end };
    });
    return {
        id,
        edges,
        shape: buildShape(edges),
        imageOffset: { x: 0, y: 0 },
        bounds: { minX: 0, minY: 0, maxX: 150, maxY: 30 },
    };
}

// Piece 0 has a 31° corner at (100, 0) between edges 0 and 1, and right angles at
// (0, 0) and (0, 30); edge 1 mates piece 1's edge 4. Piece 1's corners at (50, 30)
// and (150, 30) are 31°, the one at (100, 0) 118°.
function acutePieces(): Piece[] {
    const pieces = [
        polygonPiece(0, 0, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 30 }, { x: 0, y: 30 }]),
        polygonPiece(1, 4, [{ x: 50, y: 30 }, { x: 100, y: 0 }, { x: 150, y: 30 }]),
    ];
    Object.assign(pieces[0].edges[1], { matePieceId: 1, mateEdgeId: 4 });
    Object.assign(pieces[1].edges[0], { matePieceId: 0, mateEdgeId: 1 });
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

function setup(
    groups: PieceGroup[],
    withStrokes = true,
    pieces = matedPieces(),
): { state: GameState; scene: Scene; store: GeometryStore } {
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

    test('inner outline: at an acute convex corner between outer edges, inner tails replace the band ends and caps', () => {
        const { scene, store } = setup([group(10, [[0, 0]]), group(11, [[1, 200]])], true, acutePieces());
        scene.bringToFront(10);
        const parts = (id: number) => store.strokeParts(id)!;
        const f = (id: number) => store.fringeIndices(id);
        expect(parts(0).body.length).toBeLessThan(parts(0).band.length);
        expect(parts(6).body.length).toBeLessThan(parts(6).band.length);

        expect(Array.from(assembleIndices(scene, store, INNER))).toEqual(concat(
            store.fillIndices(1), f(4), f(5), f(6),
            parts(4).body, parts(4).startInnerTail, parts(5).body, parts(5).endInnerTail, parts(6).body, parts(6).bothInnerTails,
            store.fillIndices(0), f(0), f(1), f(2), f(3),
            parts(0).body, parts(0).endInnerTail, parts(1).body, parts(1).startInnerTail, parts(2).band, parts(3).band,
        ));
    });

    test('inner outline: an acute corner whose neighbor edge is shared inside the group keeps its band and cap', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 0]])], true, acutePieces());
        const parts = (id: number) => store.strokeParts(id)!;
        const f = (id: number) => store.fringeIndices(id);
        expect(parts(0).endInnerTail.length).toBeGreaterThan(0);

        expect(Array.from(assembleIndices(scene, store, INNER))).toEqual(concat(
            store.fillIndices(0), store.fillIndices(1),
            f(0), f(2), f(3), f(5), f(6),
            parts(0).band, parts(0).endCap, parts(2).band, parts(2).startCap, parts(3).band,
            parts(5).body, parts(5).endInnerTail, parts(5).startCap,
            parts(6).body, parts(6).startInnerTail, parts(6).endCap,
        ));
    });

    test('outline mode draws whole strokes at acute corners', () => {
        const { scene, store } = setup([group(10, [[0, 0]])], true, acutePieces());
        const s = (id: number) => wholeStroke(store, id);
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, OUTLINE))).toEqual(concat(
            s(0), s(1), s(2), s(3), store.fillIndices(0), f(0), f(1), f(2), f(3),
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

    test('with debug pieces, every piece edge gets a debug stroke over the fills, and mateless strokes go over those', () => {
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])]);
        const { m, d } = copies(store);
        const s = (id: number) => wholeStroke(store, id);
        const f = (id: number) => store.fringeIndices(id);

        expect(Array.from(assembleIndices(scene, store, { ...OUTLINE, debugStrokes: true, mateless: true }))).toEqual(concat(
            s(0), s(2), s(3), s(4), s(5), s(6),
            store.fillIndices(0), store.fillIndices(1),
            f(0), f(2), f(3), f(4), f(5), f(6),
            d(0), d(1), d(2), d(3), d(4), d(5), d(6), d(7),
            m(0), m(2), m(3), m(4), m(5), m(6),
        ));
    });

    test('an edge with no mate edge keeps its mateless stroke when its mate piece is in the same group', () => {
        const pieces = matedPieces();
        Object.assign(pieces[0].edges[1], { mateEdgeId: -1 });
        const { scene, store } = setup([group(10, [[0, 0], [1, 100]])], true, pieces);
        const { m } = copies(store);

        expect(Array.from(assembleIndices(scene, store, { ...FILLS_ONLY, mateless: true }))).toEqual(concat(
            store.fillIndices(0), store.fillIndices(1),
            m(0), m(1), m(2), m(3), m(4), m(5), m(6),
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

describe('inner outline at sharp tips, judged against the piece', () => {
    const dir = (degrees: number): Point => ({
        x: Math.cos((degrees * Math.PI) / 180),
        y: Math.sin((degrees * Math.PI) / 180),
    });
    const along = (from: Point, degrees: number, length: number): Point => ({
        x: from.x + dir(degrees).x * length,
        y: from.y + dir(degrees).y * length,
    });

    function polylinePiece(edgePoints: Point[][]): Piece {
        const edges: Edge[] = edgePoints.map((points, id) => ({
            id,
            mateEdgeId: -1,
            matePieceId: -1,
            path: points.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' '),
            start: points[0],
            end: points[points.length - 1],
        }));
        const all = edgePoints.flat();
        const xs = all.map((p) => p.x);
        const ys = all.map((p) => p.y);
        return {
            id: 0,
            edges,
            shape: buildShape(edges),
            imageOffset: { x: 0, y: 0 },
            bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
        };
    }

    function arc(from: Point, heading: number, radius: number, turn: 1 | -1, length: number): Point[] {
        const points = [from];
        for (let s = 0.5; s <= length; s += 0.5) {
            const angle = (s / radius) * turn;
            const h = (heading * Math.PI) / 180;
            points.push({
                x: from.x + radius * (Math.sin(h + angle) - Math.sin(h)) * turn,
                y: from.y - radius * (Math.cos(h + angle) - Math.cos(h)) * turn,
            });
        }
        return points;
    }

    function distanceToLoops(loops: Point[][], x: number, y: number): number {
        let best = Infinity;
        for (const loop of loops) {
            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                const a = loop[j];
                const b = loop[i];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const len2 = dx * dx + dy * dy;
                const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
                best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
            }
        }
        return best;
    }

    // Within `radius` of the tip at the origin: every point inside the piece and within the
    // stroke width of its edge is drawn, and nothing is drawn outside it.
    function expectTipDrawnWithinPiece(piece: Piece, radius: number): void {
        const { scene, store } = setup([group(10, [[0, 0]])], true, [piece]);
        const indices = assembleIndices(scene, store, { ...FILLS_ONLY, strokesOver: true });
        const data = store.vertices();
        const F = MAIN_VERTEX_FLOATS;
        const A = MAIN_ATTRIBUTES;
        const vertex = (i: number): [number, number, number] => {
            const side = data[i * F + A.side.offset];
            return [
                data[i * F + A.position.offset] + data[i * F + A.normal.offset] * side * OUTLINE_HALF_WIDTH,
                data[i * F + A.position.offset + 1] + data[i * F + A.normal.offset + 1] * side * OUTLINE_HALF_WIDTH,
                side,
            ];
        };
        const triangles: number[][] = [];
        for (let t = 0; t < indices.length; t += 3) {
            if (data[indices[t] * F + A.kind.offset] !== KIND_STROKE) continue;
            const tri = [...vertex(indices[t]), ...vertex(indices[t + 1]), ...vertex(indices[t + 2])];
            if (Math.min(Math.hypot(tri[0], tri[1]), Math.hypot(tri[3], tri[4]), Math.hypot(tri[6], tri[7])) < radius + 50) {
                triangles.push(tri);
            }
        }
        const covered = (x: number, y: number): boolean => triangles.some(([ax, ay, as, bx, by, bs, cx, cy, cs]) => {
            const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(det) < 1e-12) return false;
            const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
            const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
            const l3 = 1 - l1 - l2;
            return l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9 && l1 * as + l2 * bs + l3 * cs <= 1e-6;
        });
        const { loops } = buildPieceFill(piece, 0.05);
        let inside = 0;
        let outside = 0;
        for (let x = -radius; x <= radius; x += 0.1) {
            for (let y = -radius; y <= radius; y += 0.1) {
                if (Math.hypot(x, y) > radius) continue;
                const d = distanceToLoops(loops, x, y);
                if (d < 0.05) continue;
                if (insideEvenOdd(loops, x, y)) {
                    if (d > OUTLINE_HALF_WIDTH - 0.05) continue;
                    inside++;
                    expect(covered(x, y), `inside at ${x.toFixed(2)},${y.toFixed(2)}`).toBe(true);
                } else {
                    outside++;
                    expect(covered(x, y), `outside at ${x.toFixed(2)},${y.toFixed(2)}`).toBe(false);
                }
            }
        }
        expect(inside).toBeGreaterThan(100);
        expect(outside).toBeGreaterThan(100);
    }

    test('an edge that starts with a short hook keeps its outline along its run', () => {
        const p = { x: 0, y: 0 };
        const hook = along(p, 106, 0.25);
        const run = along(hook, 129, 40);
        const neighbor = along(p, 146, 40);
        expectTipDrawnWithinPiece(polylinePiece([[neighbor, p], [p, hook, run], [run, neighbor]]), 14);
    });

    test('an edge whose neighbor starts with a short stretch along it keeps its outline', () => {
        const p = { x: 0, y: 0 };
        const kink = along(p, 0.8, 0.09);
        const neighbor = along(kink, 45, 40);
        const run = along(p, 0, 40);
        expectTipDrawnWithinPiece(polylinePiece([[run, p], [p, kink, neighbor], [neighbor, run]]), 14);
    });

    test.each([20, 40, 75])('a straight %i° tip is drawn up to the point and no further', (angle) => {
        const p = { x: 0, y: 0 };
        const a = along(p, 0, 40);
        const b = along(p, angle, 40);
        expectTipDrawnWithinPiece(polylinePiece([[a, p], [p, b], [b, a]]), 14);
    });

    test('a tip whose neighbor starts with a tiny step outward still draws its point', () => {
        const p = { x: 0, y: 0 };
        const step = along(p, -20, 0.05);
        const neighbor = along(step, 30, 40);
        const run = along(p, 0, 40);
        expectTipDrawnWithinPiece(polylinePiece([[run, p], [p, step, neighbor], [neighbor, run]]), 14);
    });

    test('a tip whose neighbor starts with a tiny step nearly sideways keeps its outline', () => {
        const p = { x: 0, y: 0 };
        const step = along(p, -80, 0.05);
        const neighbor = along(step, 75, 40);
        const run = along(p, 0, 40);
        expectTipDrawnWithinPiece(polylinePiece([[run, p], [p, step, neighbor], [neighbor, run]]), 14);
    });

    test('a sharp concave notch gets no inner tail', () => {
        const p = { x: 0, y: 0 };
        const left = { x: -10, y: 30 };
        const right = { x: 10, y: 30 };
        const piece = polylinePiece([
            [left, p], [p, right], [right, { x: 30, y: 30 }], [{ x: 30, y: 30 }, { x: 30, y: -30 }],
            [{ x: 30, y: -30 }, { x: -30, y: -30 }], [{ x: -30, y: -30 }, { x: -30, y: 30 }], [{ x: -30, y: 30 }, left],
        ]);
        const { store } = setup([group(10, [[0, 0]])], true, [piece]);

        expect(store.cornersOf(0)!.endConvex).toBe(false);
        expect(store.strokeParts(0)!.endInnerTail).toHaveLength(0);
        expect(store.strokeParts(1)!.startInnerTail).toHaveLength(0);
    });

    test('a cusp between two arcs is drawn up to the point and no further', () => {
        const p = { x: 0, y: 0 };
        const lower = arc(p, 0, 30, -1, 25);
        const upper = arc(p, 4, 30, 1, 25);
        const a = lower[lower.length - 1];
        const b = upper[upper.length - 1];
        expectTipDrawnWithinPiece(polylinePiece([[...lower].reverse(), upper, [b, a]]), 12);
    });
});
