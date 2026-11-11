/**
 * The app talks to the renderer through the `Renderer` port only, so a fake of
 * spies is enough — no real DOM. `pieceIdAtPoint` answers `null` (this
 * fake has no geometry) but is a spy, not a stub, because it *is* reached:
 * `game-session.test.ts` hands this fake to the real `setupInteraction`, which
 * calls it on every table pointerdown. A driven pointer sequence therefore gets
 * "no piece hit" from every event; give it a `mockReturnValue(pieceId)` for a hit.
 */

import { vi, type Mock } from 'vitest';
import type { Renderer } from '../renderer/types.js';

// `Mock<Renderer['x']>`, not bare `Mock`: bare widens to vi.fn's generic
// constraint, stops being callable against `Renderer`, and loses argument
// typing in `toHaveBeenCalledWith`. Extending `Renderer` directly (no `Omit`)
// makes a wrong `Mock<…>` parameter fail here (TS2430), not at distant call
// sites.
export interface FakeRenderer extends Renderer {
    init: Mock<Renderer['init']>;
    renderState: Mock<Renderer['renderState']>;
    bringGroupToFront: Mock<Renderer['bringGroupToFront']>;
    setViewportTransform: Mock<Renderer['setViewportTransform']>;
    enableViewportTransition: Mock<Renderer['enableViewportTransition']>;
    disableViewportTransition: Mock<Renderer['disableViewportTransition']>;
    setGroupDragging: Mock<Renderer['setGroupDragging']>;
    setGroupSelected: Mock<Renderer['setGroupSelected']>;
    setRingsEnabled: Mock<Renderer['setRingsEnabled']>;
    setInnerOutlineEnabled: Mock<Renderer['setInnerOutlineEnabled']>;
    invalidateGroup: Mock<Renderer['invalidateGroup']>;
    setViewportMoving: Mock<Renderer['setViewportMoving']>;
    pieceIdAtPoint: Mock<Renderer['pieceIdAtPoint']>;
    photoSettled: Mock<Renderer['photoSettled']>;
    prefetchPhoto: Mock<Renderer['prefetchPhoto']>;
    destroy: Mock<Renderer['destroy']>;
}

export function createFakeRenderer(): FakeRenderer {
    return {
        init: vi.fn(),
        renderState: vi.fn(),
        bringGroupToFront: vi.fn(),
        setViewportTransform: vi.fn(),
        enableViewportTransition: vi.fn(),
        disableViewportTransition: vi.fn(),
        setGroupDragging: vi.fn(),
        setGroupSelected: vi.fn(),
        setRingsEnabled: vi.fn(),
        setInnerOutlineEnabled: vi.fn(),
        invalidateGroup: vi.fn(),
        setViewportMoving: vi.fn(),
        pieceIdAtPoint: vi.fn<Renderer['pieceIdAtPoint']>(() => null),
        photoSettled: vi.fn(() => new Promise<'loaded' | 'failed'>(() => {})),
        prefetchPhoto: vi.fn(),
        destroy: vi.fn(),
    };
}
