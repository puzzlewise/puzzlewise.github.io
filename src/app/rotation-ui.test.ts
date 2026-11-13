/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance } from 'vitest';
import type { GameState, Piece, PieceGroup } from '../model/types.js';
import type { MergeResult } from '../game/group-merging.js';
import { SelectionManager } from '../interaction/selection-manager.js';
import { RotationFocus, ViewportTransform } from '../interaction/index.js';
import { SnapProximityPositionController } from '../interaction/snap-proximity-position-controller.js';
import { createFakeRenderer, type FakeRenderer } from '../test-helpers/fake-renderer.js';
import {
    makeGameState,
    makeCenteredGroup,
    makeMatedPiecePair,
    makePiece,
    makeRectPiece,
    makeTwoMatedEndsRow,
} from '../test-helpers/fixtures.js';
import { getGroup, getWorldPosition, localToWorld } from '../model/helpers.js';
import { getGroupLocalBounds } from '../game/index.js';
import {
    createRotateButtons,
    createRotateHandle,
    type RotateButtonsHandle,
    type RotateButtonsOptions,
    type RotateHandleHandle,
    type RotateHandleOptions,
} from '../ui/index.js';

// `createRotateButtons`/`createRotateHandle` only touch the DOM once
// `rotationFocus` has a focused group, so DOM assertions here would be vacuous
// or duplicate that setup. Replace the two factories with spy handles instead:
// `syncVisibility` is asserted against `show`/`hide`, and the callbacks are
// driven through the options each factory was handed.
//
// Passthrough, not a two-export factory: `rotation-ui.ts` also reaches this
// barrel transitively via `snap-tolerances.ts`, which every commit path calls;
// replacing the module wholesale would fail those with "No export is defined".
vi.mock('../ui/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../ui/index.js')>();
    return {
        ...actual,
        createRotateButtons: vi.fn(() => ({
            show: vi.fn(),
            hide: vi.fn(),
            destroy: vi.fn(),
        })),
        createRotateHandle: vi.fn(() => ({
            show: vi.fn(),
            hide: vi.fn(),
            destroy: vi.fn(),
        })),
    };
});

import { createRotationUi } from './rotation-ui.js';

function lastButtonsHandle(): RotateButtonsHandle {
    const last = vi.mocked(createRotateButtons).mock.results.at(-1);
    if (!last) throw new Error('createRotateButtons was never called');
    return last.value;
}

function lastHandleHandle(): RotateHandleHandle {
    const last = vi.mocked(createRotateHandle).mock.results.at(-1);
    if (!last) throw new Error('createRotateHandle was never called');
    return last.value;
}

function buttonsOptions(): RotateButtonsOptions {
    const last = vi.mocked(createRotateButtons).mock.calls.at(-1);
    if (!last) throw new Error('createRotateButtons was never called');
    return last[0];
}

function handleOptions(): RotateHandleOptions {
    const last = vi.mocked(createRotateHandle).mock.calls.at(-1);
    if (!last) throw new Error('createRotateHandle was never called');
    return last[0];
}

/**
 * One real group so bounds/pivot math has something to measure. Group id 9
 * (neither 0 nor an array index) so an assertion on a specific id can't pass
 * by coincidence.
 */
function makeStateWithGroup(): GameState {
    const pieces = [makeRectPiece({ id: 0, width: 100, height: 100 })];
    const groups: PieceGroup[] = [makeCenteredGroup(9, 0, { x: 100, y: 100 })];
    return makeGameState({ pieces, groups });
}

function groupBoundsCenterWorld(state: GameState, groupId: number): { x: number; y: number } {
    const group = getGroup(state, groupId);
    const bounds = getGroupLocalBounds(group, state.piecesById);
    return localToWorld(
        { x: bounds.minX + bounds.width / 2, y: bounds.minY + bounds.height / 2 },
        group,
    );
}

/**
 * A 100×100 piece whose top edge bulges 30 units above the corner line. The
 * bulge separates the two candidate pivots: tab-inclusive local bounds run
 * y ∈ [−30, 100], so their center sits 15 units above the corner-only image
 * center `getGroupImageCenter` returns. `makePiece` re-derives `bounds` from
 * the edges, so the tab is reflected there too.
 */
