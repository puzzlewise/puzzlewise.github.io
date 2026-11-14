import { describe, test, expect } from 'vitest';
import { Scene } from './scene.js';
import { buildPieceFill } from './piece-mesh.js';
import { mergeGroups } from '../../game/group-merging.js';
import { removeGroup } from '../../model/helpers.js';
import { makeGameState, makeMatedPiecePair, makeRectPiece } from '../../test-helpers/fixtures.js';
import type { GameState, Piece, PieceGroup, Point } from '../../model/types.js';

function group(id: number, pieceIds: number[], position: Point, rotation = 0): PieceGroup {
    return {
        id,
        pieces: new Map(pieceIds.map((p) => [p, { x: 0, y: 0 }])),
        position,
        rotation,
    };
}

function meshesFor(pieces: Piece[]) {
    return pieces.map((p) => buildPieceFill(p, 0.05));
}

function pairState(): GameState {
    const { piece0, piece1 } = makeMatedPiecePair();
    return makeGameState({
        pieces: [piece0, piece1],
        groups: [group(10, [0], { x: 0, y: 0 }), group(11, [1], { x: 300, y: 0 })],
    });
}

function makeScene(state: GameState): Scene {
    return new Scene(meshesFor(state.pieces), state);
}

function slot(t: Float32Array, i: number): number[] {
    return Array.from(t.slice(i * 8, i * 8 + 8));
}

function mergePair(state: GameState): void {
    const [target, moved] = [state.groupsById.get(10)!, state.groupsById.get(11)!];
    mergeGroups(state, {
        movedGroup: moved,
        targetGroup: target,
        movedPiece: state.piecesById.get(1)!,
        snapDelta: { x: -200, y: 0 },
    });
    removeGroup(state, 11);
}

