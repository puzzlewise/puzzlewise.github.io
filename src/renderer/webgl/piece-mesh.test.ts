import { describe, test, expect, vi, beforeEach } from 'vitest';
import earcut from 'earcut';
import { buildPieceFill, buildPieceStrokes, measureOutlineGroup } from './piece-mesh.js';
import { sealPieceGeometry } from '../../model/seal-geometry.js';
import { buildShape } from '../../model/build-shape.js';
import { generateComposablePuzzle } from '../../puzzle/composable-generator.js';
import { generateFractalPuzzle } from '../../puzzle/fractal/index.js';
import { generateProceduralPuzzle } from '../../puzzle/procedural-generator.js';
import { finalizePieceGeometry } from '../../model/finalize-geometry.js';
import type { Edge, Piece, Point } from '../../model/types.js';
import { combOutline, makeOutlinePiece } from '../../test-helpers/fixtures.js';

vi.mock('earcut', async (importOriginal) => {
    const actual = await importOriginal<typeof import('earcut')>();
    return { default: vi.fn(actual.default) };
});

const TOL = 0.05;

function polygonEdges(points: Point[], firstId: number): Edge[] {
    return points.map((start, i) => {
        const end = points[(i + 1) % points.length];
        return {
            id: firstId + i,
            mateEdgeId: -1,
            matePieceId: -1,
            path: `L ${end.x} ${end.y}`,
            start,
            end,
        };
    });
}

function pieceFromLoops(loops: Point[][]): Piece {
    const edges: Edge[] = [];
    for (const loop of loops) edges.push(...polygonEdges(loop, edges.length));
    const xs = loops.flat().map(p => p.x);
    const ys = loops.flat().map(p => p.y);
    return {
        id: 7,
        edges,
        shape: buildShape(edges),
        imageOffset: { x: 0, y: 0 },
        bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    };
}

function square(x: number, y: number, size: number, clockwise = true): Point[] {
    const pts = [
        { x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size },
    ];
    return clockwise ? pts : pts.reverse();
}

function triangleArea(vertices: Float32Array, indices: Uint32Array): number {
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
        area += Math.abs(
            (vertices[2 * b] - vertices[2 * a]) * (vertices[2 * c + 1] - vertices[2 * a + 1])
            - (vertices[2 * c] - vertices[2 * a]) * (vertices[2 * b + 1] - vertices[2 * a + 1]),
        ) / 2;
    }
    return area;
}

function insideEvenOdd(p: Point, loops: Point[][]): boolean {
    let inside = false;
    for (const loop of loops) {
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const a = loop[i];
            const b = loop[j];
            if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }
    }
    return inside;
}

function polygonArea(loop: Point[]): number {
    let sum = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        sum += loop[j].x * loop[i].y - loop[i].x * loop[j].y;
    }
    return Math.abs(sum) / 2;
}

