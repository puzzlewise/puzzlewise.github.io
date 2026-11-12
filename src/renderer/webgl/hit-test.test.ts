import { describe, test, expect } from 'vitest';
import { hitTest } from './hit-test.js';
import { Scene } from './scene.js';
import { buildPieceFill } from './piece-mesh.js';
import { buildShape } from '../../model/build-shape.js';
import { finalizePieceGeometry } from '../../model/finalize-geometry.js';
import { generateProceduralPuzzle } from '../../puzzle/procedural-generator.js';
import { makeGameState, makeRectPiece } from '../../test-helpers/fixtures.js';
import type { GameState, Piece, PieceGroup, Point } from '../../model/types.js';

const IDENTITY = { scale: 1, offsetX: 0, offsetY: 0 };

function square(x: number, y: number, size: number): Point[] {
    return [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
}

function holedPiece(id: number): Piece {
    const loops = [square(0, 0, 100), square(25, 25, 50)];
    const edges = loops.flatMap((loop, l) => loop.map((start, i) => {
        const end = loop[(i + 1) % loop.length];
        return {
            id: id * 100 + l * 10 + i,
            mateEdgeId: -1,
            matePieceId: -1,
            path: `L ${end.x} ${end.y}`,
            start,
            end,
        };
    }));
    return {
        id,
        edges,
        shape: buildShape(edges),
        imageOffset: { x: 0, y: 0 },
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    };
}

function group(id: number, pieceId: number, position: Point, rotation = 0): PieceGroup {
    return { id, pieces: new Map([[pieceId, { x: 0, y: 0 }]]), position, rotation };
}

function setup(pieces: Piece[], groups: PieceGroup[]) {
    const state: GameState = makeGameState({ pieces, groups });
    return new Scene(pieces.map((p) => buildPieceFill(p, 0.05)), state);
}

function overlapping() {
    return setup(
        [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })],
        [group(10, 0, { x: 0, y: 0 }), group(11, 1, { x: 50, y: 0 })],
    );
}

describe('hitTest', () => {
    test('returns the topmost of two overlapping groups', () => {
        const scene = overlapping();
        expect(hitTest(scene, { x: 75, y: 50 }, IDENTITY)).toBe(1);
        expect(hitTest(scene, { x: 25, y: 50 }, IDENTITY)).toBe(0);
        expect(hitTest(scene, { x: 125, y: 50 }, IDENTITY)).toBe(1);
        expect(hitTest(scene, { x: 200, y: 50 }, IDENTITY)).toBeNull();
    });

    test('a point in a hole returns null, and a point on the ring hits', () => {
        const scene = setup([holedPiece(5)], [group(10, 5, { x: 0, y: 0 })]);
        expect(hitTest(scene, { x: 50, y: 50 }, IDENTITY)).toBeNull();
        expect(hitTest(scene, { x: 10, y: 50 }, IDENTITY)).toBe(5);
    });

    test('a piece beneath a hole is hit through it', () => {
        const scene = setup(
            [makeRectPiece({ id: 0 }), holedPiece(5)],
            [group(10, 0, { x: 0, y: 0 }), group(11, 5, { x: 0, y: 0 })],
        );
        expect(hitTest(scene, { x: 50, y: 50 }, IDENTITY)).toBe(0);
        expect(hitTest(scene, { x: 10, y: 50 }, IDENTITY)).toBe(5);
    });

    test('respects viewport scale and offset', () => {
        const scene = setup([makeRectPiece({ id: 0 })], [group(10, 0, { x: 0, y: 0 })]);
        const viewport = { scale: 2, offsetX: 30, offsetY: -10 };
        expect(hitTest(scene, { x: 31, y: -9 }, viewport)).toBe(0);
        expect(hitTest(scene, { x: 229, y: 189 }, viewport)).toBe(0);
        expect(hitTest(scene, { x: 29, y: 100 }, viewport)).toBeNull();
        expect(hitTest(scene, { x: 231, y: 100 }, viewport)).toBeNull();
        expect(hitTest(scene, { x: 100, y: 191 }, viewport)).toBeNull();
    });

    test('respects group rotation', () => {
        const scene = setup([makeRectPiece({ id: 0 })], [group(10, 0, { x: 200, y: 200 }, 90)]);
        // Rotating 90 degrees about (200, 200) maps the square onto x in [100, 200], y in [200, 300].
        expect(hitTest(scene, { x: 150, y: 250 }, IDENTITY)).toBe(0);
        expect(hitTest(scene, { x: 250, y: 250 }, IDENTITY)).toBeNull();
        expect(hitTest(scene, { x: 150, y: 150 }, IDENTITY)).toBeNull();
    });

    test('follows the completion-spin rotation override', () => {
        const scene = setup([makeRectPiece({ id: 0 })], [group(10, 0, { x: 200, y: 200 }, 0)]);
        expect(hitTest(scene, { x: 250, y: 250 }, IDENTITY)).toBe(0);
        scene.setRotationOverride(10, 90, { x: 0, y: 0 });
        expect(hitTest(scene, { x: 250, y: 250 }, IDENTITY)).toBeNull();
        expect(hitTest(scene, { x: 150, y: 250 }, IDENTITY)).toBe(0);
    });

    test('bringToFront changes which overlapping piece is hit', () => {
        const scene = overlapping();
        expect(hitTest(scene, { x: 75, y: 50 }, IDENTITY)).toBe(1);
        scene.bringToFront(10);
        expect(hitTest(scene, { x: 75, y: 50 }, IDENTITY)).toBe(0);
    });

    test('pressing a legacy-Classic tab outside piece.bounds hits the piece', () => {
        const pieces = finalizePieceGeometry(generateProceduralPuzzle(4, 3, { width: 400, height: 300 }, 1));
        let best: { piece: Piece; point: Point; excess: number } | null = null;
        for (const piece of pieces) {
            const { minX, minY, maxX, maxY } = piece.bounds;
            const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
            for (const p of buildPieceFill(piece, 0.05).loops.flat()) {
                const excess = Math.max(minX - p.x, p.x - maxX, minY - p.y, p.y - maxY);
                if (best && excess <= best.excess) continue;
                const toCenter = Math.hypot(center.x - p.x, center.y - p.y);
                const point = {
                    x: p.x + ((center.x - p.x) / toCenter) * 2,
                    y: p.y + ((center.y - p.y) / toCenter) * 2,
                };
                best = { piece, point, excess };
            }
        }
        const { piece, point } = best!;
        const { minX, minY, maxX, maxY } = piece.bounds;
        expect(point.x < minX || point.x > maxX || point.y < minY || point.y > maxY).toBe(true);
        const scene = setup([piece], [group(10, piece.id, { x: 0, y: 0 })]);
        expect(hitTest(scene, point, IDENTITY)).toBe(piece.id);
    });

    test('finds any piece of a multi-piece group', () => {
        const pieces = [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })];
        const merged: PieceGroup = {
            id: 10,
            pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
            position: { x: 0, y: 0 },
            rotation: 0,
        };
        const scene = setup(pieces, [merged]);
        expect(hitTest(scene, { x: 50, y: 50 }, IDENTITY)).toBe(0);
        expect(hitTest(scene, { x: 150, y: 50 }, IDENTITY)).toBe(1);
    });
});
