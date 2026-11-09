import { describe, it, expect, vi } from 'vitest';
import { getGroupVisualBounds, warmEdgePathBounds } from './group-bounds.js';
import { getPathBounds } from './path-bounds.js';
import { buildPiecesById, makeRectPiece } from '../test-helpers/fixtures.js';

vi.mock('./path-bounds.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./path-bounds.js')>();
    return { ...actual, getPathBounds: vi.fn(actual.getPathBounds) };
});

describe('warmEdgePathBounds', () => {
    it('parses each edge path once, so later bounds queries hit the cache', () => {
        const piece = makeRectPiece({ id: 0 });
        const group = { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]), position: { x: 0, y: 0 }, rotation: 0 };
        vi.mocked(getPathBounds).mockClear();

        warmEdgePathBounds(piece);

        expect(getPathBounds).toHaveBeenCalledTimes(piece.edges.length);

        getGroupVisualBounds(group, buildPiecesById([piece]));

        expect(getPathBounds).toHaveBeenCalledTimes(piece.edges.length);
    });
});
