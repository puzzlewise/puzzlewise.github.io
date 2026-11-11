import type { Renderer } from '../renderer/index.js';
import type { ViewportTransform } from '../interaction/index.js';
import type { GameState, PieceGroup } from '../model/types.js';
import { rotatePoint, signedAngularDelta } from '../model/helpers.js';
import {
    computeSplitGatheredPositions,
    applyGatheredPositions,
    splitGatherGutter,
    getGroupVisualBounds,
    getGroupImageCenter,
} from '../game/index.js';

export interface ViewportFitDeps {
    container: HTMLElement;
    renderer: Renderer;
    viewportTransform: ViewportTransform;
    applyTransform: () => void;
    /**
     * Read late: the completion cleanup runs up to 1000ms after the call, by
     * which time a new game may have started.
     */
    renderCurrent: () => void;
}

export function gatherAndZoomToFit(
    state: GameState,
    deps: ViewportFitDeps,
    selectedGroupIds: ReadonlySet<number> = new Set(),
): void {
    const { container, viewportTransform, applyTransform } = deps;
    const screenWidth = container.clientWidth || window.innerWidth;
    const screenHeight = container.clientHeight || window.innerHeight;
    const aspectRatio = screenWidth / screenHeight;

    const { positions, layoutBounds } = computeSplitGatheredPositions(
        state.groups,
        selectedGroupIds,
        aspectRatio,
        state.piecesById,
        splitGatherGutter(state.imageSize, state.pieces.length),
    );

    applyGatheredPositions(state.groups, positions);

    const scaleX = screenWidth / layoutBounds.width;
    const scaleY = screenHeight / layoutBounds.height;
    const scale = Math.min(scaleX, scaleY) * 0.9;

    const layoutCenterX = layoutBounds.x + layoutBounds.width / 2;
    const layoutCenterY = layoutBounds.y + layoutBounds.height / 2;

    viewportTransform.setState({
        scale,
        offset: {
            x: screenWidth / 2 - layoutCenterX * scale,
            y: screenHeight / 2 - layoutCenterY * scale,
        },
    });

    applyTransform();
}

/**
 * Unlike gatherAndZoomToFit(), this does not re-lay-out the board. Its one model
 * write is the completed group's upright resting state (`position`,
 * `rotation = 0`), and only when the puzzle finished at a non-zero rotation.
 *
 * @param onComplete - Run exactly once per call after the animations settle,
 *   up to 1000ms late, so it must not assume the completed game is still
 *   installed; there is no handle to cancel it.
 */
export function zoomToFitCompletedPuzzle(
    state: GameState,
    completedGroup: PieceGroup,
    deps: ViewportFitDeps,
    onComplete: () => void,
): void {
    const { container, renderer, viewportTransform, renderCurrent } = deps;
    const screenWidth = container.clientWidth || window.innerWidth;
    const screenHeight = container.clientHeight || window.innerHeight;

    let spin: Promise<void> = Promise.resolve();
    if (completedGroup.rotation !== 0) {
        const startRotation = completedGroup.rotation;

        // Corner geometry only, so asymmetric tabs don't offset the pivot.
        const centerLocal = getGroupImageCenter(completedGroup, state.piecesById);

        const rotatedCenter = rotatePoint(centerLocal, startRotation);
        const finalPosition = {
            x: completedGroup.position.x + rotatedCenter.x - centerLocal.x,
            y: completedGroup.position.y + rotatedCenter.y - centerLocal.y,
        };

        const targetRotation = startRotation + signedAngularDelta(0, startRotation);

        spin = renderer.animateGroupRotation(
            completedGroup.id,
            targetRotation,
            centerLocal,
        );

        completedGroup.position = finalPosition;
        completedGroup.rotation = 0;
    }

    const groupBounds = getGroupVisualBounds(completedGroup, state.piecesById);

    const worldBounds = {
        x: completedGroup.position.x + groupBounds.minX,
        y: completedGroup.position.y + groupBounds.minY,
        width: groupBounds.width,
        height: groupBounds.height,
    };

    const scaleX = screenWidth / worldBounds.width;
    const scaleY = screenHeight / worldBounds.height;
    const targetScale = Math.min(scaleX, scaleY) * 0.9; // 10% padding like gatherAndZoomToFit

    const worldCenterX = worldBounds.x + worldBounds.width / 2;
    const worldCenterY = worldBounds.y + worldBounds.height / 2;
    const targetOffset = {
        x: screenWidth / 2 - worldCenterX * targetScale,
        y: screenHeight / 2 - worldCenterY * targetScale,
    };

    viewportTransform.setState({
        scale: targetScale,
        offset: targetOffset,
    });

    const { scale, offset } = viewportTransform.getState();
    const zoom = renderer.transitionViewport(scale, offset.x, offset.y);

    void Promise.all([zoom, spin]).then(() => {
        renderCurrent();
        onComplete();
    });
}
