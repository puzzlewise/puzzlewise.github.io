import { describe, it, expect, beforeAll } from 'vitest';
import { groupOutlinePath } from './group-outline.js';
import { createNewGame } from '../game/init.js';
import { registerTabGenerator } from '../puzzle/topology/generator-registry.js';
import { tracedTabGenerator } from '../puzzle/topology/traced-tab-generator.js';
import { makeRectPiece } from '../test-helpers/fixtures.js';
import { imageSize, SEED, styles, viewport } from '../test-helpers/generation-style-cases.js';
import type { Piece, Point } from '../model/types.js';

function mate(a: Piece, aEdge: number, b: Piece, bEdge: number): void {
    a.edges[aEdge].matePieceId = b.id;
    a.edges[aEdge].mateEdgeId = b.edges[bEdge].id;
    b.edges[bEdge].matePieceId = a.id;
    b.edges[bEdge].mateEdgeId = a.edges[aEdge].id;
}

const RIGHT = 1, BOTTOM = 2, LEFT = 3, TOP = 0;

function grid(cols: number, rows: number): Piece[][] {
    const pieces = Array.from({ length: rows }, (_, row) =>
        Array.from({ length: cols }, (_cell, col) => makeRectPiece({ id: row * cols + col, col, row })));
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            if (col + 1 < cols) mate(pieces[row][col], RIGHT, pieces[row][col + 1], LEFT);
            if (row + 1 < rows) mate(pieces[row][col], BOTTOM, pieces[row + 1][col], TOP);
        }
    }
    return pieces;
}

function outlineOf(members: Piece[], offsetOf: (p: Piece) => Point): string | null {
    return groupOutlinePath(new Map(members.map((p) => [p.id, offsetOf(p)])), new Map(members.map((p) => [p.id, p])));
}

function signedArea(loop: string): number {
    const n = loop.match(/-?[\d.]+/g)!.map(Number);
    let sum = 0;
    for (let i = 0; i < n.length; i += 2) {
        const j = (i + 2) % n.length;
        sum += n[i] * n[j + 1] - n[j] * n[i + 1];
    }
    return sum / 2;
}

const solved = (p: Piece): Point => ({ x: -p.imageOffset.x, y: -p.imageOffset.y });

describe('groupOutlinePath', () => {
    it('traces the outline around two joined pieces, leaving out the edge they share', () => {
        const [[a, b]] = grid(2, 1);
        expect(outlineOf([a, b], solved)).toBe(
            'M 0 0 L 100 0 L 200 0 L 200 100 L 100 100 L 0 100 L 0 0 Z',
        );
    });

    it('traces a hole in the group as its own loop, wound the other way', () => {
        const pieces = grid(3, 3);
        const ring = pieces.flat().filter((p) => p.id !== 4);

        const areas = outlineOf(ring, solved)!.split('Z').filter((s) => s.trim()).map(signedArea);
        expect(areas.toSorted((x, y) => x - y)).toEqual([-10000, 90000]);
    });

    it('closes loops that touch at a single corner', () => {
        const pieces = grid(2, 2);
        const loops = outlineOf([pieces[0][0], pieces[1][1]], solved)!.split('Z').filter((s) => s.trim());

        expect(loops.map(signedArea).reduce((a, b) => a + b)).toBe(20000);
    });

    it('chains across offsets that differ by floating-point noise', () => {
        const [[a, b]] = grid(2, 1);
        const d = outlineOf([a, b], (p) => (p === b ? { x: 100.0000001, y: -0.0000001 } : { x: 0, y: 0 }));

        expect(d).not.toBeNull();
        expect(d!.match(/M /g)).toHaveLength(1);
    });

    it('gives up when the outline does not close', () => {
        const [[a, b]] = grid(2, 1);
        expect(outlineOf([a, b], (p) => (p === b ? { x: 130, y: 0 } : { x: 0, y: 0 }))).toBeNull();
    });

    describe('closes for every generator, so groups never fall back to the full piece shapes', () => {
        beforeAll(() => {
            registerTabGenerator(tracedTabGenerator);
        });

        for (const style of styles) {
            it(style.name, () => {
                const { pieces } = createNewGame('img', imageSize, viewport, style.grid, { ...style.options, seed: SEED });

                expect(outlineOf(pieces, solved)).not.toBeNull();
                expect(outlineOf(pieces.filter((_p, i) => i % 3 !== 0), solved)).not.toBeNull();
            });
        }
    });
});
