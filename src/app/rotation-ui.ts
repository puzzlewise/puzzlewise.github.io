import type { GameState, Point } from '../model/types.js';
import type { MergeResult } from '../game/group-merging.js';
import type { Renderer } from '../renderer/index.js';
import type { ViewportTransform, RotationFocus } from '../interaction/index.js';
import type { SelectionManager } from '../interaction/selection-manager.js';
import { createRotateButtons, createRotateHandle } from '../ui/index.js';
import { createFrameCoalescer } from '../interaction/frame-coalescer.js';
import { SnapProximityPositionController } from '../interaction/snap-proximity-position-controller.js';
import { rotateGroup } from '../game/rotate-group.js';
import { pickManualRotationPivot } from '../game/rotation-pivot.js';
import { getGroupLocalBounds, getGroupVisualBounds, processDrop } from '../game/index.js';
import { localToWorld } from '../model/helpers.js';
import { activeSnapTolerances } from './snap-tolerances.js';

/**
 * Deliberately the whole public surface — everything else the module builds is
 * handed to the two controls, so the composition root needs none of it.
 */
export interface RotationUi {
    syncVisibility: (state: GameState | undefined) => void;
}

/**
 * Returns closures, not a class instance, so `syncVisibility` works as a bare
 * value (no `.bind`). It's passed into the session's `onInstalled`, making
 * "rotation UI before session" a compiler-enforced data dependency rather than
 * a source-order coincidence.
 */
export function createRotationUi(deps: {
    container: HTMLElement;
    renderer: Renderer;
    viewportTransform: ViewportTransform;
    selectionManager: SelectionManager;
    rotationFocus: RotationFocus;
    getState: () => GameState | undefined;
    save: (state: GameState) => void;
    applyMerge: (
        state: GameState,
        result: MergeResult,
        droppedGroupIds: readonly number[],
    ) => void;
}): RotationUi {
    const {
        container,
        renderer,
        viewportTransform,
        selectionManager,
        rotationFocus,
        getState,
        save,
        applyMerge,
    } = deps;

    function getFocusedGroupScreenBounds(
        groupId: number,
    ): { left: number; right: number; top: number; bottom: number } | null {
        const state = getState();
        if (!state) return null;
        const group = state.groupsById.get(groupId);
        if (!group) return null;
        const local = getGroupVisualBounds(group, state.piecesById);
        const worldLeft = group.position.x + local.minX;
        const worldTop = group.position.y + local.minY;
        const worldRight = worldLeft + local.width;
        const worldBottom = worldTop + local.height;
        const tl = viewportTransform.worldToScreen({ x: worldLeft, y: worldTop });
        const br = viewportTransform.worldToScreen({ x: worldRight, y: worldBottom });
        return { left: tl.x, top: tl.y, right: br.x, bottom: br.y };
    }

    const rotateButtons = createRotateButtons({
        container,
        rotationFocus,
        onRotate: (groupId, direction) => {
            const state = getState();
            if (!state) return;
            const group = state.groupsById.get(groupId);
            if (!group) return;

            const deltaDeg = direction === 'cw' ? 90 : -90;
            rotateGroup(group, state.piecesById, deltaDeg);

            renderer.renderState(state);
            // Re-apply selection visuals: renderState may recreate elements.
            for (const selectedId of selectionManager.selectedGroupIds) {
                renderer.setGroupSelected(selectedId, true);
            }
            save(state);
        },
        getFocusedGroupScreenBounds,
    });

    const snapPosition = new SnapProximityPositionController({
        getState,
        getTolerances: activeSnapTolerances,
    });

    // Sticky pivot for the current handle drag: latched once in onRotateStart,
    // cleared on drag end. Never re-picked mid-gesture (would move the pivot
    // under the player's hand). Carries the group id so a latch can't apply to
    // the wrong group.
    let manualPivot: { groupId: number; pivotLocal: Point } | null = null;

    const handleRender = createFrameCoalescer(() => {
        const state = getState();
        if (!state) return;
        renderer.renderState(state);
        // Re-apply selection visuals: renderState may recreate elements.
        for (const selectedId of selectionManager.selectedGroupIds) {
            renderer.setGroupSelected(selectedId, true);
        }
    });

    const rotateHandle = createRotateHandle({
        container,
        rotationFocus,
        onRotateStart: (groupId) => {
            const state = getState();
            if (!state) return null;
            const group = state.groupsById.get(groupId);
            if (!group) return null;
            // A mate within snap distance pins the pivot to that piece for the
            // whole drag, and the assist anchors to the same piece so the
            // gesture has one winner. With no mate in range the assist stays
            // off: bbox-center rotation sweeps each candidate's piece-anchored
            // distance, so a far mate could latch mid-drag and translate a pure
            // rotation. Pivots about the tab-inclusive bounds center so the
            // handle tracks a mid-assembly group's visible footprint (the
            // completion spin instead uses the corner-only image center).
            const picked = pickManualRotationPivot(
                state, group, activeSnapTolerances(state).tolerancePx,
            );
            if (picked) snapPosition.start(groupId, picked.pieceId);
            let pivotLocal = picked?.pivotLocal ?? null;
            if (!pivotLocal) {
                const bounds = getGroupLocalBounds(group, state.piecesById);
                pivotLocal = {
                    x: bounds.minX + bounds.width / 2,
                    y: bounds.minY + bounds.height / 2,
                };
            }
            manualPivot = { groupId, pivotLocal };
            return localToWorld(pivotLocal, group);
        },
        onRotate: (groupId, deltaDegrees) => {
            const state = getState();
            if (!state) return;
            const group = state.groupsById.get(groupId);
            if (!group) return;
            rotateGroup(
                group, state.piecesById, deltaDegrees,
                manualPivot?.groupId === groupId ? manualPivot.pivotLocal : undefined,
            );
            snapPosition.onGroupRotated();
            handleRender.schedule();
            // Don't autoSave on every drag tick — autoSave fires on commit.
        },
        onCommit: (groupId) => {
            handleRender.flush();
            const state = getState();
            if (!state) return;

            const { tolerancePx, rotationToleranceDeg } = activeSnapTolerances(state);

            const result = processDrop(groupId, state, tolerancePx, rotationToleranceDeg);
            if (result) {
                applyMerge(state, result, [result.group.id]);
            }
            save(state);
        },
        onRotateEnd: () => {
            handleRender.flush();
            manualPivot = null;
            snapPosition.stop();
        },
        getFocusedGroupScreenBounds,
        getGroupRotation: (groupId) => getState()?.groupsById.get(groupId)?.rotation ?? null,
        screenToWorld: (clientX, clientY) => viewportTransform.screenToWorld({ x: clientX, y: clientY }),
    });

    function syncVisibility(state: GameState | undefined): void {
        if (state?.rotationMode === 'quarter-turn') {
            rotateButtons.show();
            rotateHandle.hide();
        } else if (state?.rotationMode === 'free') {
            rotateButtons.hide();
            rotateHandle.show();
        } else {
            rotateButtons.hide();
            rotateHandle.hide();
        }
    }

    return { syncVisibility };
}
