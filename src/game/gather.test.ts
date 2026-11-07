import { describe, it, expect } from 'vitest';
import type { Piece, PieceGroup } from '../model/types.js';
import {
    computeGatheredPositions,
    computeSplitGatheredPositions,
    applyGatheredPositions,
    splitGatherGutter,
    GATHER_PADDING,
} from './gather.js';
import { getGroupVisualBounds } from './group-bounds.js';
import { buildPiecesById, makeRectPiece } from '../test-helpers/fixtures.js';
import { computePieceBounds } from '../model/derive.js';

function makeGroup(id: number, x: number, y: number): PieceGroup {
    return { id, pieces: new Map([[id, { x: 0, y: 0 }]]), position: { x, y }, rotation: 0 };
}

function makeMultiGroup(
    id: number,
    position: { x: number; y: number },
    pieceOffsets: Array<[number, { x: number; y: number }]>,
): PieceGroup {
    return { id, pieces: new Map(pieceOffsets), position, rotation: 0 };
}

const landscapeAspect = 800 / 600;

describe('computeGatheredPositions', () => {
    it('should return empty result for no groups', () => {
        const { positions } = computeGatheredPositions([], landscapeAspect, new Map());
        expect(positions.size).toBe(0);
    });

    it('should return a position for a single group', () => {
        const pieces = [makeRectPiece({ id: 1, width: 100, height: 100 })];
        const groups = [makeGroup(1, 1000, 2000)];
        const { positions } = computeGatheredPositions(groups, landscapeAspect, buildPiecesById(pieces));

        expect(positions.size).toBe(1);
        expect(positions.has(1)).toBe(true);
    });

    it('should produce positions for all groups', () => {
        const pieces = [makeRectPiece({ id: 1, width: 100, height: 100 }), makeRectPiece({ id: 2, width: 100, height: 100 }), makeRectPiece({ id: 3, width: 100, height: 100 })];
        const groups = [makeGroup(1, 0, 0), makeGroup(2, 500, 500), makeGroup(3, -200, 100)];
        const { positions } = computeGatheredPositions(groups, landscapeAspect, buildPiecesById(pieces));

        expect(positions.size).toBe(3);
        expect(positions.has(1)).toBe(true);
        expect(positions.has(2)).toBe(true);
        expect(positions.has(3)).toBe(true);
    });

    it('should not stack pieces on top of each other', () => {
        const pieces = Array.from({ length: 6 }, (_, i) => makeRectPiece({ id: i, width: 100, height: 100 }));
        const groups = pieces.map(p => makeGroup(p.id, p.id * 10, p.id * 10));
        const { positions } = computeGatheredPositions(groups, landscapeAspect, buildPiecesById(pieces));

        const posArray = Array.from(positions.values());
        for (let i = 0; i < posArray.length; i++) {
            for (let j = i + 1; j < posArray.length; j++) {
                const dx = Math.abs(posArray[i].x - posArray[j].x);
                const dy = Math.abs(posArray[i].y - posArray[j].y);
                expect(dx > 10 || dy > 10).toBe(true);
            }
        }
    });

    it('should return layout bounds that contain all positions', () => {
        const pieces = Array.from({ length: 4 }, (_, i) => makeRectPiece({ id: i, width: 100, height: 100 }));
        const groups = pieces.map(p => makeGroup(p.id, 0, 0));
        const { positions, layoutBounds } = computeGatheredPositions(groups, landscapeAspect, buildPiecesById(pieces));

        for (const pos of positions.values()) {
            expect(pos.x).toBeGreaterThanOrEqual(layoutBounds.x);
            expect(pos.y).toBeGreaterThanOrEqual(layoutBounds.y);
        }

        expect(layoutBounds.width).toBeGreaterThan(0);
        expect(layoutBounds.height).toBeGreaterThan(0);
    });

    it('should handle groups with varying sizes', () => {
        const pieces = [makeRectPiece({ id: 0, width: 100, height: 100 }), makeRectPiece({ id: 1, width: 100, height: 100 }), makeRectPiece({ id: 2, width: 100, height: 100 })];
        const bigGroup = makeMultiGroup(10, { x: 0, y: 0 }, [
            [0, { x: 0, y: 0 }],
            [1, { x: 100, y: 0 }],
        ]);
        const smallGroup = makeGroup(2, 500, 500);
        const { positions } = computeGatheredPositions([bigGroup, smallGroup], landscapeAspect, buildPiecesById(pieces));

        expect(positions.size).toBe(2);
    });
});

