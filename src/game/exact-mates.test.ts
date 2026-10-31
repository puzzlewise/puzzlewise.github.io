import { describe, it, expect, beforeAll } from 'vitest';
import { createNewGame } from './init.js';
import { buildShape, fmt } from '../model/build-shape.js';
import { deriveMatePath } from '../model/edge-path.js';
import { quantize } from '../model/quantize-geometry.js';
import { registerTabGenerator } from '../puzzle/topology/generator-registry.js';
import { tracedTabGenerator } from '../puzzle/topology/traced-tab-generator.js';
import { generateRaw, imageSize, SEED, styles, viewport } from '../test-helpers/generation-style-cases.js';
import type { Edge, GameState, GeneratedPiece, Piece, Point } from '../model/types.js';

beforeAll(() => {
    registerTabGenerator(tracedTabGenerator);
});

interface InteriorPair {
    canon: Edge;
    mate: Edge;
    canonPiece: Piece;
    matePiece: Piece;
}

function interiorPairs(pieces: Piece[]): InteriorPair[] {
    const owners = new Map<number, { edge: Edge; piece: Piece }>();
    for (const piece of pieces) {
        for (const edge of piece.edges) owners.set(edge.id, { edge, piece });
    }
    const pairs: InteriorPair[] = [];
    for (const piece of pieces) {
        for (const edge of piece.edges) {
            if (edge.mateEdgeId < 0 || edge.id > edge.mateEdgeId) continue;
            const mate = owners.get(edge.mateEdgeId);
            if (!mate) throw new Error(`edge ${edge.id}: mate ${edge.mateEdgeId} missing`);
            pairs.push({ canon: edge, mate: mate.edge, canonPiece: piece, matePiece: mate.piece });
        }
    }
    return pairs;
}

function translate(p: Point, from: Point, to: Point): Point {
    return { x: quantize(p.x - from.x + to.x), y: quantize(p.y - from.y + to.y) };
}

function subpathCount(shape: string): number {
    return shape.match(/M/g)?.length ?? 0;
}

describe('exact mates in generated puzzles', () => {
    for (const style of styles) {
        describe(style.name, () => {
            let state: GameState;
            let raw: GeneratedPiece[];

            beforeAll(() => {
                state = createNewGame('img', imageSize, viewport, style.grid, {
                    ...style.options,
                    seed: SEED,
                });
                raw = generateRaw(style);
            });

            it('derives every mate path, start and end from its canonical side', () => {
                const pairs = interiorPairs(state.pieces);
                expect(pairs.length).toBeGreaterThan(0);

                for (const { canon, mate, canonPiece, matePiece } of pairs) {
                    const label = `edges ${canon.id}/${mate.id}`;
                    const from = canonPiece.imageOffset;
                    const to = matePiece.imageOffset;
                    expect(mate.mateEdgeId, label).toBe(canon.id);
                    expect(mate.path, label).toBe(deriveMatePath(canon.path, canon.start, from, to));
                    expect(mate.start, label).toEqual(translate(canon.end, from, to));
                    expect(mate.end, label).toEqual(translate(canon.start, from, to));
                }
            });

            it('ends every path exactly at its edge end', () => {
                for (const edge of state.pieces.flatMap((p) => p.edges)) {
                    const tokens = edge.path.split(/[\s,]+/).filter((t) => t !== '');
                    expect(tokens.slice(-2), `edge ${edge.id}: ${edge.path}`)
                        .toEqual([fmt(edge.end.x), fmt(edge.end.y)]);
                }
            });

            it('builds every shape from its edges', () => {
                for (const piece of state.pieces) {
                    expect(piece.shape, `piece ${piece.id}`).toBe(buildShape(piece.edges));
                }
            });

            it("keeps each shape's loop structure", () => {
                expect(state.pieces.map((p) => subpathCount(p.shape)))
                    .toEqual(raw.map((p) => subpathCount(p.shape)));
            });
        });
    }
});