function makeTabbedPiece(id: number): Piece {
    const [top, ...sides] = makeRectPiece({ id, width: 100, height: 100 }).edges;
    return makePiece({ id, edges: [{ ...top, path: 'M0,0 C30,-30 70,-30 100,0' }, ...sides] });
}

describe('createRotationUi', () => {
    let container: HTMLElement;
    let renderer: FakeRenderer;
    let viewportTransform: ViewportTransform;
    let selectionManager: SelectionManager;
    let rotationFocus: RotationFocus;
    let state: GameState | undefined;
    // `Mock<...>`, not `ReturnType<typeof vi.fn>` — the latter widens and
    // stops being assignable to the dep's signature.
    let save: Mock<(state: GameState) => void>;
    let applyMerge: Mock<
        (state: GameState, result: MergeResult, droppedGroupIds: readonly number[]) => void
    >;
    // Prototype spies, not a module mock: `rotation-ui` constructs the
    // controller itself, so this is the only seam that can observe whether a
    // handle callback entered the snap gesture. Both keep the real
    // implementation. Torn down in `afterEach` — `vite.config.ts` sets no
    // `restoreMocks`, so a spy left on a shared prototype follows every later test.
    let snapStart: MockInstance<SnapProximityPositionController['start']>;
    let snapStop: MockInstance<SnapProximityPositionController['stop']>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
        snapStart = vi.spyOn(SnapProximityPositionController.prototype, 'start');
        snapStop = vi.spyOn(SnapProximityPositionController.prototype, 'stop');
        container = document.createElement('div');
        document.body.appendChild(container);
        renderer = createFakeRenderer();
        viewportTransform = new ViewportTransform();
        selectionManager = new SelectionManager();
        rotationFocus = new RotationFocus();
        state = makeStateWithGroup();
        save = vi.fn();
        applyMerge = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
        snapStart.mockRestore();
        snapStop.mockRestore();
        container.remove();
    });

    function make() {
        return createRotationUi({
            container,
            renderer,
            viewportTransform,
            selectionManager,
            rotationFocus,
            getState: () => state,
            save,
            applyMerge,
        });
    }

    describe('syncVisibility', () => {
        it('shows the quarter-turn buttons and hides the free handle', () => {
            const ui = make();
            ui.syncVisibility(makeGameState({ rotationMode: 'quarter-turn' }));

            expect(lastButtonsHandle().show).toHaveBeenCalledTimes(1);
            expect(lastButtonsHandle().hide).not.toHaveBeenCalled();
            expect(lastHandleHandle().hide).toHaveBeenCalledTimes(1);
            expect(lastHandleHandle().show).not.toHaveBeenCalled();
        });

        it('shows the free-rotate handle and hides the quarter-turn buttons', () => {
            const ui = make();
            ui.syncVisibility(makeGameState({ rotationMode: 'free' }));

            expect(lastHandleHandle().show).toHaveBeenCalledTimes(1);
            expect(lastHandleHandle().hide).not.toHaveBeenCalled();
            expect(lastButtonsHandle().hide).toHaveBeenCalledTimes(1);
            expect(lastButtonsHandle().show).not.toHaveBeenCalled();
        });

        it('hides both controls for a state with no rotation mode', () => {
            const ui = make();
            // `rotationMode` is optional; `makeGameState()` leaves it unset.
            ui.syncVisibility(makeGameState());

            expect(lastButtonsHandle().hide).toHaveBeenCalledTimes(1);
            expect(lastButtonsHandle().show).not.toHaveBeenCalled();
            expect(lastHandleHandle().hide).toHaveBeenCalledTimes(1);
            expect(lastHandleHandle().show).not.toHaveBeenCalled();
        });

        it('tolerates being asked to sync with no game, hiding both controls', () => {
            // Boot can leave no game behind; syncing must not throw and must
            // hide, not leave the prior control showing.
            const ui = make();
            expect(() => ui.syncVisibility(undefined)).not.toThrow();

            expect(lastButtonsHandle().hide).toHaveBeenCalledTimes(1);
            expect(lastHandleHandle().hide).toHaveBeenCalledTimes(1);
        });

        it('survives being called detached from the returned object', () => {
            // The composition root passes `syncVisibility` as a bare value (no
            // `.bind`). A `this` dependency (e.g. method shorthand) would break
            // when destructured out and called standalone.
            const ui = make();
            const { syncVisibility } = ui;

            syncVisibility(makeGameState({ rotationMode: 'quarter-turn' }));

            expect(lastButtonsHandle().show).toHaveBeenCalledTimes(1);
            expect(lastHandleHandle().hide).toHaveBeenCalledTimes(1);
        });
    });

    // Asserted through the options the controls were handed, not the returned
    // object: that's the only production consumer, and the projector isn't part
    // of `RotationUi`'s surface.
    describe('getFocusedGroupScreenBounds', () => {
        it('is handed to both controls', () => {
            make();

            expect(buttonsOptions().getFocusedGroupScreenBounds).toBe(
                handleOptions().getFocusedGroupScreenBounds,
            );
        });

        it('returns null for a group that is gone', () => {
            make();
            expect(buttonsOptions().getFocusedGroupScreenBounds(4242)).toBeNull();
        });

        it('returns null when there is no game at all', () => {
            make();
            state = undefined;
            expect(buttonsOptions().getFocusedGroupScreenBounds(9)).toBeNull();
        });

        it('projects a live group into screen space', () => {
            make();
            const bounds = buttonsOptions().getFocusedGroupScreenBounds(9);

            expect(bounds).not.toBeNull();
            // Identity viewport transform: world bounds pass through unchanged,
            // so the exact numbers are pinned. Group centered at (100,100) with
            // a 100x100 piece spans (50,50)-(150,150).
            expect(bounds).toEqual({ left: 50, top: 50, right: 150, bottom: 150 });
        });
    });

    describe('quarter-turn rotation', () => {
        it('rotates the group, re-renders and saves', () => {
            make();
            selectionManager.select(9);
            renderer.setGroupSelected.mockClear();

            buttonsOptions().onRotate(9, 'cw');

            expect(state!.groupsById.get(9)!.rotation).toBe(90);
            expect(renderer.renderState).toHaveBeenCalledWith(state);
            // Re-render recreates group elements, so the selection visual must
            // be re-applied or the highlight silently drops.
            expect(renderer.setGroupSelected).toHaveBeenCalledWith(9, true);
            expect(save).toHaveBeenCalledWith(state);
        });

        it('rotates counter-clockwise for a ccw tap', () => {
            make();
            buttonsOptions().onRotate(9, 'ccw');

            // `rotateGroup` normalizes into [0, 360), so a −90° delta lands on 270.
            expect(state!.groupsById.get(9)!.rotation).toBe(270);
        });

        it('does nothing with no game', () => {
            make();
            state = undefined;

            expect(() => buttonsOptions().onRotate(9, 'cw')).not.toThrow();
            expect(save).not.toHaveBeenCalled();
        });

        it('does nothing for a group that is gone', () => {
            make();

            buttonsOptions().onRotate(4242, 'cw');

            expect(renderer.renderState).not.toHaveBeenCalled();
            expect(save).not.toHaveBeenCalled();
        });
    });

    describe('free rotation', () => {
        it('rotates by the drag delta and re-renders without saving', () => {
            // The drag fires this per frame; saving per tick would restart the
            // debounced write continuously. The commit saves.
            make();
            selectionManager.select(9);
            renderer.setGroupSelected.mockClear();

            handleOptions().onRotate(9, 12);
            vi.advanceTimersToNextFrame();

            expect(state!.groupsById.get(9)!.rotation).toBe(12);
            expect(renderer.renderState).toHaveBeenCalledWith(state);
            expect(renderer.setGroupSelected).toHaveBeenCalledWith(9, true);
            expect(save).not.toHaveBeenCalled();
        });

        it('renders several handle moves in one frame once, on that frame', () => {
            make();

            handleOptions().onRotate(9, 5);
            handleOptions().onRotate(9, 5);
            handleOptions().onRotate(9, 5);
            expect(renderer.renderState).not.toHaveBeenCalled();
            vi.advanceTimersToNextFrame();

            expect(renderer.renderState).toHaveBeenCalledTimes(1);
            expect(state!.groupsById.get(9)!.rotation).toBe(15);
        });

        it.each([
            ['commits', () => handleOptions().onCommit(9)],
            ['is canceled', () => handleOptions().onRotateEnd(9)],
        ])('renders a pending move at once when the drag %s, and not again on the next frame', (_, end) => {
            make();
            handleOptions().onRotate(9, 12);

            end();
            expect(renderer.renderState).toHaveBeenCalledTimes(1);
            vi.advanceTimersToNextFrame();

            expect(renderer.renderState).toHaveBeenCalledTimes(1);
        });

        it('does not open a snap-proximity gesture when no mate is in range', () => {
            // Unanchored, the assist keeps every candidate live and bbox-center
            // rotation sweeps their piece-anchored distances — a far mate could
            // latch mid-drag and translate a pure rotation.
            make();

            handleOptions().onRotateStart(9);

            expect(snapStart).not.toHaveBeenCalled();
        });

        it('anchors the snap-proximity gesture to the manual pivot piece', () => {
            // The assist must target the same mate the rotation is anchored on;
            // an unanchored assist could chase a different mate and slide the
            // pivot piece out of merge range mid-rotate.
            state = makeTwoMatedEndsRow(1).state;
            make();

            handleOptions().onRotateStart(11);

            expect(snapStart).toHaveBeenCalledWith(11, 1);
        });

        it('declines a rotate start with no game, without opening a gesture', () => {
            // `SnapProximityPositionController.start` tolerates an undefined
            // state, so "returned null" alone would pass with the guard deleted.
            // Asserting the controller is never entered pins the guard.
            make();
            state = undefined;

            expect(handleOptions().onRotateStart(9)).toBeNull();

            expect(snapStart).not.toHaveBeenCalled();
        });

        it('declines a rotate start for a group that is gone', () => {
            make();

            expect(handleOptions().onRotateStart(4242)).toBeNull();

            expect(snapStart).not.toHaveBeenCalled();
        });

        it('closes the snap-proximity gesture when the drag ends', () => {
            // Unconditional: the gesture must release on a canceled drag too,
            // or the stale context follows the next one.
            make();

            handleOptions().onRotateEnd(9);

            expect(snapStop).toHaveBeenCalledTimes(1);
        });

        it('reports the focused group rotation, and null once it is gone', () => {
            make();
            state!.groupsById.get(9)!.rotation = 45;

            expect(handleOptions().getGroupRotation(9)).toBe(45);
            expect(handleOptions().getGroupRotation(4242)).toBeNull();
        });
    });

    describe('drag pivot (onRotateStart return value)', () => {
        it('pivots about the tab-inclusive bounds center, in world space', () => {
            // The pivot the drag rotates around, pinned by exact number: the
            // bounds include tab path geometry (a corner-only center would sit
            // 15 units lower), and the local center is projected through the
            // group's rotation, not merely offset by position. Tab-inclusive
            // bounds x ∈ [0,100], y ∈ [−30,100] → center (50,35); rotated 90° CW
            // → (−35,50), landing at (200−35, 300+50).
            const pieces = [makeTabbedPiece(0)];
            const groups: PieceGroup[] = [
                { id: 9, pieces: new Map([[0, { x: 0, y: 0 }]]), position: { x: 200, y: 300 }, rotation: 90 },
            ];
            state = makeGameState({ pieces, groups });
            make();

            expect(handleOptions().onRotateStart(9)).toEqual({ x: 165, y: 350 });
        });
    });

    describe('manual rotation pivot latch', () => {
        // makeTwoMatedEndsRow(1): group 11 is a five-piece row at 8° whose
        // piece 1 (world center (150,50)) sits 7.2 px from its mate (within
        // tolerance) and piece 5 sits 10.8 px. The bbox center is 200 px from
        // piece 1, so a bbox-center pivot sweeps it far — every assertion below
        // discriminates the two pivots.
        it('onRotateStart returns the nearest mated piece center when in range', () => {
            state = makeTwoMatedEndsRow(1).state;
            make();

            const pivot = handleOptions().onRotateStart(11);
            expect(pivot!.x).toBeCloseTo(150);
            expect(pivot!.y).toBeCloseTo(50);
        });

        it('free rotation pivots on the piece latched at drag start', () => {
            state = makeTwoMatedEndsRow(1).state;
            make();

            handleOptions().onRotateStart(11);
            handleOptions().onRotate(11, 30);

            const center = getWorldPosition({ x: 50, y: 50 }, 1, getGroup(state!, 11));
            expect(center.x).toBeCloseTo(150);
            expect(center.y).toBeCloseTo(50);
        });

        it('never applies the latch to a group it was not computed for', () => {
            // The real handle only rotates the group it started on; this guard
            // stops a future lifecycle change from rotating another group about
            // a wrong-frame pivot.
            state = makeTwoMatedEndsRow(5).state;
            make();

            handleOptions().onRotateStart(11); // latches piece 5's center (450, 50)

            const before = groupBoundsCenterWorld(state!, 10);
            handleOptions().onRotate(10, 30);
            const after = groupBoundsCenterWorld(state!, 10);

            expect(after.x).toBeCloseTo(before.x);
            expect(after.y).toBeCloseTo(before.y);
        });

        it('releases the latch when the drag ends', () => {
            state = makeTwoMatedEndsRow(1).state;
            make();

            handleOptions().onRotateStart(11);
            handleOptions().onRotateEnd(11);

            // Group-center pivot: the bounds center holds still. A still-latched
            // piece pivot would sweep it — names the expected pivot, not just
            // excludes piece 1's.
            const before = groupBoundsCenterWorld(state!, 11);
            handleOptions().onRotate(11, 30);
            const after = groupBoundsCenterWorld(state!, 11);

            expect(after.x).toBeCloseTo(before.x);
            expect(after.y).toBeCloseTo(before.y);
        });

        it('quarter-turn taps always pivot on the group center, even near a mate', () => {
            state = makeTwoMatedEndsRow(1).state;
            make();

            // Quarter-turn rotation is deliberately outside the latch.
            const before = groupBoundsCenterWorld(state!, 11);
            buttonsOptions().onRotate(11, 'cw');
            const after = groupBoundsCenterWorld(state!, 11);

            expect(after.x).toBeCloseTo(before.x);
            expect(after.y).toBeCloseTo(before.y);
        });
    });

    describe('commit', () => {
        it('hands a merge off to applyMerge and saves', () => {
            // Two mated pieces at exactly their aligned offset, so `processDrop`
            // merges for the real reason (real tolerances via the un-mocked
            // `getActiveTolerance` the passthrough keeps reachable).
            const { piece0, piece1 } = makeMatedPiecePair();
            state = makeGameState({
                pieces: [piece0, piece1],
                groups: [
                    makeCenteredGroup(10, 0, { x: 50, y: 50 }),
                    makeCenteredGroup(11, 1, { x: 150, y: 50 }),
                ],
                rotationMode: 'free',
            });
            make();

            handleOptions().onCommit(11);

            expect(applyMerge).toHaveBeenCalledTimes(1);
            const [mergedState, result, droppedIds] = applyMerge.mock.calls[0];
            expect(mergedState).toBe(state);
            expect(droppedIds).toEqual([result.group.id]);
            expect(save).toHaveBeenCalledWith(state);
        });

        it('saves without a merge when the drop lands nowhere', () => {
            // The lone group in `makeStateWithGroup` has nothing to mate with.
            make();

            handleOptions().onCommit(9);

            expect(applyMerge).not.toHaveBeenCalled();
            expect(save).toHaveBeenCalledWith(state);
        });

        it('does nothing with no game', () => {
            make();
            state = undefined;

            expect(() => handleOptions().onCommit(9)).not.toThrow();
            expect(applyMerge).not.toHaveBeenCalled();
            expect(save).not.toHaveBeenCalled();
        });
    });
});
