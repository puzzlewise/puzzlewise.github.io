/**
 * The single post-merge follow-up — selection, rotate-handle focus, render,
 * z-order, win detection — shared by both gestures (drag drop and
 * rotate-handle commit) so they react identically.
 */

import type { GameState } from '../model/types.js';
import type { MergeResult } from '../game/group-merging.js';
import { checkAndMarkWin } from '../game/index.js';
import { reorderGroupsAfterDrop } from '../game/z-order.js';
import { track } from '../analytics/index.js';
import type { NewGameData } from '../analytics/index.js';
import { buildPuzzleCompletedData } from './completed-payload.js';
import { elapsedMsSince } from './game-clock.js';
import type { Renderer } from '../renderer/index.js';
import type { SelectionManager } from '../interaction/selection-manager.js';
import type { RotationFocus } from '../interaction/index.js';

/**
 * `droppedGroupIds`: groups whose z-order to refresh; absorbed IDs are
 * remapped to the survivor. Drag flows pass the multi-select expansion,
 * rotate-handle commits pass just the result group.
 *
 * On completion it hands off to `deps.onCompleted` — the zoom-vs-overlay
 * choice belongs to the caller, which owns the viewport.
 */
export function applyMergeResult(
    state: GameState,
    result: MergeResult,
    droppedGroupIds: readonly number[],
    deps: {
        renderer: Renderer;
        selectionManager: SelectionManager;
        rotationFocus: RotationFocus;
        currentGameAnalytics: () => Partial<NewGameData> | null;
        isResumedGame: () => boolean;
        gameStartedAt: () => number | undefined;
        onCompleted: (state: GameState) => void;
    },
): void {
    const {
        renderer, selectionManager, rotationFocus,
        currentGameAnalytics, isResumedGame, gameStartedAt, onCompleted,
    } = deps;

    // The survivor inherits selection if any absorbed group was selected.
    const validIds = new Set(state.groups.map(g => g.id));
    const hadSelectedAbsorbed = [...selectionManager.selectedGroupIds]
        .some(id => !validIds.has(id));
    selectionManager.pruneStale(validIds);
    if (hadSelectedAbsorbed) {
        selectionManager.select(result.group.id);
    }

    // If the rotate-handle's anchor was absorbed, retarget focus to the
    // survivor — otherwise the handle stays on a deleted group until the idle
    // timer expires, and the next pointerdown no-ops.
    const focused = rotationFocus.focusedGroupId;
    if (focused !== null && !validIds.has(focused)) {
        rotationFocus.setFocus(result.group.id);
    }

    renderer.renderState(state);
    for (const selectedId of selectionManager.selectedGroupIds) {
        renderer.setGroupSelected(selectedId, true);
    }

    // Remap absorbed IDs to the survivor so every entry names a real group.
    const remapped = droppedGroupIds.map(id =>
        state.groups.some(g => g.id === id) ? id : result.group.id,
    );
    const unique = [...new Set(remapped)];
    reorderGroupsAfterDrop(unique, state, (gId) => renderer.bringGroupToFront(gId));

    if (checkAndMarkWin(state)) {
        track(
            'puzzle-completed',
            buildPuzzleCompletedData(
                state,
                currentGameAnalytics(),
                isResumedGame(),
                elapsedMsSince(gameStartedAt(), Date.now()),
            ),
        );
        onCompleted(state);
    }
}
