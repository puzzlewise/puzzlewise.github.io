/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { GameState, PieceGroup } from '../model/types.js';
import { SelectionManager } from '../interaction/selection-manager.js';
import { RotationFocus } from '../interaction/index.js';
import { createFakeRenderer, type FakeRenderer } from '../test-helpers/fake-renderer.js';
import { makeGameState, makeCenteredGroup, makeRectPiece } from '../test-helpers/fixtures.js';
import { reorderGroupsAfterDrop } from '../game/z-order.js';
import { applyMergeResult } from './merge-result.js';

// Plain `vi.spyOn` can't intercept a cross-module call under Vite; wrap the
// real `reorderGroupsAfterDrop` via `vi.mock` passthrough so the "remaps
// absorbed ids" test can inspect the array it received, while other tests get
// real z-order behavior.
vi.mock('../game/z-order.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../game/z-order.js')>();
    return {
        ...actual,
        reorderGroupsAfterDrop: vi.fn(actual.reorderGroupsAfterDrop),
    };
});

/**
 * Two independent single-piece groups: a survivor to merge into and a second
 * left over, so `checkWin` stays false — which the tests that must not trip
 * completion rely on.
 */
function makeTwoGroupState(): GameState {
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
 * A single group holding every piece: `checkWin` checks `groups.length === 1`
 * and `groups[0].pieces.size === pieces.length`, both true here, so
 * `checkAndMarkWin` passes for the real reason, not a mocked one.
 */
function makeCompletedState(): GameState {
    const pieces = [
        makeRectPiece({ id: 0, width: 100, height: 100 }),
        makeRectPiece({ id: 1, width: 100, height: 100 }),
    ];
    const group: PieceGroup = {
        id: 0,
        pieces: new Map([
            [0, { x: 0, y: 0 }],
            [1, { x: -100, y: 0 }],
        ]),
        position: { x: 0, y: 0 },
        rotation: 0,
    };
    return makeGameState({ pieces, groups: [group] });
}

describe('applyMergeResult', () => {
    let renderer: FakeRenderer;
    let selectionManager: SelectionManager;
    let rotationFocus: RotationFocus;
    // `Mock<(state: GameState) => void>`, not bare `ReturnType<typeof vi.fn>`
    // which widens and stops being assignable to `onCompleted`.
    let onCompleted: Mock<(state: GameState) => void>;
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
        renderer = createFakeRenderer();
        selectionManager = new SelectionManager();
        rotationFocus = new RotationFocus();
        onCompleted = vi.fn();
        // The z-order mock is module-scoped, so clear its call history or a
        // later test sees earlier tests' `reorderGroupsAfterDrop` calls.
        vi.mocked(reorderGroupsAfterDrop).mockClear();
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
    });

    function deps() {
        return {
            renderer,
            selectionManager,
            rotationFocus,
            currentGameAnalytics: () => null,
            isResumedGame: () => false,
            gameStartedAt: () => undefined,
            onCompleted,
        };
    }

    it('prunes absorbed groups from the selection', () => {
        const state = makeTwoGroupState();
        const survivor = state.groups[0];
        const absorbedId = 999;
        selectionManager.toolActive = true;
        selectionManager.select(absorbedId);

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [absorbedId], deps());

        expect(selectionManager.isSelected(absorbedId)).toBe(false);
    });

    it('lets the surviving group inherit selection from an absorbed one', () => {
        const state = makeTwoGroupState();
        const survivor = state.groups[0];
        selectionManager.toolActive = true;
        selectionManager.select(999);

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [999], deps());

        expect(selectionManager.isSelected(survivor.id)).toBe(true);
    });

    it('leaves the selection alone when nothing selected was absorbed', () => {
        const state = makeTwoGroupState();
        const survivor = state.groups[0];

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], deps());

        expect(selectionManager.hasSelection).toBe(false);
    });

    it('retargets rotate-handle focus onto the survivor when its anchor was absorbed', () => {
        // Otherwise the handle stays anchored to a deleted group and the next
        // pointerdown no-ops until the idle timer expires.
        const state = makeTwoGroupState();
        const survivor = state.groups[0];
        rotationFocus.setFocus(999);

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [999], deps());

        expect(rotationFocus.focusedGroupId).toBe(survivor.id);
    });

    it('leaves focus alone when the focused group survived', () => {
        // Focus a different still-live group, not the survivor, so an "always
        // retarget to survivor" bug is distinguishable — `setFocus` is already
        // a no-op when the target equals the current focus.
        const state = makeTwoGroupState();
        const survivor = state.groups[0];
        const otherGroup = state.groups[1];
        rotationFocus.setFocus(otherGroup.id);

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], deps());

        expect(rotationFocus.focusedGroupId).toBe(otherGroup.id);
    });

    it('re-renders the merged group', () => {
        const state = makeTwoGroupState();
        const survivor = state.groups[0];

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], deps());

        expect(renderer.renderState).toHaveBeenCalledWith(state);
    });

    it('re-applies the selection highlight for every surviving selected group after the re-render', () => {
        // renderState can recreate the highlighted DOM elements, so the
        // re-apply must run strictly after it — asserting mere presence
        // wouldn't catch a re-apply that runs before the re-render.
        const state = makeTwoGroupState();
        const survivor = state.groups[0];
        const other = state.groups[1];
        selectionManager.toolActive = true;
        selectionManager.selectMany([survivor.id, other.id]);

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], deps());

        expect(renderer.setGroupSelected).toHaveBeenCalledWith(survivor.id, true);
        expect(renderer.setGroupSelected).toHaveBeenCalledWith(other.id, true);

        const renderOrder = renderer.renderState.mock.invocationCallOrder[0];
        for (const order of renderer.setGroupSelected.mock.invocationCallOrder) {
            expect(order).toBeGreaterThan(renderOrder);
        }
    });

    it('remaps absorbed ids to the survivor before reordering z-order', () => {
        // Every entry the reorder receives must name a live group; 999 never
        // existed, so it must be remapped to the survivor and the resulting
        // duplicate collapsed.
        const state = makeTwoGroupState();
        const survivor = state.groups[0];

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [999, survivor.id], deps());

        expect(vi.mocked(reorderGroupsAfterDrop).mock.calls[0]?.[0]).toEqual([survivor.id]);
    });

    it('reports and celebrates a completed puzzle', () => {
        const state = makeCompletedState();
        const survivor = state.groups[0];

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], deps());

        expect(umamiTrack).toHaveBeenCalledWith('puzzle-completed', expect.any(Object));
        expect(onCompleted).toHaveBeenCalledWith(state);
    });

    it.each([true, false])('reports resumed=%s from the session', (resumed) => {
        const state = makeCompletedState();
        const survivor = state.groups[0];

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], {
            ...deps(),
            isResumedGame: () => resumed,
        });

        expect(umamiTrack).toHaveBeenCalledWith(
            'puzzle-completed',
            expect.objectContaining({ resumed }),
        );
    });

    it('reports the time since the game started', () => {
        const state = makeCompletedState();
        const survivor = state.groups[0];
        const now = vi.spyOn(Date, 'now').mockReturnValue(91_000);

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], {
            ...deps(),
            gameStartedAt: () => 1_000,
        });
        now.mockRestore();

        expect(umamiTrack).toHaveBeenCalledWith(
            'puzzle-completed',
            expect.objectContaining({ elapsedMs: 90_000 }),
        );
    });

    it('reports the completion before handing off to the celebration', () => {
        // Order, not co-occurrence: `onCompleted` does synchronous work (DOM
        // queries, re-anchor, overlay fallback) before its rAF, so the reverse
        // order lets a throw there swallow `puzzle-completed` and lose the
        // completion from the funnel.
        const state = makeCompletedState();
        const survivor = state.groups[0];

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], deps());

        expect(umamiTrack.mock.invocationCallOrder[0])
            .toBeLessThan(onCompleted.mock.invocationCallOrder[0]);
    });

    it('does not report completion for an unfinished puzzle', () => {
        const state = makeTwoGroupState();
        const survivor = state.groups[0];

        applyMergeResult(state, { group: survivor, mergeCount: 1 }, [survivor.id], deps());

        expect(umamiTrack).not.toHaveBeenCalled();
        expect(onCompleted).not.toHaveBeenCalled();
    });
});