describe('computeGatheredPositions with tab paths', () => {
    it('should account for tab geometry in layout spacing', () => {
        // Create pieces with tabs that extend 30px beyond the edge
        const edgesWithTab = [
            { id: 100, mateEdgeId: -1, matePieceId: -1, path: 'L 30 0 C 35 -30, 65 -30, 70 0 L 100 0', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
            { id: 101, mateEdgeId: -1, matePieceId: -1, path: '', start: { x: 100, y: 0 }, end: { x: 100, y: 100 } },
            { id: 102, mateEdgeId: -1, matePieceId: -1, path: '', start: { x: 100, y: 100 }, end: { x: 0, y: 100 } },
            { id: 103, mateEdgeId: -1, matePieceId: -1, path: '', start: { x: 0, y: 100 }, end: { x: 0, y: 0 } },
        ];
        const pieceWithTab: Piece = {
            id: 1,
            edges: edgesWithTab,
            shape: '',
            imageOffset: { x: 0, y: 0 },
            bounds: computePieceBounds({ edges: edgesWithTab }),
        };

        const plainEdges = [
            { id: 200, mateEdgeId: -1, matePieceId: -1, path: '', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
            { id: 201, mateEdgeId: -1, matePieceId: -1, path: '', start: { x: 100, y: 0 }, end: { x: 100, y: 100 } },
            { id: 202, mateEdgeId: -1, matePieceId: -1, path: '', start: { x: 100, y: 100 }, end: { x: 0, y: 100 } },
            { id: 203, mateEdgeId: -1, matePieceId: -1, path: '', start: { x: 0, y: 100 }, end: { x: 0, y: 0 } },
        ];
        const plainPiece: Piece = {
            id: 2,
            edges: plainEdges,
            shape: '',
            imageOffset: { x: 0, y: 0 },
            bounds: computePieceBounds({ edges: plainEdges }),
        };

        const groups: PieceGroup[] = [
            { id: 1, pieces: new Map([[1, { x: 0, y: 0 }]]), position: { x: 0, y: 0 }, rotation: 0 },
            { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]), position: { x: 200, y: 0 }, rotation: 0 },
        ];

        const { layoutBounds } = computeGatheredPositions(groups, 1.33, buildPiecesById([pieceWithTab, plainPiece]));

        // The layout should be taller than 100px to account for the 30px tab
        expect(layoutBounds.height).toBeGreaterThan(100);
    });
});

describe('applyGatheredPositions', () => {
    it('should update group positions from the map', () => {
        const groups = [makeGroup(1, 100, 200), makeGroup(2, 300, 400)];
        const positions = new Map([
            [1, { x: 10, y: 20 }],
            [2, { x: 30, y: 40 }],
        ]);
        applyGatheredPositions(groups, positions);
        expect(groups[0].position).toEqual({ x: 10, y: 20 });
        expect(groups[1].position).toEqual({ x: 30, y: 40 });
    });

    it('should skip groups not in the positions map', () => {
        const groups = [makeGroup(1, 100, 200), makeGroup(2, 300, 400)];
        applyGatheredPositions(groups, new Map([[1, { x: 50, y: 60 }]]));
        expect(groups[0].position).toEqual({ x: 50, y: 60 });
        expect(groups[1].position).toEqual({ x: 300, y: 400 });
    });
});