describe('buildPieceFill and buildPieceStrokes', () => {
    test('square piece triangulates to area equal to its polygon area', () => {
        const piece = pieceFromLoops([square(10, 20, 100)]);
        const mesh = buildPieceFill(piece, TOL);
        expect(mesh.pieceId).toBe(7);
        expect(mesh.bounds).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 120 });
        expect(mesh.loops).toHaveLength(1);
        expect(triangleArea(mesh.fillVertices, mesh.fillIndices)).toBeCloseTo(10000, 3);
    });

    test('bounds contain every loop vertex, including legacy-Classic tabs outside piece.bounds', () => {
        let beyondPieceBounds = 0;
        for (const seed of [1, 2, 3]) {
            for (const piece of finalizePieceGeometry(generateProceduralPuzzle(4, 3, { width: 400, height: 300 }, seed))) {
                const mesh = buildPieceFill(piece, TOL);
                expect(mesh.fillOmitted).toBe(false);
                const { minX, minY, maxX, maxY } = mesh.bounds;
                for (const p of mesh.loops.flat()) {
                    expect(p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY).toBe(true);
                    if (p.x > piece.bounds.maxX + 1 || p.x < piece.bounds.minX - 1
                        || p.y > piece.bounds.maxY + 1 || p.y < piece.bounds.minY - 1) {
                        beyondPieceBounds++;
                    }
                }
            }
        }
        expect(beyondPieceBounds).toBeGreaterThan(0);
    });

    test('piece with a hole (Venn) leaves the hole uncovered: triangle area = outer − hole', () => {
        const venn = sealPieceGeometry(generateComposablePuzzle(1, 1, { width: 1080, height: 720 }, 1, {
            baseCutGenerator: 'venn',
            baseCutConfig: {
                leftCenter: { x: 540, y: 360 }, leftRadius: 300,
                rightCenter: { x: 540, y: 360 }, rightRadius: 100,
            },
            tabGenerator: 'none',
            tabConfig: {},
        }).pieces);
        const meshes = venn.map(p => buildPieceFill(p, TOL));
        const holed = meshes.filter(m => m.loops.length > 1);
        expect(holed.length).toBeGreaterThan(0);
        for (const mesh of holed) {
            const areas = mesh.loops.map(polygonArea).sort((a, b) => b - a);
            const expected = areas[0] - areas.slice(1).reduce((s, a) => s + a, 0);
            expect(triangleArea(mesh.fillVertices, mesh.fillIndices)).toBeCloseTo(expected, 1);
        }
    });

    test.each([true, false])('hole is uncovered whichever way the loops wind (outer cw=%s)', (cw) => {
        const piece = pieceFromLoops([square(0, 0, 100, cw), square(25, 25, 50, !cw)]);
        const mesh = buildPieceFill(piece, TOL);
        expect(triangleArea(mesh.fillVertices, mesh.fillIndices)).toBeCloseTo(10000 - 2500, 3);
    });

    test('nested island inside a hole is filled (even-odd)', () => {
        const piece = pieceFromLoops([square(0, 0, 100), square(10, 10, 80), square(30, 30, 40)]);
        const mesh = buildPieceFill(piece, TOL);
        expect(triangleArea(mesh.fillVertices, mesh.fillIndices)).toBeCloseTo(10000 - 6400 + 1600, 3);
    });

    test.each([[4, 3], [8, 6]])('fractal %i×%i fill area matches even-odd area of its loops', (cols, rows) => {
        for (let seed = 1; seed <= 8; seed++) {
            const pieces = sealPieceGeometry(generateFractalPuzzle(cols, rows, { width: 1200, height: 900 }, seed));
            for (const piece of pieces) {
                const mesh = buildPieceFill(piece, TOL);
                const { minX, minY, maxX, maxY } = piece.bounds;
                const steps = 60;
                const cell = ((maxX - minX) * (maxY - minY)) / (steps * steps);
                let sampled = 0;
                for (let i = 0; i < steps; i++) {
                    for (let j = 0; j < steps; j++) {
                        const p = {
                            x: minX + ((i + 0.5) * (maxX - minX)) / steps,
                            y: minY + ((j + 0.5) * (maxY - minY)) / steps,
                        };
                        if (insideEvenOdd(p, mesh.loops)) sampled += cell;
                    }
                }
                const triangles = triangleArea(mesh.fillVertices, mesh.fillIndices);
                expect(Math.abs(triangles - sampled)).toBeLessThan(0.03 * (maxX - minX) * (maxY - minY));
            }
        }
    });

    test('an edge that flattens to nothing is skipped', () => {
        const piece = pieceFromLoops([square(0, 0, 100)]);
        const degenerate: Edge = {
            id: 99, mateEdgeId: -1, matePieceId: -1, path: 'A 10 10 0 0 1 0 0', start: { x: 0, y: 0 }, end: { x: 0, y: 0 },
        };
        piece.edges.splice(2, 0, degenerate);
        const mesh = buildPieceFill(piece, TOL);
        const strokes = buildPieceStrokes(mesh);
        expect(strokes.has(99)).toBe(false);
        expect(strokes.size).toBe(4);
        expect(triangleArea(mesh.fillVertices, mesh.fillIndices)).toBeCloseTo(10000, 3);
    });

    test('edge strokes are simplified while the fill keeps every flattened point', () => {
        const piece = pieceFromLoops([square(0, 0, 100)]);
        const wiggle = Array.from({ length: 99 }, (_, i) => `L ${i + 1} ${i % 2 === 0 ? 0.001 : 0}`).join(' ');
        piece.edges[0] = { ...piece.edges[0], path: `${wiggle} L 100 0` };
        const mesh = buildPieceFill(piece, TOL);
        const strokes = buildPieceStrokes(mesh);
        expect(mesh.loops[0]).toHaveLength(100 + 3);
        expect(strokes.get(0)!.sides.length).toBe(2 * 2 + 32);
    });

    test('stroke simplification follows the tolerance recorded on the mesh', () => {
        const piece = pieceFromLoops([square(0, 0, 100)]);
        const wiggle = Array.from({ length: 99 }, (_, i) => `L ${i + 1} ${i % 2 === 0 ? 0.001 : 0}`).join(' ');
        piece.edges[0] = { ...piece.edges[0], path: `${wiggle} L 100 0` };
        const coarse = buildPieceFill(piece, TOL);
        const fine = buildPieceFill(piece, 0.0001);
        expect(coarse.tolerance).toBe(TOL);
        expect(fine.tolerance).toBe(0.0001);
        const coarseLength = buildPieceStrokes(coarse).get(0)!.sides.length;
        const fineLength = buildPieceStrokes(fine).get(0)!.sides.length;
        expect(fineLength).toBeGreaterThan(coarseLength);
    });

    test('edge outlines carry the index of the loop they belong to', () => {
        const mesh = buildPieceFill(pieceFromLoops([square(0, 0, 100, false), square(25, 25, 50, true)]), TOL);

        expect(mesh.edgeOutlines.map(o => [o.edgeId, o.loop])).toEqual([
            [0, 0], [1, 0], [2, 0], [3, 0], [4, 1], [5, 1], [6, 1], [7, 1],
        ]);
    });

    test('buildPieceStrokes clips an acute corner only against the loop neighbor that meets it', () => {
        const triangle = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 60 }];
        const closed = buildPieceStrokes(buildPieceFill(pieceFromLoops([triangle]), TOL));
        const gap = { x: 8, y: 4 };
        const open = buildPieceStrokes(buildPieceFill({
            ...pieceFromLoops([triangle]),
            edges: polygonEdges([...triangle, gap], 0).slice(0, 3),
        }, TOL));

        expect(closed.get(0)!.startInnerTail.length).toBeGreaterThan(0);
        expect(closed.get(2)!.endInnerTail.length).toBeGreaterThan(0);
        expect(open.get(0)!.endInnerTail.length).toBeGreaterThan(0);
        expect(open.get(0)!.startInnerTail).toHaveLength(0);
    });

    test('buildPieceStrokes gives one stroke per edge with interiorSide pointing into the piece', () => {
        const venn = sealPieceGeometry(generateComposablePuzzle(1, 1, { width: 1080, height: 720 }, 1, {
            baseCutGenerator: 'venn',
            baseCutConfig: {
                leftCenter: { x: 540, y: 360 }, leftRadius: 300,
                rightCenter: { x: 540, y: 360 }, rightRadius: 100,
            },
            tabGenerator: 'none',
            tabConfig: {},
        }).pieces);
        const fractal = sealPieceGeometry(generateFractalPuzzle(4, 3, { width: 400, height: 300 }, 42));
        const classic = sealPieceGeometry(generateComposablePuzzle(1, 1, { width: 1080, height: 720 }, 1, {
            baseCutGenerator: 'venn',
            baseCutConfig: {
                leftCenter: { x: 432, y: 360 }, leftRadius: 240,
                rightCenter: { x: 648, y: 360 }, rightRadius: 240,
            },
            tabGenerator: 'classic',
            tabConfig: {},
        }).pieces);
        const synthetic = [
            pieceFromLoops([square(0, 0, 100, false), square(25, 25, 50, true)]),
            pieceFromLoops([square(0, 0, 100, true), square(25, 25, 50, false)]),
        ];
        let checked = 0;
        for (const piece of [...venn, ...classic, ...fractal, ...synthetic]) {
            const mesh = buildPieceFill(piece, TOL);
            const strokes = buildPieceStrokes(mesh);
            expect(strokes.size).toBe(piece.edges.length);
            for (const edge of piece.edges) {
                const stroke = strokes.get(edge.id);
                expect(stroke).toBeDefined();
                const { centers, normals, sides } = stroke!;
                let best = -1;
                let bestLen = 0;
                for (let v = 0; v + 3 < sides.length; v += 4) {
                    if (sides[v] !== 1 || sides[v + 1] !== -1 || sides[v + 2] !== 1 || sides[v + 3] !== -1) break;
                    const len = Math.hypot(centers[2 * v + 4] - centers[2 * v], centers[2 * v + 5] - centers[2 * v + 1]);
                    if (len > bestLen) {
                        bestLen = len;
                        best = v;
                    }
                }
                expect(best).toBeGreaterThanOrEqual(0);
                const mid = {
                    x: (centers[2 * best] + centers[2 * best + 4]) / 2,
                    y: (centers[2 * best + 1] + centers[2 * best + 5]) / 2,
                };
                const nx = normals[2 * best];
                const ny = normals[2 * best + 1];
                expect(insideEvenOdd({ x: mid.x - nx * 0.01, y: mid.y - ny * 0.01 }, mesh.loops)).toBe(true);
                // An edge shared by two regions of the same piece has piece interior on both sides.
                const exteriorInside = insideEvenOdd({ x: mid.x + nx * 0.01, y: mid.y + ny * 0.01 }, mesh.loops);
                expect(exteriorInside).toBe(edge.matePieceId === piece.id);
                checked++;
            }
        }
        expect(checked).toBeGreaterThan(20);
    });
});

