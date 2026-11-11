/**
 * The port includes {@link VIEWPORT_TRANSITION_MS} — a runtime value
 * implementations are bound by — not just the {@link Renderer} interface.
 */

import type { GameState, Point } from '../model/types.js';

/** Duration of the completion zoom and spin, with `cubic-bezier(.42,0,.58,1)` easing. */
export const VIEWPORT_TRANSITION_MS = 800;

/** Animation promises settle within `VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS` even if no frame runs. */
export const SETTLE_GRACE_MS = 200;

export interface Renderer {
    init(container: HTMLElement): void;

    renderState(gameState: GameState): void;

    bringGroupToFront(groupId: number): void;

    /** screen = world × scale + offset. */
    setViewportTransform(scale: number, offsetX: number, offsetY: number): void;

    /**
     * Animates from the current transform; resolves once the target is
     * applied.
     */
    transitionViewport(scale: number, offsetX: number, offsetY: number): Promise<void>;

    /**
     * Spins the group about `pivotLocal` (group-local) without moving it.
     * The group's model transform is restored by the next `renderState`.
     */
    animateGroupRotation(
        groupId: number,
        toDeg: number,
        pivotLocal: Point,
    ): Promise<void>;

    setGroupDragging(groupId: number, dragging: boolean): void;

    setGroupSelected(groupId: number, selected: boolean): void;

    setRingsEnabled(enabled: boolean): void;

    /** Takes effect on the next `renderState`. */
    setInnerOutlineEnabled(enabled: boolean): void;

    /**
     * True while a gesture moves the viewport. Groups aren't composited at
     * rest, so without this every frame of a pan redraws them (#735).
     */
    setViewportMoving(moving: boolean): void;

    /**
     * `point` is screen-space. Keeps hit-testing behind the renderer
     * abstraction; implementations that cannot hit-test by point may
     * return null.
     */
    pieceIdAtPoint(point: Point): number | null;

    /**
     * Settles when the photo of the most recently rendered puzzle has loaded
     * or failed. Re-rendering the same puzzle keeps its earlier result.
     */
    photoSettled(): Promise<'loaded' | 'failed'>;

    prefetchPhoto(url: string): void;

    destroy(): void;
}
