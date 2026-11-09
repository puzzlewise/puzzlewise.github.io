import {
    applyGroupTransform,
    VIEWPORT_TRANSITION,
    VIEWPORT_TRANSITION_MS,
    type Renderer,
} from '../renderer/index.js';
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

/**
 * Headroom the fallback timer gives `transitionend` to fire first, so the net
 * below never pre-empts a transition genuinely running. The deadline itself is
 * {@link VIEWPORT_TRANSITION_MS}, imported not restated — the `Renderer` port
 * owns the duration, and a second literal would drift and cut completion zooms
 * short. Exported so `viewport-fit.test.ts` can derive its deadlines instead of
 * hardcoding them.
 */
export const SETTLE_GRACE_MS = 200;

export interface ViewportFitDeps {
    container: HTMLElement;
    renderer: Renderer;
    viewportTransform: ViewportTransform;
    applyTransform: () => void;
    /**
     * Re-render whatever game is current, read late. The completion cleanup
     * fires up to 1000ms after the call, by which time a new game may have
     * started — capturing `state` would paint the finished puzzle over it.
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
 * Reaches into the DOM directly (`[data-group-id]` / `[data-puzzle-table]`,
 * `applyGroupTransform`) rather than via the `Renderer` port — a known,
 * intentional deviation, not this module's to route.
 *
 * @param onComplete - Run exactly once per call when the zoom settles: at
 *   `transitionend`, or a deadline if that never arrives (including when no
 *   animation ran). Fires up to 1000ms late, so it must not assume the completed
 *   game is still installed; there is no handle to cancel it.
 */
export function zoomToFitCompletedPuzzle(
    state: GameState,
    completedGroup: PieceGroup,
    deps: ViewportFitDeps,
    onComplete: () => void,
): void {
    const { container, renderer, viewportTransform, applyTransform, renderCurrent } = deps;
    const screenWidth = container.clientWidth || window.innerWidth;
    const screenHeight = container.clientHeight || window.innerHeight;

    // Spin upright in parallel with the zoom. Pin transform-origin to the image
    // center and animate the angle only — animating translate+rotate together
    // swings the center along an arc. Shortest signed turn (≤180°).
    let groupTransitionCleanup: (() => void) | null = null;
    if (completedGroup.rotation !== 0) {
        const startRotation = completedGroup.rotation;

        // Pivot about the assembled image center (corner geometry only, so
        // asymmetric tabs don't offset it). `getGroupImageCenter` works in
        // un-rotated local space — the frame `transform-origin` uses.
        const centerLocal = getGroupImageCenter(completedGroup, state.piecesById);

        // Compensate `position` so that, with the origin at the center, the
        // puzzle stays where it was rendered — same world point, only the local
        // pivot changed.
        const rotatedCenter = rotatePoint(centerLocal, startRotation);
        const finalPosition = {
            x: completedGroup.position.x + rotatedCenter.x - centerLocal.x,
            y: completedGroup.position.y + rotatedCenter.y - centerLocal.y,
        };

        // Shortest signed turn to an upright (0°-equivalent) angle.
        const targetRotation = startRotation + signedAngularDelta(0, startRotation);

        const groupEl = container.querySelector(
            `[data-group-id="${completedGroup.id}"]`,
        ) as HTMLElement | null;
        if (groupEl) {
            // Re-anchor to the center origin without moving the puzzle, then
            // force a reflow so this becomes the transition's start frame rather
            // than collapsing into the spin below.
            groupEl.style.transition = 'none';
            applyGroupTransform(groupEl, finalPosition, startRotation, centerLocal);
            groupEl.getBoundingClientRect();

            // Spin to upright in lockstep with the zoom — the renderer's own
            // transition string, so same duration and easing.
            groupEl.style.transition = VIEWPORT_TRANSITION;
            applyGroupTransform(groupEl, finalPosition, targetRotation, centerLocal);

            groupTransitionCleanup = () => {
                // Settle into the normal representation: origin back at 0,0,
                // rotation normalized to 0. Visually identical to the spin's
                // final frame (targetRotation ≡ 0 mod 360), so no jump.
                groupEl.style.transition = '';
                renderer.invalidateGroup(completedGroup.id);
                renderCurrent();
            };
        }

        // Commit the upright resting state: frames the viewport below and is the
        // model's settled value.
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

    renderer.enableViewportTransition();

    // Next frame, so the transition is applied before the target transform.
    requestAnimationFrame(() => {
        viewportTransform.setState({
            scale: targetScale,
            offset: targetOffset,
        });

        applyTransform();

        const tableEl = container.querySelector('[data-puzzle-table]') as HTMLElement | null;

        let settled = false;
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

        // Wind the zoom up: restore the table's transition, release the spun
        // group's element, and tell the caller. Single-shot by construction (the
        // first path unsubscribes the listener and cancels the timer); the
        // `settled` latch is defence in depth against an edit that reorders or
        // drops those, since a second `onComplete` shows the completion overlay
        // twice. Set before the three effects so a throw in any can't re-open it.
        function settle(): void {
            if (settled) return;
            settled = true;
            tableEl?.removeEventListener('transitionend', handleTransitionEnd);
            clearTimeout(fallbackTimer);
            renderer.disableViewportTransition();
            groupTransitionCleanup?.();
            onComplete();
        }

        function handleTransitionEnd(event: TransitionEvent): void {
            if (event.propertyName === 'transform' && event.target === tableEl) settle();
        }

        tableEl?.addEventListener('transitionend', handleTransitionEnd);

        // `transitionend` is accurate but can't be the only signal: when the
        // target transform equals the current one (two Solves framing the same
        // group from the same viewport), the browser starts no transition and
        // the event never fires — leaving `transition: transform 0.8s` on the
        // table so every later pan/zoom animates, the listener on an element
        // `renderState` never replaces, and the group's detached element alive.
        // With a table the timer is the net, so it gets a grace period on top —
        // the real event must win the ordinary race or it cuts the zoom short.
        // With no table there's nothing to wait for, so it fires at the nominal
        // duration.
        fallbackTimer = setTimeout(
            settle,
            tableEl ? VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS : VIEWPORT_TRANSITION_MS,
        );
    });
}
