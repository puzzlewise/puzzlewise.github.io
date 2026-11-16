import { describe, it, expect } from 'vitest';
import { deserializeState, readSelection, readViewport, recombine, serializeProgress } from './serialization.js';
import type { SerializedStaticState } from './serialization.js';
import { buildShape } from '../model/build-shape.js';
import { sealPieceGeometry } from '../model/seal-geometry.js';
import { buildGroupIndexes, buildPiecesById, localToWorld } from '../model/helpers.js';
import type { Edge, GameState, Piece, PieceGroup, Point } from '../model/types.js';
import { processDrop } from '../game/group-merging.js';
import { buildPieceFill } from '../renderer/webgl/piece-mesh.js';
import { v11UnroundedGridBlob, v11UnroundedGridProgress, v13GridBlob, v13GridProgress } from '../test-helpers/v13-save.js';

const STEP = 0.01;
const PHASE = 0.0037;

function covered(triangles: number[][], x: number, y: number): boolean {
    return triangles.some(([ax, ay, bx, by, cx, cy]) => {
        const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
        const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
        return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
    });
}

interface SampleWindow { x0: number; x1: number; y0: number; y1: number }

const CORNER: SampleWindow = { x0: 9, x1: 11, y0: 9, y1: 11 };
/** The lower vertical cut, away from both of its corners: only the 0.01 px mismatch is there. */
const MID_CUT: SampleWindow = { x0: 10.5, x1: 11.1, y0: 12.5, y1: 17.5 };
/** Where piece 0's unmated top edge meets its mated right edge on the rim. */
const RIM_CORNER: SampleWindow = { x0: 9.5, x1: 10.5, y0: 0.05, y1: 1 };

/**
 * The WebGL renderer fills without anti-aliasing, so a sample point covered by
 * no piece's triangles is a pixel center that would show the table. Pieces sit
 * at `place(piece)`: their solved image position unless a group says otherwise.
 */
function uncoveredSamples(
    pieces: Piece[],
    w: SampleWindow,
    place: (piece: Piece) => Point = (piece) => ({ x: -piece.imageOffset.x, y: -piece.imageOffset.y }),
): number {
    const triangles = pieces.flatMap((piece) => {
        const mesh = buildPieceFill(piece, 0.1);
        const { x: ox, y: oy } = place(piece);
        const v = mesh.fillVertices;
        const out: number[][] = [];
        for (let i = 0; i < mesh.fillIndices.length; i += 3) {
            out.push(Array.from(mesh.fillIndices.subarray(i, i + 3)).flatMap((k) => [v[2 * k] + ox, v[2 * k + 1] + oy]));
        }
        return out;
    });
    let uncovered = 0;
    for (let x = w.x0 + PHASE; x < w.x1; x += STEP) {
        for (let y = w.y0 + PHASE; y < w.y1; y += STEP) {
            if (!covered(triangles, x, y)) uncovered++;
        }
    }
    return uncovered;
}

describe('pre-v14 saves in the WebGL fill meshes', () => {
    const stored = () => v13GridBlob().pieces.map((p) => {
        const edges = p.edges as Edge[];
        return { id: p.id, imageOffset: p.imageOffset, bounds: p.bounds!, edges, shape: buildShape(edges) };
    });
    const restored = () => recombine(v13GridBlob(), v13GridProgress()).pieces;

    it('stored as written, the 2×2 grid leaves fill gaps at the corner, mid-cut and rim corner', () => {
        expect(uncoveredSamples(stored(), CORNER)).toBeGreaterThan(0);
        expect(uncoveredSamples(stored(), MID_CUT)).toBeGreaterThan(0);
        expect(uncoveredSamples(stored(), RIM_CORNER)).toBeGreaterThan(0);
    });

    it('restored, the 2×2 grid has no fill gaps at the corner, mid-cut or rim corner', () => {
        expect(uncoveredSamples(restored(), CORNER)).toBe(0);
        expect(uncoveredSamples(restored(), MID_CUT)).toBe(0);
        expect(uncoveredSamples(restored(), RIM_CORNER)).toBe(0);
    });

    it('stored as written, the unrounded pre-2026-07-25 grid leaves fill gaps mid-cut', () => {
        const pieces = v11UnroundedGridBlob().pieces.map((p) => ({
            id: p.id, imageOffset: p.imageOffset, edges: p.edges as Edge[], shape: p.shape!,
            bounds: { minX: 0, minY: 0, maxX: 12, maxY: 10 },
        }));
        expect(uncoveredSamples(pieces, MID_CUT)).toBeGreaterThan(0);
    });

    it('restored, the unrounded pre-2026-07-25 grid has no fill gaps at the corner or mid-cut', () => {
        const pieces = recombine(v11UnroundedGridBlob(), v11UnroundedGridProgress()).pieces;
        expect(uncoveredSamples(pieces, CORNER)).toBe(0);
        expect(uncoveredSamples(pieces, MID_CUT)).toBe(0);
    });
});

