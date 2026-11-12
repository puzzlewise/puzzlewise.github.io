import { describe, test, expect } from 'vitest';
import { buildPieceFill, buildPieceStrokes } from './piece-mesh.js';
import { sealPieceGeometry } from '../../model/seal-geometry.js';
import { buildShape } from '../../model/build-shape.js';
import { generateComposablePuzzle } from '../../puzzle/composable-generator.js';
import { generateFractalPuzzle } from '../../puzzle/fractal/index.js';
import { generateProceduralPuzzle } from '../../puzzle/procedural-generator.js';
import { finalizePieceGeometry } from '../../model/finalize-geometry.js';
import type { Edge, Piece, Point } from '../../model/types.js';

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