describe('Scene', () => {
    test('piece transform maps local (0,0) to group.position + offset for rotation 0', () => {
        const state = pairState();
        state.groups[0].position = { x: 5, y: 7 };
        state.groups[0].pieces.set(0, { x: 2, y: 3 });
        const t = makeScene(state).pieceTransforms();
        expect(slot(t, 0)).toEqual([1, 0, 7, 10, 0, 0, 0, 0]);
        expect(slot(t, 1)).toEqual([1, 0, 300, 0, 1, 0, 0, 0]);
    });

    test('rotation 90 rotates about the group origin', () => {
        const state = pairState();
        state.groups[0].position = { x: 10, y: 20 };
        state.groups[0].rotation = 90;
        state.groups[0].pieces.set(0, { x: 4, y: 0 });
        const t = makeScene(state).pieceTransforms();
        expect(t[0]).toBeCloseTo(0, 5);
        expect(t[1]).toBeCloseTo(1, 5);
        expect(t[2]).toBeCloseTo(10, 4);
        expect(t[3]).toBeCloseTo(24, 4);
    });

    test('bringToFront moves the group last in orderedGroupIds', () => {
        const scene = makeScene(pairState());
        expect(scene.orderedGroupIds()).toEqual([10, 11]);
        scene.bringToFront(10);
        expect(scene.orderedGroupIds()).toEqual([11, 10]);
        expect(slot(scene.pieceTransforms(), 0)[4]).toBe(1);
    });

    test('merge keeps the surviving group z-position and drops the absorbed group', () => {
        const build = (groupIds: number[]): GameState => {
            const { piece0, piece1 } = makeMatedPiecePair();
            const piece2 = { ...piece0, id: 2, edges: [] };
            const byId: Record<number, PieceGroup> = {
                10: group(10, [0], { x: 0, y: 0 }),
                11: group(11, [1], { x: 300, y: 0 }),
                12: group(12, [2], { x: 600, y: 0 }),
            };
            return makeGameState({
                pieces: [piece0, piece1, piece2],
                groups: groupIds.map((id) => byId[id]),
            });
        };

        const survivorLowest = build([10, 12, 11]);
        const lowScene = makeScene(survivorLowest);
        mergePair(survivorLowest);
        lowScene.sync(survivorLowest);
        expect(lowScene.orderedGroupIds()).toEqual([10, 12]);

        const survivorHighest = build([11, 12, 10]);
        const highScene = makeScene(survivorHighest);
        mergePair(survivorHighest);
        const changes = highScene.sync(survivorHighest);
        expect(highScene.orderedGroupIds()).toEqual([12, 10]);
        expect(changes.order).toBe(true);
        expect(changes.outerEdges).toBe(true);
        expect(changes.groupsChanged).toContain(11);
    });

    test('selection and dragging survive sync after a merge for the surviving group', () => {
        const state = pairState();
        const scene = makeScene(state);
        scene.setSelected(10, true);
        scene.setDragging(10, true);
        scene.setSelected(11, true);
        mergePair(state);
        scene.sync(state);
        expect(scene.groupState(10)).toEqual({ selected: true, dragging: true });
        expect(scene.groupState(11)).toEqual({ selected: false, dragging: false });
    });

    test('flags set on an unknown group id are ignored', () => {
        const state = pairState();
        const scene = makeScene(state);
        scene.setSelected(99, true);
        scene.setDragging(99, true);
        expect(scene.groupState(99)).toEqual({ selected: false, dragging: false });
        state.groups.push(group(99, [], { x: 0, y: 0 }));
        state.groupsById.set(99, state.groups[2]);
        scene.sync(state);
        expect(scene.groupState(99)).toEqual({ selected: false, dragging: false });
    });

    test('isOuterEdge is false for edges whose mate joined the same group', () => {
        const state = pairState();
        const scene = makeScene(state);
        expect(scene.isOuterEdge(0)).toBe(true);
        expect(scene.isOuterEdge(1)).toBe(true);
        expect(scene.isOuterEdge(10)).toBe(true);
        mergePair(state);
        scene.sync(state);
        expect(scene.isOuterEdge(0)).toBe(false);
        expect(scene.isOuterEdge(1)).toBe(false);
        expect(scene.isOuterEdge(10)).toBe(true);
    });

    test('sync on unchanged state reports no changes', () => {
        const state = pairState();
        const scene = makeScene(state);
        expect(scene.sync(state)).toEqual({
            transforms: false, order: false, outerEdges: false, groupsChanged: [],
        });
        state.groups[1].position = { x: 301, y: 0 };
        expect(scene.sync(state)).toEqual({
            transforms: true, order: false, outerEdges: false, groupsChanged: [11],
        });
    });

    test('a move-only sync updates the group transform and settles', () => {
        const state = pairState();
        const scene = makeScene(state);
        state.groups[1].position = { x: 301, y: 5 };
        state.groups[1].rotation = 90;
        expect(scene.sync(state)).toEqual({
            transforms: true, order: false, outerEdges: false, groupsChanged: [11],
        });
        const [cos, sin, tx, ty] = slot(scene.pieceTransforms(), 1);
        expect(cos).toBeCloseTo(0, 6);
        expect(sin).toBeCloseTo(1, 6);
        expect([tx, ty]).toEqual([301, 5]);
        expect(scene.sync(state).groupsChanged).toEqual([]);
    });

    test('removing a group reports order and membership changes', () => {
        const state = pairState();
        const scene = makeScene(state);
        removeGroup(state, 10);
        const changes = scene.sync(state);
        expect(scene.orderedGroupIds()).toEqual([11]);
        expect(changes).toMatchObject({ transforms: true, order: true, outerEdges: true, groupsChanged: [10] });
    });

    test('a Scene built for a new game shares nothing with the previous one', () => {
        const first = pairState();
        const firstScene = makeScene(first);
        firstScene.setSelected(10, true);
        mergePair(first);
        firstScene.sync(first);

        const second = makeGameState({
            pieces: [makeRectPiece({ id: 0, width: 200 }), makeRectPiece({ id: 1 })],
            groups: [{
                id: 10,
                pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                position: { x: 50, y: 60 },
                rotation: 0,
            }],
        });
        const secondScene = makeScene(second);
        const t = secondScene.pieceTransforms();
        expect(slot(t, 0).slice(2, 4)).toEqual([50, 60]);
        expect(slot(t, 1).slice(2, 4)).toEqual([150, 60]);
        expect(secondScene.isOuterEdge(0)).toBe(true);
        expect(secondScene.isOuterEdge(1)).toBe(true);
        expect(secondScene.meshFor(0)!.bounds.maxX).toBe(200);
        expect(secondScene.meshFor(2)).toBeUndefined();
        expect(secondScene.groupState(10).selected).toBe(false);
        expect(secondScene.orderedGroupIds()).toEqual([10]);
        expect(firstScene.isOuterEdge(0)).toBe(false);
        expect(firstScene.meshFor(0)!.bounds.maxX).not.toBe(200);
    });

    test('rotation override rotates about the pivot, pinned at the model position', () => {
        const state = pairState();
        state.groups[0].position = { x: 100, y: 100 };
        const scene = makeScene(state);
        scene.setRotationOverride(10, 90, { x: 10, y: 0 });
        let t = scene.pieceTransforms();
        // Pivot world (110,100) stays fixed; local origin swings to (110,90).
        expect(t[1]).toBeCloseTo(1, 5);
        expect(t[2]).toBeCloseTo(110, 4);
        expect(t[3]).toBeCloseTo(90, 4);
        expect(scene.sync(state).transforms).toBe(true);
        scene.setRotationOverride(10, 0, null);
        t = scene.pieceTransforms();
        expect(slot(t, 0).slice(0, 4)).toEqual([1, 0, 100, 100]);
    });

    test('groupLayout lists a group\'s pieces and slotOfPiece maps ids to state.pieces indexes', () => {
        const scene = makeScene(pairState());
        expect(scene.groupLayout(11).map((p) => p.id)).toEqual([1]);
        expect(scene.groupLayout(999)).toEqual([]);
        expect(scene.slotOfPiece(1)).toBe(1);
        expect(scene.slotOfPiece(42)).toBeUndefined();
    });

    test('a move-only sync keeps the group\'s layout snapshot', () => {
        const state = pairState();
        const scene = makeScene(state);
        const layout = scene.groupLayout(11);
        state.groups[1].position = { x: 400, y: 0 };
        scene.sync(state);
        expect(scene.groupLayout(11)).toBe(layout);
    });
});