function circle(points: number, radius: number): Point[] {
    return Array.from({ length: points }, (_, i) => ({
        x: radius * Math.cos((2 * Math.PI * i) / points),
        y: radius * Math.sin((2 * Math.PI * i) / points),
    }));
}

function sampledRect(w: number, h: number, points: number): Point[] {
    const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    const perimeter = 2 * (w + h);
    const out: Point[] = [];
    for (let i = 0; i < points; i++) {
        let d = (perimeter * i) / points;
        for (let c = 0; c < 4; c++) {
            const a = corners[c];
            const b = corners[(c + 1) % 4];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (d <= len) {
                out.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
                break;
            }
            d -= len;
        }
    }
    return out;
}

function compactness(loop: Point[]): number {
    return measureOutlineGroup([loop]).compactness;
}

describe('pathological outlines', () => {
    beforeEach(() => {
        vi.mocked(earcut).mockClear();
    });

    test('a comb-shaped outline over 1,024 points gets no fill and is never triangulated, but keeps its outline', () => {
        const outline = combOutline(300);
        const mesh = buildPieceFill(makeOutlinePiece(3, outline), TOL);
        expect(earcut).not.toHaveBeenCalled();
        expect(mesh.fillOmitted).toBe(true);
        expect(mesh.fillIndices).toHaveLength(0);
        expect(mesh.fillVertices).toHaveLength(0);
        expect(mesh.loops).toEqual([outline]);
        expect(mesh.edgeOutlines).toHaveLength(4);
        expect(mesh.bounds).toEqual({ minX: 0, minY: -2, maxX: 600, maxY: 20 });
    });

    test('a piece without a fill strokes every edge but clips no inner tail against its neighbors', () => {
        const mesh = buildPieceFill(makeOutlinePiece(3, combOutline(300)), TOL);
        const strokes = buildPieceStrokes(mesh);
        expect(strokes.size).toBe(4);
        for (const stroke of strokes.values()) {
            expect(stroke.indices.length).toBeGreaterThan(0);
            expect(stroke.startInnerTail.length + stroke.endInnerTail.length + stroke.bothInnerTails.length).toBe(0);
        }
    });

    test('a degenerate sliver earcut leaves without triangles is not an omitted fill', () => {
        const mesh = buildPieceFill(makeOutlinePiece(3, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], 3), TOL);
        expect(mesh.fillIndices).toHaveLength(0);
        expect(mesh.fillOmitted).toBe(false);
    });

    test('a dense outline from a hand-made sine link is skipped, so earcut never sees more than 3,000 points', () => {
        const pieces = sealPieceGeometry(generateComposablePuzzle(2, 4, { width: 50, height: 50 }, 234, {
            baseCutGenerator: 'sine',
            baseCutConfig: { ha: 0.1, hf: 60, va: 0.03, vf: 30 },
            tabGenerator: 'classic',
            tabConfig: {},
        }).pieces);
        const meshes = pieces.map(p => buildPieceFill(p, TOL));
        const dense = meshes.filter(m => m.loops.flat().length > 3000);
        expect(dense.length).toBeGreaterThan(0);
        expect(dense.every(m => m.fillOmitted)).toBe(true);
        const triangulated = vi.mocked(earcut).mock.calls.map(([flat]) => flat.length / 2);
        expect(Math.max(...triangulated)).toBeLessThanOrEqual(3000);
    });

    test('a piece built without triangulating keeps its outline, has no fill and never reaches earcut', () => {
        const mesh = buildPieceFill(pieceFromLoops([square(0, 0, 100)]), TOL, false);
        expect(earcut).not.toHaveBeenCalled();
        expect(mesh.fillOmitted).toBe(true);
        expect(mesh.fillError).toBeUndefined();
        expect(mesh.fillIndices).toHaveLength(0);
        expect(mesh.loops).toHaveLength(1);
        expect(mesh.edgeOutlines).toHaveLength(4);
    });

    test('a comb of at most 1,024 points is still filled', () => {
        const outline = combOutline(255);
        expect(outline.length).toBeLessThanOrEqual(1024);
        const mesh = buildPieceFill(makeOutlinePiece(3, outline), TOL);
        expect(mesh.fillOmitted).toBe(false);
        expect(triangleArea(mesh.fillVertices, mesh.fillIndices)).toBeCloseTo(polygonArea(outline), 3);
    });

    test('an outline over 1,024 points is filled just under the spikiness limit and not just over it', () => {
        const under = sampledRect(180, 1, 1100);
        const over = sampledRect(220, 1, 1100);
        expect(compactness(under)).toBeLessThan(64);
        expect(compactness(over)).toBeGreaterThan(64);
        const filled = buildPieceFill(makeOutlinePiece(3, under), TOL);
        expect(triangleArea(filled.fillVertices, filled.fillIndices)).toBeCloseTo(polygonArea(under), 1);
        expect(filled.fillOmitted).toBe(false);
        const omitted = buildPieceFill(makeOutlinePiece(4, over), TOL);
        expect(omitted.fillOmitted).toBe(true);
        expect(omitted.fillIndices).toHaveLength(0);
    });

    test('a holed group counts its hole\'s perimeter and subtracts its area; with no net area over 1,024 points it is always skipped', () => {
        const outer = sampledRect(100, 100, 600);
        const hole = (side: number): Point[] => sampledRect(side, side, 500)
            .map(p => ({ x: p.x + (100 - side) / 2, y: p.y + (100 - side) / 2 }))
            .reverse();
        const groupCompactness = (side: number): number =>
            ((400 + 4 * side) ** 2) / (4 * Math.PI * (10000 - side * side));
        expect(groupCompactness(95)).toBeLessThan(64);
        expect(groupCompactness(97)).toBeGreaterThan(64);
        expect(compactness(outer)).toBeLessThan(64);

        const under = buildPieceFill(pieceFromLoops([outer, hole(95)]), TOL);
        expect(under.fillOmitted).toBe(false);
        expect(triangleArea(under.fillVertices, under.fillIndices)).toBeCloseTo(polygonArea(outer) - polygonArea(hole(95)), 0);
        expect(buildPieceFill(pieceFromLoops([outer, hole(97)]), TOL).fillOmitted).toBe(true);

        const flat = Array.from({ length: 1100 }, (_, i) => ({ x: i < 550 ? i : 1099 - i, y: 0 }));
        expect(buildPieceFill(makeOutlinePiece(3, flat), TOL).fillOmitted).toBe(true);
    });

    test('a long compact outline of 3,000 points is filled, one point more is not', () => {
        const long = circle(3000, 500);
        const filled = buildPieceFill(makeOutlinePiece(3, long), TOL);
        expect(triangleArea(filled.fillVertices, filled.fillIndices)).toBeCloseTo(polygonArea(long), 0);

        vi.mocked(earcut).mockClear();
        const tooLong = buildPieceFill(makeOutlinePiece(4, circle(3001, 500)), TOL);
        expect(earcut).not.toHaveBeenCalled();
        expect(tooLong.fillOmitted).toBe(true);
        expect(tooLong.fillIndices).toHaveLength(0);
        expect(tooLong.loops[0]).toHaveLength(3001);
    });

    test('a throw while triangulating leaves the piece without a fill but with its outline, and keeps the error', () => {
        const error = new RangeError('Maximum call stack size exceeded');
        vi.mocked(earcut).mockImplementationOnce(() => {
            throw error;
        });
        const mesh = buildPieceFill(pieceFromLoops([square(0, 0, 100)]), TOL);
        expect(mesh.fillError).toBe(error);
        expect(mesh.fillOmitted).toBe(true);
        expect(mesh.fillIndices).toHaveLength(0);
        expect(mesh.fillVertices).toHaveLength(0);
        expect(mesh.loops).toHaveLength(1);
        expect(buildPieceStrokes(mesh).size).toBe(4);
    });
});
