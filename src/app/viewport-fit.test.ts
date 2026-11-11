/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { GameState, PieceGroup } from '../model/types.js';
import { ViewportTransform } from '../interaction/index.js';
import { computeGatheredPositions, computeSplitGatheredPositions, splitGatherGutter } from '../game/index.js';
import { createFakeRenderer, type FakeRenderer } from '../test-helpers/fake-renderer.js';
import { makeGameState, makeCenteredGroup, makeRectPiece } from '../test-helpers/fixtures.js';
import { getGroupImageCenter } from '../game/index.js';
import { gatherAndZoomToFit, zoomToFitCompletedPuzzle } from './viewport-fit.js';

/**
 * Two real groups so `computeGatheredPositions`/`applyGatheredPositions` have
 * something to pack and move.
 */
function makeMultiGroupState(): GameState {
    const pieces = [
        makeRectPiece({ id: 0, width: 100, height: 100 }),
        makeRectPiece({ id: 1, width: 100, height: 100 }),
    ];
    const groups: PieceGroup[] = [
        makeCenteredGroup(0, 0, { x: 100, y: 100 }),
        makeCenteredGroup(1, 1, { x: 500, y: 500 }),
    ];
    return makeGameState({ pieces, groups });
}

/**
 * The single group a completed puzzle has — one piece suffices, the completion
 * math only needs real bounds.
 */
function makeCompletedState(): GameState {
    const pieces = [makeRectPiece({ id: 0, width: 100, height: 100 })];
    const groups: PieceGroup[] = [makeCenteredGroup(0, 0, { x: 100, y: 100 })];
    return makeGameState({ pieces, groups });
}

describe('gatherAndZoomToFit', () => {
    let container: HTMLElement;
    let renderer: FakeRenderer;
    let viewportTransform: ViewportTransform;
    // `Mock<() => void>`, not `ReturnType<typeof vi.fn>` — the latter widens
    // and stops being assignable to `ViewportFitDeps.applyTransform`.
    let applyTransform: Mock<() => void>;
    let renderCurrent: Mock<() => void>;

    beforeEach(() => {
        container = document.createElement('div');
        // jsdom reports 0 for clientWidth/Height; the code falls back to
        // window.innerWidth/Height, which jsdom defaults to 1024x768.
        renderer = createFakeRenderer();
        viewportTransform = new ViewportTransform();
        applyTransform = vi.fn();
        renderCurrent = vi.fn();
    });

    it('scales to fit with 10% padding and centers the layout', () => {
        const state = makeMultiGroupState();
        // Independent reference: computeGatheredPositions is deterministic for
        // this fixture (two identical groups, so the shuffle can't change the
        // bounds), so the expected scale/offset derive from the real layout
        // instead of magic numbers.
        const aspectRatio = window.innerWidth / window.innerHeight;
        const { layoutBounds } = computeGatheredPositions(state.groups, aspectRatio, state.piecesById);
        const expectedScale = Math.min(
            window.innerWidth / layoutBounds.width,
            window.innerHeight / layoutBounds.height,
        ) * 0.9;
        const expectedCenterX = layoutBounds.x + layoutBounds.width / 2;
        const expectedCenterY = layoutBounds.y + layoutBounds.height / 2;

        gatherAndZoomToFit(state, { container, renderer, viewportTransform, applyTransform, renderCurrent });

        const { scale, offset } = viewportTransform.getState();
        expect(scale).toBe(expectedScale);
        expect(offset.x).toBe(window.innerWidth / 2 - expectedCenterX * scale);
        expect(offset.y).toBe(window.innerHeight / 2 - expectedCenterY * scale);
        expect(applyTransform).toHaveBeenCalled();
    });

    it('moves the groups, not just the viewport', () => {
        const state = makeMultiGroupState();
        const before = state.groups.map((g) => ({ ...g.position }));

        gatherAndZoomToFit(state, { container, renderer, viewportTransform, applyTransform, renderCurrent });

        const after = state.groups.map((g) => g.position);
        expect(after).not.toEqual(before);
    });

    it('gathers the selection apart from the rest and fits both in view', () => {
        const state = makeMultiGroupState();
        const selected = new Set([1]);
        const aspectRatio = window.innerWidth / window.innerHeight;
        const { positions, layoutBounds } = computeSplitGatheredPositions(
            state.groups,
            selected,
            aspectRatio,
            state.piecesById,
            splitGatherGutter(state.imageSize, state.pieces.length),
        );
        const expectedScale = Math.min(
            window.innerWidth / layoutBounds.width,
            window.innerHeight / layoutBounds.height,
        ) * 0.9;

        gatherAndZoomToFit(state, { container, renderer, viewportTransform, applyTransform, renderCurrent }, selected);

        expect(state.groupsById.get(1)!.position).toEqual(positions.get(1));
        expect(state.groupsById.get(1)!.position.x).toBeLessThan(state.groupsById.get(0)!.position.x);
        expect(viewportTransform.getState().scale).toBe(expectedScale);
    });
});

