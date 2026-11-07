/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { GameState, PieceGroup } from '../model/types.js';
import { ViewportTransform } from '../interaction/index.js';
import { computeGatheredPositions, computeSplitGatheredPositions, splitGatherGutter } from '../game/index.js';
import { createFakeRenderer, type FakeRenderer } from '../test-helpers/fake-renderer.js';
import { makeGameState, makeCenteredGroup, makeRectPiece } from '../test-helpers/fixtures.js';
import { VIEWPORT_TRANSITION_MS } from '../renderer/index.js';
import { gatherAndZoomToFit, SETTLE_GRACE_MS, zoomToFitCompletedPuzzle } from './viewport-fit.js';

/**
 * The two deadlines the fallback timer is armed to, derived not hardcoded:
 * raising the renderer's transition moves these with it.
 */
const TABLE_DEADLINE_MS = VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS;
const NO_TABLE_DEADLINE_MS = VIEWPORT_TRANSITION_MS;

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
        vi.useFakeTimers();
        container = document.createElement('div');
        renderer = createFakeRenderer();
        viewportTransform = new ViewportTransform();
        applyTransform = vi.fn();
        renderCurrent = vi.fn();
        deps = { container, renderer, viewportTransform, applyTransform, renderCurrent };
        // requestAnimationFrame runs the transform application one frame later.
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('normalizes a completed rotation to upright', () => {
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 350;

        zoomToFitCompletedPuzzle(state, group, deps, () => {});

        // 350° takes the +10° short way to an upright resting angle.
        expect(group.rotation).toBe(0);
    });

    it('spins the DOM element the short way (+10°), not the long way (-350°)', () => {
        // The settled model rotation is always 0, so it can't distinguish +10°
        // from -350° — only the CSS transition target written to the element
        // shows which way it spins.
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 350;

        const groupEl = document.createElement('div');
        groupEl.dataset.groupId = String(group.id);
        container.appendChild(groupEl);

        zoomToFitCompletedPuzzle(state, group, deps, () => {});

        // 350° animates to 360° (the +10° short way), not 0° (the -350° way),
        // though both rest upright.
        expect(groupEl.style.transform).toContain('rotate(360deg)');
        // The origin must be pinned to the image center (50,50 here) — without
        // it the rotation pivots about (0,0) and orbits instead of spinning in place.
        expect(groupEl.style.transformOrigin).toBe('50px 50px');
    });

    it('forces a reflow between the re-anchor frame and the spin frame', () => {
        // Without the forced reflow, the browser coalesces the re-anchor
        // (transition: none) and the spin (a real transition) into one paint,
        // collapsing the animation to a single frame.
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 90;

        const groupEl = document.createElement('div');
        groupEl.dataset.groupId = String(group.id);
        container.appendChild(groupEl);
        const reflowSpy = vi.spyOn(groupEl, 'getBoundingClientRect');

        zoomToFitCompletedPuzzle(state, group, deps, () => {});

        expect(reflowSpy).toHaveBeenCalled();
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

    it('enables the viewport transition and disables it when the transition ends', () => {
        const state = makeCompletedState();
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        container.appendChild(table);

        const onComplete = vi.fn();
        zoomToFitCompletedPuzzle(state, state.groups[0], deps, onComplete);

        expect(renderer.enableViewportTransition).toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();

        table.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'transform' }));

        expect(renderer.disableViewportTransition).toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('ignores a transitionend for an unrelated CSS property', () => {
        // The table transitions other properties too (e.g. background-color
        // on theme change); only "transform" ending means the zoom is done.
        const state = makeCompletedState();
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        container.appendChild(table);

        const onComplete = vi.fn();
        zoomToFitCompletedPuzzle(state, state.groups[0], deps, onComplete);

        table.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'opacity' }));

        expect(onComplete).not.toHaveBeenCalled();
    });

    it('does not fire onComplete twice for a repeated transitionend', () => {
        // The handler must unsubscribe once it fires, or a second "transform"
        // transitionend would run the completion callback again.
        const state = makeCompletedState();
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        container.appendChild(table);

        const onComplete = vi.fn();
        zoomToFitCompletedPuzzle(state, state.groups[0], deps, onComplete);

        const dispatchTransformEnd = () =>
            table.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'transform' }));
        dispatchTransformEnd();
        dispatchTransformEnd();

        expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('settles on the timer when the transform never transitions', () => {
        // A `transform` transition only starts when the transform changes. Two
        // Solves in a row frame the same group from the same viewport, so the
        // second target is identical, no transition runs and `transitionend`
        // never fires. Without a timer here too, the viewport transition is
        // never disabled (every later pan/zoom animates), the listener stays on
        // an element the renderer never replaces, and the spun group's element
        // is retained.
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 90;
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        container.appendChild(table);
        const groupEl = document.createElement('div');
        groupEl.dataset.groupId = String(group.id);
        container.appendChild(groupEl);

        const onComplete = vi.fn();
        zoomToFitCompletedPuzzle(state, group, deps, onComplete);

        // The zoom, then the grace on top. Not settled at the nominal duration:
        // the real transitionend must win the ordinary race, or the timer cuts
        // the zoom short.
        vi.advanceTimersByTime(VIEWPORT_TRANSITION_MS);
        expect(onComplete).not.toHaveBeenCalled();

        vi.advanceTimersByTime(SETTLE_GRACE_MS);
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(renderer.disableViewportTransition).toHaveBeenCalledTimes(1);
        expect(renderCurrent).toHaveBeenCalledTimes(1);
    });

    it('removes its transitionend listener when the timer settles it', () => {
        // The listener lands on `[data-puzzle-table]`, which `renderState` never
        // replaces — one never removed lives for the session, one per
        // completion. A leaked listener can't re-run `onComplete` (the latch
        // stops that), so the registration itself has to be checked.
        const state = makeCompletedState();
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        container.appendChild(table);
        const add = vi.spyOn(table, 'addEventListener');
        const remove = vi.spyOn(table, 'removeEventListener');

        zoomToFitCompletedPuzzle(state, state.groups[0], deps, () => {});
        vi.advanceTimersByTime(TABLE_DEADLINE_MS);

        // Same handler identities and order: what was wired is exactly what was
        // unwired, not merely "something was removed".
        expect(add.mock.calls.length).toBeGreaterThan(0);
        expect(remove.mock.calls).toEqual(add.mock.calls);
    });

    it('cancels the fallback timer when the transition ends first', () => {
        // The ordinary path: the timer is a net, not a second completion.
        const state = makeCompletedState();
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        container.appendChild(table);

        const onComplete = vi.fn();
        zoomToFitCompletedPuzzle(state, state.groups[0], deps, onComplete);
        table.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'transform' }));
        expect(onComplete).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(TABLE_DEADLINE_MS);

        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(renderer.disableViewportTransition).toHaveBeenCalledTimes(1);
    });

    it('re-renders whatever game is current when the cleanup fires, not the state captured at call time', () => {
        // The cleanup can fire up to 1000ms after this call, by which time a new
        // game may have started, so it must read state fresh via `renderCurrent`,
        // not repaint the captured `state`. The cleanup only exists for a
        // non-zero rotation with a found DOM element, so both are set up here.
        const state = makeCompletedState();
        const group = state.groups[0];
        group.rotation = 90;

        const groupEl = document.createElement('div');
        groupEl.dataset.groupId = String(group.id);
        container.appendChild(groupEl);

        zoomToFitCompletedPuzzle(state, group, deps, () => {});
        vi.advanceTimersByTime(NO_TABLE_DEADLINE_MS);

        expect(renderCurrent).toHaveBeenCalledTimes(1);
        expect(renderer.renderState).not.toHaveBeenCalled();
    });

    it('falls back to a timer when the table element is missing', () => {
        const state = makeCompletedState();
        const onComplete = vi.fn();

        zoomToFitCompletedPuzzle(state, state.groups[0], deps, onComplete);
        expect(onComplete).not.toHaveBeenCalled();

        vi.advanceTimersByTime(NO_TABLE_DEADLINE_MS);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });
});
