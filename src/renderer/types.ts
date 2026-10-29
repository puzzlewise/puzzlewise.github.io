/**
 * The port includes {@link VIEWPORT_TRANSITION_MS} — a runtime value
 * implementations are bound by — not just the {@link Renderer} interface.
 */

import type { GameState, Point } from '../model/types.js';

/**
 * Animated viewport transition duration, in ms. Part of the port because the
 * caller that disables the transition can't observe the animation:
 * `app/viewport-fit.ts` arms a fallback timer against this number. A second
 * literal (in CSS) would let the timer silently cut the animation short.
 */
export const VIEWPORT_TRANSITION_MS = 800;

export interface Renderer {
    init(container: HTMLElement): void;

    renderState(gameState: GameState): void;

    bringGroupToFront(groupId: number): void;

    /** screen = world × scale + offset. */
    setViewportTransform(scale: number, offsetX: number, offsetY: number): void;

    /**
     * Implementations that animate must run for
     * {@link VIEWPORT_TRANSITION_MS}; those that cannot may no-op.
     */
    enableViewportTransition(): void;

    /**
     * Should be called once an animation has completed — which the caller
     * cannot observe, so it waits {@link VIEWPORT_TRANSITION_MS}.
     */
    disableViewportTransition(): void;

    setGroupDragging(groupId: number, dragging: boolean): void;

    flashMergePulse(groupId: number): void;

    setGroupSelected(groupId: number, selected: boolean): void;

    /**
     * Lets PointerRouter classify pointer events without per-piece
     * listeners.
     */
    pieceIdFromTarget(target: EventTarget | null): number | null;

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

    destroy(): void;
}
