import { describe, it, expect } from 'vitest';
import { alignMatePaths } from './align-mates.js';
import { buildShape } from './build-shape.js';
import type { GeneratedEdge, GeneratedPiece, Point } from './types.js';

function edge(
    id: number,
    mateEdgeId: number,
    matePieceId: number,
    path: string,
    start: Point,
    end: Point,
): GeneratedEdge {
    return { id, mateEdgeId, matePieceId, path, start, end };
}

function piece(id: number, imageOffset: Point, edges: GeneratedEdge[]): GeneratedPiece {
    return { id, imageOffset, edges, shape: 'stale' };
}

function makePieces(): GeneratedPiece[] {
    return [
        piece(0, { x: 0, y: 0 }, [
            edge(1, 2, 1, 'C 70 10, 70 40, 64.34 50', { x: 64.33, y: 0 }, { x: 64.33, y: 50 }),
            edge(3, -1, -1, 'L 0 50.01', { x: 64.33, y: 50 }, { x: 0, y: 50 }),
            edge(4, -1, -1, 'Q 1 2 3 4', { x: 0, y: 50 }, { x: 64.33, y: 0 }),
        ]),
        piece(1, { x: -64.33, y: 0 }, [
            edge(2, 1, 0, 'C 5.68 40, 5.67 10, 0 0', { x: 0, y: 50 }, { x: 0, y: 0 }),
        ]),
        piece(2, { x: -10.5, y: -20.25 }, [
            edge(6, 5, 2, 'A 5 5 0 0,1 0.01 0', { x: 10, y: 0 }, { x: 0, y: 0 }),
            edge(5, 6, 2, 'A 5 5 0 0,1 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
        ]),
        piece(3, { x: 0, y: 0 }, [
            edge(10, 11, 4, 'L 5 5', { x: 0, y: 0 }, { x: 5, y: 5 }),
            edge(20, 21, 4, 'Q 1 2 3 4', { x: 5, y: 5 }, { x: 0, y: 0 }),
        ]),
        piece(4, { x: 0, y: 0 }, [
            edge(11, 99, 3, 'L 2 3 L 0 0', { x: 5, y: 5 }, { x: 0, y: 0 }),
            edge(21, 20, 3, 'L 2 2 L 5 5', { x: 0, y: 0 }, { x: 5, y: 5 }),
        ]),
    ];
}

function pathOf(pieces: GeneratedPiece[], edgeId: number): string {
    const found = pieces.flatMap((p) => p.edges).find((e) => e.id === edgeId);
    if (!found) throw new Error(`edge ${edgeId} missing`);
    return found.path;
}

describe('alignMatePaths', () => {
    it('snaps the canonical path to its end and derives the mate from it', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 1)).toBe('C 70 10, 70 40, 64.33 50');
        expect(pathOf(out, 2)).toBe('C 5.67 40, 5.67 10, 0 0');
    });

    it('snaps a border path to its end', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 3)).toBe('L 0 50');
    });

    it('derives a self-mated pair from its lower id with one shared offset', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 5)).toBe('A 5 5 0 0,1 10 0');
        expect(pathOf(out, 6)).toBe('A 5 5 0 0,0 0 0');
    });

    it('leaves an asymmetric pair and unparseable paths byte-identical', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 10)).toBe('L 5 5');
        expect(pathOf(out, 11)).toBe('L 2 3 L 0 0');
        expect(pathOf(out, 20)).toBe('Q 1 2 3 4');
        expect(pathOf(out, 21)).toBe('L 2 2 L 5 5');
        expect(pathOf(out, 4)).toBe('Q 1 2 3 4');
    });

    it('rebuilds every shape from the aligned edges', () => {
        for (const p of alignMatePaths(makePieces())) {
            expect(p.shape).toBe(buildShape(p.edges));
        }
    });

    it('does not mutate the input pieces', () => {
        const input = makePieces();

        alignMatePaths(input);

        expect(input).toEqual(makePieces());
    });
});