/**
 * Assembles the whole puzzle with the real merge code on the pieces as stored,
 * the way a build before the alignment did: each drop lands a little off and
 * the merge snaps it onto the stored (unaligned) endpoints.
 */
function mergedOnStoredGeometry(
    blob: SerializedStaticState,
    count = blob.pieces.length,
    rotation = 0,
): ReturnType<typeof serializeProgress> {
    const pieces = sealPieceGeometry(blob.pieces.map((p) => {
        const edges = p.edges as Edge[];
        return { id: p.id, imageOffset: p.imageOffset, edges, shape: p.shape ?? buildShape(edges), ...(p.bounds ? { bounds: p.bounds } : {}) };
    }));
    const groups: PieceGroup[] = pieces.map((p, i) => ({
        id: p.id, pieces: new Map([[p.id, { x: 0, y: 0 }]]), position: { x: 100 * i, y: 50 }, rotation,
    }));
    const state: GameState = {
        pieces, groups, piecesById: buildPiecesById(pieces), ...buildGroupIndexes(groups),
        imageUrl: null, imageSize: blob.imageSize!, gridSize: blob.gridSize!, completed: false,
    };
    const jitter = [{ x: 0.7, y: -0.4 }, { x: -0.6, y: 0.5 }, { x: 0.3, y: 0.8 }];
    const anchor = pieces[0];
    for (const [i, piece] of pieces.slice(1, count).entries()) {
        const target = state.pieceToGroup.get(anchor.id)!;
        const anchorOffset = target.pieces.get(anchor.id)!;
        const moved = state.pieceToGroup.get(piece.id)!;
        if (moved === target) continue;
        const solved = localToWorld({
            x: anchorOffset.x + anchor.imageOffset.x - piece.imageOffset.x,
            y: anchorOffset.y + anchor.imageOffset.y - piece.imageOffset.y,
        }, target);
        moved.position = { x: solved.x + jitter[i].x, y: solved.y + jitter[i].y };
        processDrop(moved.id, state);
    }
    return serializeProgress(state);
}

/** Group placement, shifted so the group's first piece sits at its solved image position. */
function groupPlacement(state: GameState): (piece: Piece) => Point {
    const world = (piece: Piece) => {
        const group = state.pieceToGroup.get(piece.id)!;
        const offset = group.pieces.get(piece.id)!;
        return { x: group.position.x + offset.x, y: group.position.y + offset.y };
    };
    const first = state.pieces[0];
    const shift = { x: -first.imageOffset.x - world(first).x, y: -first.imageOffset.y - world(first).y };
    return (piece) => ({ x: world(piece).x + shift.x, y: world(piece).y + shift.y });
}