describe('zoomToFitCompletedPuzzle', () => {
    let container: HTMLElement;
    let renderer: FakeRenderer;
    let viewportTransform: ViewportTransform;
    // `Mock<() => void>`, not `ReturnType<typeof vi.fn>` — the latter widens
    // and stops being assignable to `ViewportFitDeps.applyTransform`.
    let applyTransform: Mock<() => void>;
    let renderCurrent: Mock<() => void>;
    let deps: Parameters<typeof zoomToFitCompletedPuzzle>[2];

    beforeEach(() => {
        container = document.createElement('div');
        renderer = createFakeRenderer();
        viewportTransform = new ViewportTransform();
        applyTransform = vi.fn();
        renderCurrent = vi.fn();
        deps = { container, renderer, viewportTransform, applyTransform, renderCurrent };
    });

    it('normalizes a completed rotation to upright', () => {
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 350;

        zoomToFitCompletedPuzzle(state, group, deps, () => {});

        // 350° takes the +10° short way to an upright resting angle.
        expect(group.rotation).toBe(0);
    });

    it('compensates position so the puzzle does not move when the pivot changes', () => {
        // Re-anchoring transform-origin to the image center must keep the same
        // world point, or it jumps before the spin. Exact value, not just
        // "changed": a sign flip or wrong angle would also change position but
        // land wrong.
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 90;

        zoomToFitCompletedPuzzle(state, group, deps, () => {});

        expect(group.position).toEqual({ x: -50, y: 50 });
    });

    it('leaves position alone for a puzzle completed upright', () => {
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 0;
        const before = { ...group.position };

        zoomToFitCompletedPuzzle(state, group, deps, () => {});

        expect(group.position).toEqual(before);
    });

    function deferred(): { promise: Promise<void>; resolve: () => void } {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        return { promise, resolve };
    }

    const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });

    it('completion zoom calls transitionViewport with the fit transform and completes after it resolves', async () => {
        const state = makeCompletedState();
        const zoom = deferred();
        renderer.transitionViewport.mockReturnValueOnce(zoom.promise);
        const onComplete = vi.fn();

        zoomToFitCompletedPuzzle(state, state.groups[0], deps, onComplete);

        const { scale, offset } = viewportTransform.getState();
        expect(renderer.transitionViewport).toHaveBeenCalledExactlyOnceWith(scale, offset.x, offset.y);
        expect(applyTransform).not.toHaveBeenCalled();
        await flush();
        expect(onComplete).not.toHaveBeenCalled();
        expect(renderCurrent).not.toHaveBeenCalled();

        zoom.resolve();
        await flush();

        expect(renderCurrent).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(renderCurrent.mock.invocationCallOrder[0])
            .toBeLessThan(onComplete.mock.invocationCallOrder[0]);
    });

    it('a rotated completed group spins via animateGroupRotation to the shortest upright angle about the image center', async () => {
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 300;
        const centerLocal = getGroupImageCenter(group, state.piecesById);
        const spin = deferred();
        renderer.animateGroupRotation.mockReturnValueOnce(spin.promise);
        const onComplete = vi.fn();

        zoomToFitCompletedPuzzle(state, group, deps, onComplete);

        expect(renderer.animateGroupRotation)
            .toHaveBeenCalledExactlyOnceWith(group.id, 360, centerLocal);
        expect(group.rotation).toBe(0);
        await flush();
        expect(onComplete).not.toHaveBeenCalled();

        spin.resolve();
        await flush();
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('does not spin a group that is already upright', () => {
        const state = makeCompletedState();

        zoomToFitCompletedPuzzle(state, state.groups[0], deps, () => {});

        expect(renderer.animateGroupRotation).not.toHaveBeenCalled();
    });
});