describe('computeSplitGatheredPositions', () => {
    const gutter = 350;

    function makeSquares(count: number): { pieces: Piece[]; groups: PieceGroup[] } {
        const pieces = Array.from({ length: count }, (_, i) => makeRectPiece({ id: i, width: 100, height: 100 }));
        const groups = pieces.map(p => makeGroup(p.id, p.id * 37, p.id * 11));
        return { pieces, groups };
    }

    function worldExtent(
        groups: PieceGroup[],
        positions: Map<number, { x: number; y: number }>,
        piecesById: Map<number, Piece>,
    ): { minX: number; maxX: number; minY: number; maxY: number } {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const group of groups) {
            const b = getGroupVisualBounds(group, piecesById);
            const pos = positions.get(group.id)!;
            minX = Math.min(minX, pos.x + b.minX);
            maxX = Math.max(maxX, pos.x + b.minX + b.width);
            minY = Math.min(minY, pos.y + b.minY);
            maxY = Math.max(maxY, pos.y + b.minY + b.height);
        }
        return { minX, maxX, minY, maxY };
    }

    it('lays out like a plain gather when nothing is selected', () => {
        const { pieces, groups } = makeSquares(10);
        const piecesById = buildPiecesById(pieces);

        const split = computeSplitGatheredPositions(groups, new Set(), landscapeAspect, piecesById, gutter);
        const plain = computeGatheredPositions(groups, landscapeAspect, piecesById);

        expect(split.positions.size).toBe(10);
        expect(split.layoutBounds).toEqual(plain.layoutBounds);
    });

    it('lays out like a plain gather when everything is selected', () => {
        const { pieces, groups } = makeSquares(10);
        const piecesById = buildPiecesById(pieces);
        const all = new Set(groups.map(g => g.id));

        const split = computeSplitGatheredPositions(groups, all, landscapeAspect, piecesById, gutter);
        const plain = computeGatheredPositions(groups, landscapeAspect, piecesById);

        expect(split.positions.size).toBe(10);
        expect(split.layoutBounds).toEqual(plain.layoutBounds);
    });

    it('ignores selected ids that are not among the groups', () => {
        const { pieces, groups } = makeSquares(10);
        const piecesById = buildPiecesById(pieces);

        const split = computeSplitGatheredPositions(groups, new Set([999]), landscapeAspect, piecesById, gutter);
        const plain = computeGatheredPositions(groups, landscapeAspect, piecesById);

        expect(split.layoutBounds).toEqual(plain.layoutBounds);
    });

    it('puts the selected groups on the left, separated from the rest by the gutter', () => {
        const { pieces, groups } = makeSquares(20);
        const piecesById = buildPiecesById(pieces);
        const selectedIds = new Set([0, 3, 7, 11, 15]);
        const selected = groups.filter(g => selectedIds.has(g.id));
        const rest = groups.filter(g => !selectedIds.has(g.id));

        const { positions } = computeSplitGatheredPositions(groups, selectedIds, landscapeAspect, piecesById, gutter);

        expect(positions.size).toBe(20);
        const left = worldExtent(selected, positions, piecesById);
        const right = worldExtent(rest, positions, piecesById);
        expect(right.minX - left.maxX).toBeCloseTo(gutter);
    });

    it('shapes each side like a plain gather of that side alone', () => {
        const { pieces, groups } = makeSquares(20);
        const piecesById = buildPiecesById(pieces);
        const selectedIds = new Set([0, 1, 2, 3, 4]);
        const selected = groups.filter(g => selectedIds.has(g.id));
        const rest = groups.filter(g => !selectedIds.has(g.id));

        const { positions } = computeSplitGatheredPositions(groups, selectedIds, landscapeAspect, piecesById, gutter);

        for (const side of [selected, rest]) {
            const extent = worldExtent(side, positions, piecesById);
            const alone = computeGatheredPositions(side, landscapeAspect, piecesById).layoutBounds;
            expect(extent.maxX - extent.minX).toBeCloseTo(alone.width - 2 * GATHER_PADDING);
            expect(extent.maxY - extent.minY).toBeCloseTo(alone.height - 2 * GATHER_PADDING);
        }
    });

    it('returns layout bounds that frame both sides with the gather padding', () => {
        const { pieces, groups } = makeSquares(20);
        const piecesById = buildPiecesById(pieces);
        const selectedIds = new Set([0, 1, 2, 3, 4]);

        const { positions, layoutBounds } = computeSplitGatheredPositions(
            groups, selectedIds, landscapeAspect, piecesById, gutter,
        );

        const extent = worldExtent(groups, positions, piecesById);
        expect(layoutBounds.x).toBeCloseTo(extent.minX - GATHER_PADDING);
        expect(layoutBounds.x + layoutBounds.width).toBeCloseTo(extent.maxX + GATHER_PADDING);
        expect(layoutBounds.y).toBeCloseTo(extent.minY - GATHER_PADDING);
        expect(layoutBounds.y + layoutBounds.height).toBeCloseTo(extent.maxY + GATHER_PADDING);
    });
});

describe('splitGatherGutter', () => {
    it('is 3.5 average piece widths', () => {
        expect(splitGatherGutter({ width: 1000, height: 800 }, 80)).toBeCloseTo(350);
    });

    it('is zero for a puzzle with no pieces', () => {
        expect(splitGatherGutter({ width: 1000, height: 800 }, 0)).toBe(0);
    });
});