describe('pre-v14 saves with groups merged before the alignment', () => {
    for (const [name, blob] of [['v13', v13GridBlob], ['unrounded v11', v11UnroundedGridBlob]] as const) {
        it(`restored, the ${name} grid's merged group has no fill gaps at the corner or mid-cut`, () => {
            const progress = mergedOnStoredGeometry(blob());
            expect(progress.groups).toHaveLength(1);
            const state = recombine(blob(), progress);
            expect(uncoveredSamples(state.pieces, CORNER, groupPlacement(state))).toBe(0);
            expect(uncoveredSamples(state.pieces, MID_CUT, groupPlacement(state))).toBe(0);
        });
    }

    for (const [name, makeBlob] of [['v13', v13GridBlob], ['unrounded v11', v11UnroundedGridBlob]] as const) {
        it(`keeps the ${name} grid's ids, membership, selection, viewport and completion, and corrects each group once`, () => {
            const blob = makeBlob();
            const stored = JSON.stringify(blob);
            const progress = {
                ...mergedOnStoredGeometry(blob, 3),
                selection: [3],
                viewport: { scale: 2.5, offset: { x: -40, y: 12 } },
                completed: false,
            };
            const progressJson = JSON.stringify(progress);

            const first = recombine(blob, JSON.parse(progressJson));
            const resaved = serializeProgress(first, readSelection(progress), readViewport(progress));
            const second = recombine(blob, JSON.parse(JSON.stringify(resaved)));

            expect(JSON.stringify(blob)).toBe(stored);
            expect(first.groups.map((g) => [g.id, [...g.pieces.keys()]]))
                .toEqual(progress.groups.map((g) => [g.id, g.pieces.map(([id]) => id)]));
            expect(first.groups.map((g) => [g.position, g.rotation]))
                .toEqual(progress.groups.map((g) => [g.position, g.rotation]));
            expect(first.completed).toBe(false);
            expect(resaved.selection).toEqual([3]);
            expect(resaved.viewport).toEqual(progress.viewport);
            expect(second.groups.map((g) => [...g.pieces])).toEqual(first.groups.map((g) => [...g.pieces]));
            const moved = progress.groups[0].pieces.some(([id, o]) => {
                const now = first.groups[0].pieces.get(id)!;
                return now.x !== o.x || now.y !== o.y;
            });
            expect(moved).toBe(true);
        });
    }

    it('leaves a v14 save\'s progress exactly as stored', () => {
        const progress = mergedOnStoredGeometry(v13GridBlob());
        const state = recombine({ ...v13GridBlob(), version: 14 }, JSON.parse(JSON.stringify(progress)));
        expect(state.groups.map((g) => [...g.pieces])).toEqual(progress.groups.map((g) => g.pieces));
    });

    it('merges a loose piece onto a corrected group exactly onto its mate', () => {
        const state = recombine(v13GridBlob(), mergedOnStoredGeometry(v13GridBlob(), 3));
        const target = state.pieceToGroup.get(0)!;
        const loose = state.pieceToGroup.get(3)!;
        expect(loose).not.toBe(target);
        const [p0, p3] = [state.piecesById.get(0)!, state.piecesById.get(3)!];
        const anchor = target.pieces.get(0)!;
        loose.position = {
            x: target.position.x + anchor.x + p0.imageOffset.x - p3.imageOffset.x + 1.3,
            y: target.position.y + anchor.y + p0.imageOffset.y - p3.imageOffset.y - 0.9,
        };

        processDrop(loose.id, state);

        const offset = state.pieceToGroup.get(3)!.pieces.get(3)!;
        expect(state.pieceToGroup.get(3)).toBe(target);
        expect(offset.x + p3.imageOffset.x).toBeCloseTo(anchor.x + p0.imageOffset.x, 9);
        expect(offset.y + p3.imageOffset.y).toBeCloseTo(anchor.y + p0.imageOffset.y, 9);
    });

    it('corrects a group merged at a non-zero rotation without moving it', () => {
        const progress = mergedOnStoredGeometry(v13GridBlob(), 4, 30);
        expect(progress.groups).toHaveLength(1);
        const [stored] = progress.groups;
        expect(stored.rotation).toBe(30);

        const state = recombine(v13GridBlob(), JSON.parse(JSON.stringify(progress)));

        const [group] = state.groups;
        expect(group.position).toEqual(stored.position);
        expect(group.rotation).toBe(30);
        expect(group.pieces.get(stored.pieces[0][0])).toEqual(stored.pieces[0][1]);
        expect(uncoveredSamples(state.pieces, CORNER, groupPlacement(state))).toBe(0);
        expect(uncoveredSamples(state.pieces, MID_CUT, groupPlacement(state))).toBe(0);
    });

    it('corrects drifted groups in a legacy single-key save', () => {
        const blob = v13GridBlob();
        const progress = mergedOnStoredGeometry(blob);
        const legacy = {
            ...blob,
            version: 10,
            pieces: blob.pieces.map(({ bounds: _bounds, ...p }) => ({ ...p, shape: buildShape(p.edges as Edge[]) })),
            groups: progress.groups,
            completed: false,
        };

        const state = deserializeState(JSON.parse(JSON.stringify(legacy)));

        expect(state.groups[0].pieces.get(progress.groups[0].pieces[0][0])).toEqual(progress.groups[0].pieces[0][1]);
        expect(uncoveredSamples(state.pieces, CORNER, groupPlacement(state))).toBe(0);
        expect(uncoveredSamples(state.pieces, MID_CUT, groupPlacement(state))).toBe(0);
    });
});
