/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { GameState, PieceGroup } from '../model/types.js';
import type { MergeResult } from '../game/group-merging.js';
import { SelectionManager } from '../interaction/selection-manager.js';
import { RotationFocus, ViewportTransform, setupInteraction } from '../interaction/index.js';
import type { InteractionSetupOptions } from '../interaction/index.js';
import { createFakeRenderer, type FakeRenderer } from '../test-helpers/fake-renderer.js';
import {
    makeGameState,
    makeCenteredGroup,
    makeMatedPiecePair,
    makeRectPiece,
} from '../test-helpers/fixtures.js';
import { activeSnapTolerances } from './snap-tolerances.js';
import { createGameSession, type GameSession } from './game-session.js';
import { zoomToFitCompletedPuzzle } from './viewport-fit.js';

// Plain `vi.spyOn` can't intercept a cross-module call under Vite; wrap the
// real `setupInteraction` via `vi.mock` passthrough so tests can inspect the
// options `install` built while still getting real wiring (the teardown test
// needs it).
vi.mock('../interaction/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../interaction/index.js')>();
    return {
        ...actual,
        setupInteraction: vi.fn(actual.setupInteraction),
    };
});

function lastInteractionOptions(): InteractionSetupOptions {
    const last = vi.mocked(setupInteraction).mock.calls.at(-1);
    if (!last) throw new Error('setupInteraction was never called');
    return last[0];
}

/**
 * Two real groups (not the default empty `groups: []`) so selection restore
 * has ids to match. Ids are 7 and 8 — neither 0 nor the array indexes — so an
 * id assertion can't pass by coincidence.
 */
function makeState(): GameState {
    const pieces = [
        makeRectPiece({ id: 0, width: 100, height: 100 }),
        makeRectPiece({ id: 1, width: 100, height: 100 }),
    ];
    const groups: PieceGroup[] = [
        makeCenteredGroup(7, 0, { x: 100, y: 100 }),
        makeCenteredGroup(8, 1, { x: 500, y: 500 }),
    ];
    return makeGameState({ pieces, groups });
}

describe('createGameSession', () => {
    let container: HTMLElement;
    let renderer: FakeRenderer;
    let viewportTransform: ViewportTransform;
    let selectionManager: SelectionManager;
    let rotationFocus: RotationFocus;
    // `Mock<(state) => void>`, not `ReturnType<typeof vi.fn>`: the latter
    // widens and stops being assignable to the dep's signature.
    let onInstalled: Mock<(state: GameState) => void>;
    let save: Mock<(state: GameState) => void>;
    let cancelPendingSave: Mock<() => void>;
    let applyMerge: Mock<
        (state: GameState, result: MergeResult, droppedGroupIds: readonly number[]) => void
    >;
    let applyTransform: Mock<() => void>;
    let onViewportChanged: Mock<() => void>;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        renderer = createFakeRenderer();
        viewportTransform = new ViewportTransform();
        selectionManager = new SelectionManager();
        rotationFocus = new RotationFocus();
        onInstalled = vi.fn();
        save = vi.fn();
        cancelPendingSave = vi.fn();
        applyMerge = vi.fn();
        applyTransform = vi.fn();
        onViewportChanged = vi.fn();
        vi.mocked(setupInteraction).mockClear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        container.remove();
        vi.restoreAllMocks();
    });

    function make(overrides: Partial<Parameters<typeof createGameSession>[0]> = {}): GameSession {
        return createGameSession({
            container,
            renderer,
            viewportTransform,
            selectionManager,
            rotationFocus,
            onInstalled,
            save,
            cancelPendingSave,
            applyMerge,
            applyTransform,
            onViewportChanged,
            ...overrides,
        });
    }

    it('reports no game before anything is installed', () => {
        const session = make();
        expect(session.current()).toBeUndefined();
        expect(session.hasGame()).toBe(false);
    });

    it('exposes the installed state', () => {
        const session = make();
        const state = makeState();
        session.install(state);
        expect(session.current()).toBe(state);
        expect(session.hasGame()).toBe(true);
    });

    it('keeps hasGame false until interaction is wired', () => {
        // #488: a throw between the state assignment and interaction setup must
        // still report no game, or the fallback is skipped and the player gets
        // a dead canvas. `onInstalled` runs inside that window, so it's the
        // probe; a holder passes it the session it's being handed.
        const holder: { session?: GameSession } = {};
        let hasGameDuringInstall: boolean | undefined;
        let stateDuringInstall: GameState | undefined;

        holder.session = make({
            onInstalled: () => {
                hasGameDuringInstall = holder.session?.hasGame();
                stateDuringInstall = holder.session?.current();
            },
        });
        const state = makeState();
        holder.session.install(state);

        // Not `toBeFalsy()`: `undefined` (onInstalled never ran) must fail.
        expect(hasGameDuringInstall).toBe(false);
        // State already installed here — proves the probe ran inside the window.
        expect(stateDuringInstall).toBe(state);
        expect(holder.session.hasGame()).toBe(true);
    });

    it('still reports no game when rendering throws mid-install', () => {
        const session = make();
        renderer.renderState.mockImplementationOnce(() => {
            throw new Error('render boom');
        });

        expect(() => session.install(makeState())).toThrow('render boom');
        expect(session.hasGame()).toBe(false);
    });

    it('still reports no game when onInstalled throws mid-install', () => {
        // Other half of the #488 window: a throw after render but before wiring.
        const session = make({
            onInstalled: () => {
                throw new Error('presenter boom');
            },
        });

        expect(() => session.install(makeState())).toThrow('presenter boom');
        expect(session.hasGame()).toBe(false);
    });

    it('wires interaction for an already-completed state too', () => {
        // Wiring is unconditional: a restored solved puzzle is still draggable
        // — the player can pull the finished picture apart.
        const session = make();
        session.install(makeGameState({ ...makeState(), completed: true }));
        expect(session.hasGame()).toBe(true);
    });

    it('renders the state and runs onInstalled', () => {
        const session = make();
        const state = makeState();
        session.install(state);
        expect(renderer.renderState).toHaveBeenCalledWith(state);
        expect(onInstalled).toHaveBeenCalledWith(state);
    });

    it('clears selection and rotation focus when a new game replaces an old one', () => {
        const session = make();
        session.install(makeState());
        selectionManager.toolActive = true;
        selectionManager.select(7);
        rotationFocus.setFocus(7);

        session.install(makeState());

        expect(selectionManager.hasSelection).toBe(false);
        expect(rotationFocus.focusedGroupId).toBeNull();
    });

    it('cancels a pending save on every install, after clearing the selection', () => {
        // #514: clearing the selection makes bootstrap's listener arm an
        // autosave for the *outgoing* puzzle, which the incoming slot then
        // refuses. `install` must cancel it, and only after the clear —
        // otherwise nothing is pending yet and the doomed save survives.
        const cancel = vi.fn(() => {
            expect(selectionManager.hasSelection).toBe(false);
        });
        const session = make({ cancelPendingSave: cancel });

        // Unconditional — also covers the edit-then-new-game race, where a real
        // edit (not a selection) armed the outgoing save.
        session.install(makeState());
        expect(cancel).toHaveBeenCalledTimes(1);

        selectionManager.toolActive = true;
        selectionManager.select(7);
        session.install(makeState());

        expect(cancel).toHaveBeenCalledTimes(2);
        expect(selectionManager.hasSelection).toBe(false);
    });

    it('tears down the previous interaction before wiring the next', () => {
        // Without this, every new game leaves another live pointer router on
        // the container and a single drag fires each of them.
        const add = vi.spyOn(container, 'addEventListener');
        const remove = vi.spyOn(container, 'removeEventListener');
        const session = make();

        session.install(makeState());
        const wiredByFirst = add.mock.calls.map(([type, listener]) => [type, listener]);
        expect(wiredByFirst.length).toBeGreaterThan(0);
        expect(remove).not.toHaveBeenCalled();

        session.install(makeState());

        // Same handler identities and order: the first install's listeners
        // specifically were removed.
        const unwired = remove.mock.calls.map(([type, listener]) => [type, listener]);
        expect(unwired).toEqual(wiredByFirst);
    });

    it('reports no game and tears down interaction after uninstall', () => {
        // #500: a failed share load rolls the session back so the boot
        // fallback's `hasGame()` gate doesn't read a half-applied puzzle as a
        // finished one. The listeners the install wired must come off too, or
        // uninstall leaks a live pointer router.
        const add = vi.spyOn(container, 'addEventListener');
        const remove = vi.spyOn(container, 'removeEventListener');
        const session = make();
        session.install(makeState());
        const wired = add.mock.calls.map(([type, listener]) => [type, listener]);
        expect(wired.length).toBeGreaterThan(0);

        session.uninstall();

        expect(session.current()).toBeUndefined();
        expect(session.hasGame()).toBe(false);
        expect(remove.mock.calls.map(([type, listener]) => [type, listener])).toEqual(wired);
    });

    it('is a no-op when nothing is installed', () => {
        const session = make();
        expect(() => session.uninstall()).not.toThrow();
        expect(session.current()).toBeUndefined();
        expect(session.hasGame()).toBe(false);
    });

    it('pans via applyTransform, which must not persist anything', () => {
        // `panViewport` fires every frame of an edge drag; routing it through
        // `onViewportChanged` (which saves) would restart the debounced save
        // each tick, so the two hooks stay separate deps.
        const session = make();
        session.install(makeState());

        lastInteractionOptions().panViewport?.({ x: 12, y: -4 });

        // The pan really happened, not just the callback.
        expect(viewportTransform.getState().offset).toEqual({ x: 12, y: -4 });
        expect(applyTransform).toHaveBeenCalledTimes(1);
        expect(onViewportChanged).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it('routes zoom/pan settle through onViewportChanged, which does persist', () => {
        // The other side of the same split: collapsing the two hooks in either
        // direction has to fail a test.
        const session = make();
        session.install(makeState());

        lastInteractionOptions().onViewportChanged();

        expect(onViewportChanged).toHaveBeenCalledTimes(1);
        expect(applyTransform).not.toHaveBeenCalled();
    });

    describe('the callbacks install wires into the interaction layer', () => {
        /**
         * Two mated pieces 25px past their aligned offset, so `processDrop`
         * merges only via the *active* tolerance: 33.3px (default `normal`
         * preset, 0.333 × the 100px reference width) admits it, `processDrop`'s
         * own 18px default does not — at exact alignment both admit and the
         * test proves nothing. Group ids 10/11 are neither the indexes nor
         * `makeState`'s 7/8.
         */
        const SNAP_OVERSHOOT_PX = 25;

        function makeMergeableState(): GameState {
            const { piece0, piece1 } = makeMatedPiecePair();
            return makeGameState({
                pieces: [piece0, piece1],
                groups: [
                    makeCenteredGroup(10, 0, { x: 50, y: 50 }),
                    makeCenteredGroup(11, 1, { x: 150 + SNAP_OVERSHOOT_PX, y: 50 }),
                ],
            });
        }

        it('saves the zoomed-to-fit viewport when the drop completes the puzzle', () => {
            const session = make();
            const state = makeMergeableState();
            session.install(state);
            const before = viewportTransform.getState();
            applyMerge.mockImplementation((mergedState) => {
                zoomToFitCompletedPuzzle(
                    mergedState,
                    mergedState.groups[0],
                    { container, renderer, viewportTransform, applyTransform, renderCurrent: vi.fn() },
                    vi.fn(),
                );
            });
            let saved: ReturnType<ViewportTransform['getState']> | undefined;
            save.mockImplementation(() => {
                saved = viewportTransform.getState();
            });

            lastInteractionOptions().onDrop(11);

            expect(renderer.transitionViewport).toHaveBeenCalledTimes(1);
            const [scale, x, y] = renderer.transitionViewport.mock.calls[0];
            expect(saved).toEqual({ scale, offset: { x, y } });
            expect(saved).not.toEqual(before);
        });

        it('hands a merging drop to applyMerge and saves the result', () => {
            const session = make();
            const state = makeMergeableState();
            session.install(state);

            lastInteractionOptions().onDrop(11);

            expect(applyMerge).toHaveBeenCalledTimes(1);
            const [mergedState, result, droppedIds] = applyMerge.mock.calls[0];
            expect(mergedState).toBe(state);
            expect(result.mergeCount).toBe(1);
            // The actual dropped ids, not `[]`: `applyMergeResult` drives
            // z-order and post-merge visuals off them, and `[]` passes silently.
            expect(droppedIds).toEqual([11]);
            // Merging is the only drop outcome that changes the puzzle, and
            // this is the only save on the path — dropping it loses the merge.
            expect(save).toHaveBeenCalledWith(state);
            // Saves the merged state, not the pre-merge one: `applyMerge`
            // mutates in place, so swapping the statements saves too early.
            expect(save.mock.invocationCallOrder[0])
                .toBeGreaterThan(applyMerge.mock.invocationCallOrder[0]);
            // The merge branch and the reorder branch are exclusive.
            expect(renderer.bringGroupToFront).not.toHaveBeenCalled();
        });

        it('merges on the player\'s active tolerance, not processDrop\'s default', () => {
            // 25px past alignment: inside the active tolerance (33.3px),
            // outside `processDrop`'s 18px fallback — so dropping `tolerancePx`
            // would stop the merge.
            const session = make();
            const state = makeMergeableState();
            session.install(state);

            expect(lastInteractionOptions().getSnapTolerances?.().tolerancePx)
                .toBeGreaterThan(SNAP_OVERSHOOT_PX);

            lastInteractionOptions().onDrop(11);

            expect(applyMerge).toHaveBeenCalledTimes(1);
        });

        it('merges on the player\'s active rotation tolerance too', () => {
            // The other half of `activeSnapTolerances`: the dropped group is
            // 15° off its mate — inside the active rotation tolerance (20°),
            // outside `processDrop`'s 10° fallback.
            //
            // Rotation is the only variable: both groups are bbox-center 100px
            // apart, exactly where the mated pair aligns, and the rotation snap
            // pivots about the shared center, so residual distance is ~0 and
            // only `rotationToleranceDeg` gates the merge. Placing group 11 by
            // raw `position` would leave an 18.46px offset that clears the 18px
            // default and makes the case fail on `tolerancePx` too.
            const { piece0, piece1 } = makeMatedPiecePair();
            const state = makeGameState({
                pieces: [piece0, piece1],
                groups: [
                    makeCenteredGroup(10, 0, { x: 50, y: 50 }),
                    makeCenteredGroup(11, 1, { x: 150, y: 50 }, 15),
                ],
            });
            const session = make();
            session.install(state);

            expect(lastInteractionOptions().getSnapTolerances?.().rotationToleranceDeg)
                .toBeGreaterThan(15);

            lastInteractionOptions().onDrop(11);

            expect(applyMerge).toHaveBeenCalledTimes(1);
        });

        it('expands a merging drop to the whole selection', () => {
            // Multi-select drags as a unit, so every selected group was dropped.
            const session = make();
            const state = makeMergeableState();
            session.install(state);
            selectionManager.toolActive = true;
            selectionManager.select(10);
            selectionManager.select(11);

            lastInteractionOptions().onDrop(11);

            expect(applyMerge).toHaveBeenCalledTimes(1);
            // Dragged group first, per `expandToSelectionIfActive`.
            expect(applyMerge.mock.calls[0][2]).toEqual([11, 10]);
        });

        it('z-reorders the dropped groups when nothing merges', () => {
            // Group 7 spans (0,0)–(200,100); group 8 is a 20×20 piece inside
            // it. Dropping the big one must raise the small one or it's lost.
            const pieces = [
                makeRectPiece({ id: 0, width: 100, height: 100, col: 0 }),
                makeRectPiece({ id: 1, width: 100, height: 100, col: 1 }),
                makeRectPiece({ id: 2, width: 20, height: 20, col: 0 }),
            ];
            const groups: PieceGroup[] = [
                {
                    id: 7,
                    pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                    position: { x: 0, y: 0 },
                    rotation: 0,
                },
                {
                    id: 8,
                    pieces: new Map([[2, { x: 0, y: 0 }]]),
                    position: { x: 50, y: 40 },
                    rotation: 0,
                },
            ];
            const session = make();
            session.install(makeGameState({ pieces, groups }));
            renderer.bringGroupToFront.mockClear();

            lastInteractionOptions().onDrop(7);

            // `makeRectPiece`'s edges are all borders, so nothing can mate.
            expect(applyMerge).not.toHaveBeenCalled();
            expect(renderer.bringGroupToFront).toHaveBeenCalledWith(8);
        });

        it('z-reorders the whole selection when a multi-select drop does not merge', () => {
            // Mirror of the merge case: multi-select moves as a unit, so the
            // reorder must consider every moved group. Group 9 (dragged) covers
            // nothing; group 7 rides along and is the only one over group 8, so
            // narrowing to the dragged group alone loses it.
            const pieces = [
                makeRectPiece({ id: 0, width: 100, height: 100, col: 0 }),
                makeRectPiece({ id: 1, width: 100, height: 100, col: 1 }),
                makeRectPiece({ id: 2, width: 20, height: 20, col: 0 }),
                makeRectPiece({ id: 3, width: 100, height: 100, col: 0 }),
            ];
            const groups: PieceGroup[] = [
                {
                    id: 7,
                    pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]),
                    position: { x: 0, y: 0 },
                    rotation: 0,
                },
                {
                    id: 8,
                    pieces: new Map([[2, { x: 0, y: 0 }]]),
                    position: { x: 50, y: 40 },
                    rotation: 0,
                },
                // Off on its own, single piece — covers nothing, raises nothing alone.
                {
                    id: 9,
                    pieces: new Map([[3, { x: 0, y: 0 }]]),
                    position: { x: 1000, y: 1000 },
                    rotation: 0,
                },
            ];
            const session = make();
            session.install(makeGameState({ pieces, groups }));
            selectionManager.toolActive = true;
            selectionManager.select(9);
            selectionManager.select(7);
            renderer.bringGroupToFront.mockClear();

            lastInteractionOptions().onDrop(9);

            expect(applyMerge).not.toHaveBeenCalled();
            expect(renderer.bringGroupToFront).toHaveBeenCalledWith(8);
        });

        it('reports the live state\'s snap tolerances to the interaction layer', () => {
            // `getSnapTolerances` feeds the snap-proximity glow, which must
            // agree with the drop-time merge check. Derived from the installed
            // state: reference width is image width / columns, so a wider image
            // widens the window.
            const session = make();
            const state = makeGameState({
                ...makeState(),
                imageSize: { width: 1600, height: 600 },
                gridSize: { cols: 8, rows: 6 },
            });
            session.install(state);

            expect(lastInteractionOptions().getSnapTolerances?.())
                .toEqual(activeSnapTolerances(state));
            // Not the numbers a narrower image gives — else ignoring the state
            // would also pass.
            expect(lastInteractionOptions().getSnapTolerances?.().tolerancePx)
                .toBeGreaterThan(activeSnapTolerances(makeState()).tolerancePx);
        });

        it('re-renders, re-applies selection visuals and saves on a state change', () => {
            const session = make();
            const state = makeState();
            session.install(state);
            selectionManager.toolActive = true;
            selectionManager.select(7);
            selectionManager.select(8);
            renderer.renderState.mockClear();
            renderer.setGroupSelected.mockClear();

            lastInteractionOptions().onStateChanged();

            expect(renderer.renderState).toHaveBeenCalledWith(state);
            // `renderState` may recreate elements, so re-apply the highlight for
            // every selected group after the render.
            expect(renderer.setGroupSelected.mock.calls).toEqual([[7, true], [8, true]]);
            // "After" literally: both are no-op spies, so only invocation order
            // distinguishes re-applying from painting onto soon-replaced elements.
            expect(renderer.setGroupSelected.mock.invocationCallOrder[0])
                .toBeGreaterThan(renderer.renderState.mock.invocationCallOrder[0]);
            expect(save).toHaveBeenCalledWith(state);
        });

        it('leaves selection visuals alone when nothing is selected', () => {
            const session = make();
            const state = makeState();
            session.install(state);
            renderer.setGroupSelected.mockClear();

            lastInteractionOptions().onStateChanged();

            expect(renderer.setGroupSelected).not.toHaveBeenCalled();
            expect(save).toHaveBeenCalledWith(state);
        });
    });

    it('restores a saved selection and switches the multi-select tool on', () => {
        const session = make();
        session.install(makeState());

        session.restoreSelection([7]);

        expect(selectionManager.toolActive).toBe(true);
        expect(selectionManager.isSelected(7)).toBe(true);
        expect(selectionManager.isSelected(8)).toBe(false);
    });

    it('does nothing for an empty saved selection', () => {
        const session = make();
        session.install(makeState());
        session.restoreSelection([]);
        expect(selectionManager.toolActive).toBe(false);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it('drops saved ids with no matching group and warns', () => {
        // Group ids are stable across a reload, so a mismatch is real
        // inconsistency, not something to swallow.
        const session = make();
        session.install(makeState());

        session.restoreSelection([7, 4242]);

        expect(selectionManager.isSelected(4242)).toBe(false);
        expect(selectionManager.isSelected(7)).toBe(true);
        expect(console.warn).toHaveBeenCalled();
    });

    it('leaves the tool off when no saved id survives', () => {
        const session = make();
        session.install(makeState());
        session.restoreSelection([4242]);
        expect(selectionManager.toolActive).toBe(false);
        expect(selectionManager.hasSelection).toBe(false);
    });

    it('restores nothing when no game is installed', () => {
        const session = make();
        session.restoreSelection([7]);
        expect(selectionManager.toolActive).toBe(false);
        expect(selectionManager.hasSelection).toBe(false);
    });
});
