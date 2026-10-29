/**
 * @vitest-environment jsdom
 */

/**
 * The bulk of gesture-classification logic is covered in pointer-router.test.ts;
 * this file only verifies that the wiring between collaborators is correct.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupInteraction } from './setup-interaction.js';
import { ViewportTransform } from './viewport-transform.js';
import { SelectionManager } from './selection-manager.js';
import { RotationFocus } from './rotation-focus.js';
import type { Renderer } from '../renderer/types.js';
import type { GameState, PieceGroup } from '../model/types.js';
import { makeCenteredGroup, makeGameState, makeMatedPiecePair } from '../test-helpers/fixtures.js';
import { ROTATION_COMPLETE_AT_FRACTION as F } from '../game/snap-proximity-rotation.js';
import { loadOffsetDragPreference } from '../ui/offset-drag.js';

vi.mock('../ui/offset-drag.js', () => ({
    loadOffsetDragPreference: vi.fn(() => false),
}));

beforeEach(() => {
    globalThis.requestAnimationFrame = vi.fn(() => 1);
    globalThis.cancelAnimationFrame = vi.fn();
});

interface FakeContainer {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    setPointerCapture: ReturnType<typeof vi.fn>;
    hasPointerCapture: ReturnType<typeof vi.fn>;
    releasePointerCapture: ReturnType<typeof vi.fn>;
    appendChild: ReturnType<typeof vi.fn>;
    fire(type: string, event: PointerEvent | WheelEvent): void;
}

function createFakeContainer(): FakeContainer {
    const listeners: Record<string, Array<(e: Event) => void>> = {};
    const captured = new Set<number>();

    return {
        addEventListener: vi.fn((type: string, cb: (e: Event) => void) => {
            (listeners[type] ??= []).push(cb);
        }),
        removeEventListener: vi.fn((type: string, cb: (e: Event) => void) => {
            const arr = listeners[type] ?? [];
            const idx = arr.indexOf(cb);
            if (idx >= 0) arr.splice(idx, 1);
        }),
        setPointerCapture: vi.fn((id: number) => { captured.add(id); }),
        hasPointerCapture: vi.fn((id: number) => captured.has(id)),
        releasePointerCapture: vi.fn((id: number) => { captured.delete(id); }),
        appendChild: vi.fn(),
        fire(type, event) {
            for (const cb of listeners[type] ?? []) cb(event);
        },
    };
}

function createFakeRenderer(): Renderer {
    return {
        init: vi.fn(),
        renderState: vi.fn(),
        bringGroupToFront: vi.fn(),
        setViewportTransform: vi.fn(),
        enableViewportTransition: vi.fn(),
        disableViewportTransition: vi.fn(),
        setGroupDragging: vi.fn(),
        flashMergePulse: vi.fn(),
        setGroupSelected: vi.fn(),
        pieceIdFromTarget: vi.fn((t: EventTarget | null) =>
            (t as { _pieceId?: number } | null)?._pieceId ?? null),
        // Defaults to "no piece nearby"; probe tests override it.
        pieceIdAtPoint: vi.fn(() => null),
        photoSettled: vi.fn(() => new Promise<'loaded' | 'failed'>(() => {})),
        destroy: vi.fn(),
    };
}

function fakePointerEvent(
    overrides: Partial<{
        clientX: number;
        clientY: number;
        pointerId: number;
        pointerType: string;
        target: EventTarget | null;
        shiftKey: boolean;
    }> = {},
): PointerEvent {
    return {
        clientX: overrides.clientX ?? 0,
        clientY: overrides.clientY ?? 0,
        pointerId: overrides.pointerId ?? 1,
        pointerType: overrides.pointerType ?? 'mouse',
        target: overrides.target ?? null,
        shiftKey: overrides.shiftKey ?? false,
        preventDefault: vi.fn(),
    } as unknown as PointerEvent;
}

function makeGroup(id: number, pieceIds: number[], position = { x: 0, y: 0 }): PieceGroup {
    const pieces = new Map<number, { x: number; y: number }>();
    for (const pid of pieceIds) pieces.set(pid, { x: 0, y: 0 });
    return { id, pieces, position, rotation: 0 };
}

function makeState(groups: PieceGroup[]): GameState {
    return makeGameState({ groups });
}

describe('setupInteraction', () => {
    it('cleanup() removes container listeners', () => {
        const container = createFakeContainer();
        const cleanup = setupInteraction({
            container: container as unknown as HTMLElement,
            renderer: createFakeRenderer(),
            viewportTransform: new ViewportTransform(),
            getState: () => makeState([makeGroup(1, [1])]),
            onStateChanged: vi.fn(),
            onDrop: vi.fn(),
            onViewportChanged: vi.fn(),
        });

        cleanup();

        expect(container.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
        expect(container.removeEventListener).toHaveBeenCalledWith('pointermove', expect.any(Function));
        expect(container.removeEventListener).toHaveBeenCalledWith('pointerup', expect.any(Function));
        expect(container.removeEventListener).toHaveBeenCalledWith('pointercancel', expect.any(Function));
        expect(container.removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function));
    });

    it('a piece tap in select-mode toggles selection', () => {
        const container = createFakeContainer();
        const renderer = createFakeRenderer();
        const selectionManager = new SelectionManager();
        selectionManager.toolActive = true;

        const state = makeState([makeGroup(7, [3])]);

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer,
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged: vi.fn(),
            onDrop: vi.fn(),
            onViewportChanged: vi.fn(),
            selectionManager,
        });

        const pieceTarget = { _pieceId: 3 } as unknown as EventTarget;

        container.fire('pointerdown', fakePointerEvent({ target: pieceTarget, clientX: 100, clientY: 100 }));
        container.fire('pointerup', fakePointerEvent({ target: pieceTarget, clientX: 101, clientY: 100 }));

        expect(selectionManager.isSelected(7)).toBe(true);
        expect(renderer.setGroupSelected).toHaveBeenCalledWith(7, true);
    });

    it('a piece drag triggers setGroupDragging(true) on start and onDrop on end', () => {
        const container = createFakeContainer();
        const renderer = createFakeRenderer();
        const onStateChanged = vi.fn();
        const onDrop = vi.fn();
        const state = makeState([makeGroup(7, [3])]);

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer,
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged,
            onDrop,
            onViewportChanged: vi.fn(),
        });

        const pieceTarget = { _pieceId: 3 };
        container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, clientX: 100, clientY: 100 }));
        container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 })); // promote
        expect(renderer.setGroupDragging).toHaveBeenCalledWith(7, true);

        container.fire('pointerup', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 }));
        expect(renderer.setGroupDragging).toHaveBeenCalledWith(7, false);
        expect(onDrop).toHaveBeenCalledWith(7);
    });

    it('a near-miss background press grabs a nearby piece via the probe', () => {
        const container = createFakeContainer();
        const renderer = createFakeRenderer();
        const onDrop = vi.fn();
        // Piece 3 is just off the press point: the direct target is background but the
        // probe finds it nearby. Coordinate-sensitive — fails if the wiring probes the
        // wrong point or drops it.
        renderer.pieceIdAtPoint = vi.fn((p: { x: number; y: number }) =>
            Math.hypot(p.x - 100, p.y - 100) <= 8 ? 3 : null);
        const state = makeState([makeGroup(7, [3])]);

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer,
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged: vi.fn(),
            onDrop,
            onViewportChanged: vi.fn(),
            panViewport: vi.fn(),
        });

        // Direct hit is background (target === container), so the probe runs.
        const bgTarget = container as unknown as EventTarget;
        container.fire('pointerdown', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 100, clientY: 100 }));
        container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 })); // promote

        expect(renderer.pieceIdAtPoint).toHaveBeenCalled();
        expect(renderer.setGroupDragging).toHaveBeenCalledWith(7, true);

        container.fire('pointerup', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 }));
        expect(onDrop).toHaveBeenCalledWith(7);
    });

    it('a background press with no nearby piece pans instead of grabbing', () => {
        const container = createFakeContainer();
        const renderer = createFakeRenderer(); // pieceIdAtPoint defaults to null
        const onDrop = vi.fn();
        const onViewportChanged = vi.fn();
        const state = makeState([makeGroup(7, [3])]);

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer,
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged: vi.fn(),
            onDrop,
            onViewportChanged,
            panViewport: vi.fn(),
        });

        const bgTarget = container as unknown as EventTarget;
        container.fire('pointerdown', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 100, clientY: 100 }));
        container.fire('pointermove', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 130, clientY: 100 })); // promote pan
        container.fire('pointermove', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 150, clientY: 100 })); // pan move

        expect(renderer.pieceIdAtPoint).toHaveBeenCalled();
        expect(renderer.setGroupDragging).not.toHaveBeenCalled();
        expect(onViewportChanged).toHaveBeenCalled();
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('a pointercancel during drag clears dragging visual without calling onDrop', () => {
        const container = createFakeContainer();
        const renderer = createFakeRenderer();
        const onDrop = vi.fn();
        const state = makeState([makeGroup(7, [3])]);

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer,
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged: vi.fn(),
            onDrop,
            onViewportChanged: vi.fn(),
        });

        const pieceTarget = { _pieceId: 3 };
        container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, clientX: 100, clientY: 100 }));
        container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 })); // promote
        container.fire('pointercancel', fakePointerEvent({ pointerId: 1 }));

        expect(renderer.setGroupDragging).toHaveBeenCalledWith(7, false);
        expect(onDrop).not.toHaveBeenCalled();
    });

    describe('rotation focus', () => {
        it('a piece tap sets focus on that group, regardless of multi-select state', () => {
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const rotationFocus = new RotationFocus();
            const state = makeState([makeGroup(7, [3])]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                rotationFocus,
            });

            const pieceTarget = { _pieceId: 3 } as unknown as EventTarget;
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget, clientX: 100, clientY: 100 }));
            container.fire('pointerup', fakePointerEvent({ target: pieceTarget, clientX: 101, clientY: 100 }));

            expect(rotationFocus.focusedGroupId).toBe(7);
        });

        it('a piece tap also still toggles multi-select when the tool is active', () => {
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const rotationFocus = new RotationFocus();
            const selectionManager = new SelectionManager();
            selectionManager.toolActive = true;
            const state = makeState([makeGroup(7, [3])]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                selectionManager,
                rotationFocus,
            });

            const pieceTarget = { _pieceId: 3 } as unknown as EventTarget;
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget, clientX: 100, clientY: 100 }));
            container.fire('pointerup', fakePointerEvent({ target: pieceTarget, clientX: 101, clientY: 100 }));

            expect(selectionManager.isSelected(7)).toBe(true);
            expect(rotationFocus.focusedGroupId).toBe(7);
        });

        it('a piece drag start clears focus', () => {
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const rotationFocus = new RotationFocus();
            rotationFocus.setFocus(7);
            const state = makeState([makeGroup(7, [3])]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                rotationFocus,
            });

            const pieceTarget = { _pieceId: 3 };
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, clientX: 100, clientY: 100 }));
            container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 }));

            expect(rotationFocus.focusedGroupId).toBeNull();
        });

        it('a background tap clears focus', () => {
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const rotationFocus = new RotationFocus();
            rotationFocus.setFocus(7);
            const state = makeState([makeGroup(7, [3])]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                rotationFocus,
            });

            // Cast to EventTarget so classifyTarget's target === container check matches.
            const bgTarget = container as unknown as EventTarget;
            container.fire('pointerdown', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 100, clientY: 100 }));
            container.fire('pointerup', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 101, clientY: 100 }));

            expect(rotationFocus.focusedGroupId).toBeNull();
        });

        it('a background pan start clears focus', () => {
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const rotationFocus = new RotationFocus();
            rotationFocus.setFocus(7);
            const state = makeState([makeGroup(7, [3])]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                panViewport: vi.fn(),
                rotationFocus,
            });

            // Cast to EventTarget so classifyTarget's target === container check matches.
            const bgTarget = container as unknown as EventTarget;
            container.fire('pointerdown', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 100, clientY: 100 }));
            container.fire('pointermove', fakePointerEvent({ target: bgTarget, pointerId: 1, clientX: 130, clientY: 100 })); // promote pan

            expect(rotationFocus.focusedGroupId).toBeNull();
        });

        it('a wheel zoom clears focus', () => {
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const rotationFocus = new RotationFocus();
            rotationFocus.setFocus(7);
            const state = makeState([makeGroup(7, [3])]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                rotationFocus,
            });

            const pieceTarget = { _pieceId: 3 };
            const wheelEvt = {
                deltaY: -100,
                clientX: 50,
                clientY: 50,
                target: pieceTarget,
                preventDefault: vi.fn(),
            } as unknown as WheelEvent;

            container.fire('wheel', wheelEvt);

            expect(rotationFocus.focusedGroupId).toBeNull();
        });

        it('a pinch start clears focus', () => {
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const rotationFocus = new RotationFocus();
            rotationFocus.setFocus(7);
            const state = makeState([makeGroup(7, [3])]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                rotationFocus,
            });

            const pieceTarget = { _pieceId: 3 };
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 }));
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 0 }));

            expect(rotationFocus.focusedGroupId).toBeNull();
        });
    });

    describe('offset drag', () => {
        it('does NOT apply when dragging a multi-selection', () => {
            vi.mocked(loadOffsetDragPreference).mockReturnValue(true);
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const selectionManager = new SelectionManager();
            selectionManager.toolActive = true;

            // Both selected: dragging 7 also moves 8, so >1 group moves and the offset must not apply.
            const group7 = makeGroup(7, [3], { x: 0, y: 0 });
            const group8 = makeGroup(8, [4], { x: 0, y: 0 });
            selectionManager.select(7);
            selectionManager.select(8);
            const state = makeState([group7, group8]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                selectionManager,
            });

            const pieceTarget = { _pieceId: 3 };
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, clientX: 100, clientY: 100 }));
            container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 })); // promote

            expect(group7.position.y).toBe(0);
        });

        it('does NOT apply when dragging a multi-piece group within a multi-selection', () => {
            vi.mocked(loadOffsetDragPreference).mockReturnValue(true);
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const selectionManager = new SelectionManager();
            selectionManager.toolActive = true;

            // Dragged group has 2 pieces, but 2 groups move: exclusion depends on group count, not piece count.
            const group7 = makeGroup(7, [3, 4], { x: 0, y: 0 });
            const group8 = makeGroup(8, [5], { x: 0, y: 0 });
            selectionManager.select(7);
            selectionManager.select(8);
            const state = makeState([group7, group8]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                selectionManager,
            });

            const pieceTarget = { _pieceId: 3 };
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, clientX: 100, clientY: 100 }));
            container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 })); // promote

            expect(group7.position.y).toBe(0);
        });

        it('still applies when the multi-select tool has only one group selected', () => {
            vi.mocked(loadOffsetDragPreference).mockReturnValue(true);
            const container = createFakeContainer();
            const renderer = createFakeRenderer();
            const selectionManager = new SelectionManager();
            selectionManager.toolActive = true;

            const group7 = makeGroup(7, [3], { x: 0, y: 0 });
            selectionManager.select(7);
            const state = makeState([group7]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
                selectionManager,
            });

            const pieceTarget = { _pieceId: 3 };
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, clientX: 100, clientY: 100 }));
            container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 })); // promote

            // OFFSET_DRAG_SCREEN_PX = 50, shifted upward (negative Y).
            expect(group7.position.y).toBe(-50);
        });

        it('applies when dragging a single multi-piece group', () => {
            vi.mocked(loadOffsetDragPreference).mockReturnValue(true);
            const container = createFakeContainer();
            const renderer = createFakeRenderer();

            // One group (2 pieces), no multi-select: exactly one group moves, so the offset applies.
            const group7 = makeGroup(7, [3, 4], { x: 0, y: 0 });
            const state = makeState([group7]);

            setupInteraction({
                container: container as unknown as HTMLElement,
                renderer,
                viewportTransform: new ViewportTransform(),
                getState: () => state,
                onStateChanged: vi.fn(),
                onDrop: vi.fn(),
                onViewportChanged: vi.fn(),
            });

            const pieceTarget = { _pieceId: 3 };
            container.fire('pointerdown', fakePointerEvent({ target: pieceTarget as unknown as EventTarget, pointerId: 1, clientX: 100, clientY: 100 }));
            container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 120, clientY: 100 })); // promote

            // OFFSET_DRAG_SCREEN_PX = 50, shifted upward (negative Y).
            expect(group7.position.y).toBe(-50);
        });
    });
});

describe('snap proximity rotation', () => {
    // The 'offset drag' tests set loadOffsetDragPreference(true) and never reset it;
    // reset here so a stray offset doesn't skew the snap-distance measurements below.
    beforeEach(() => {
        vi.mocked(loadOffsetDragPreference).mockReturnValue(false);
    });

    const D = 40; // snap distance
    const T = 20; // rotation tolerance

    /**
     * Free-rotation state: piece 0 (group 7) at the origin, piece 1
     * (group 8) rotated 18° with its bbox center at the zone edge (d = D,
     * i.e. 150 + D = 190) right of its aligned center (150, 50).
     */
    function makeFreeRotationState(rotationMode: GameState['rotationMode'] = 'free'): GameState {
        const { piece0, piece1 } = makeMatedPiecePair();
        const group7 = makeCenteredGroup(7, 0, { x: 50, y: 50 });
        const group8 = makeCenteredGroup(8, 1, { x: 150 + D, y: 50 }, 18);
        return makeGameState({ pieces: [piece0, piece1], groups: [group7, group8], rotationMode });
    }

    const getSnapTolerances = () => ({ tolerancePx: D, rotationToleranceDeg: T });

    // Drag target that lands group 8's center at the ramp midpoint, where the
    // cap is T/2 = 10, so an 18° error is corrected down to 10°. Promote
    // happens at clientX 320; the group starts at center 150 + D = 190 and
    // moves 1:1 with the pointer (identity viewport). Anchored to F so the
    // target stays at the ramp midpoint when the fraction is retuned.
    const midpointCenterX = 150 + D * (F + 0.5 * (1 - F));
    const toXMidpoint = 320 + (midpointCenterX - (150 + D));

    function dragPieceOne(container: FakeContainer, toX: number): void {
        const pieceTarget = { _pieceId: 1 } as unknown as EventTarget;
        container.fire('pointerdown', fakePointerEvent({ target: pieceTarget, pointerId: 1, clientX: 300, clientY: 300 }));
        container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: 320, clientY: 300 })); // promote
        container.fire('pointermove', fakePointerEvent({ pointerId: 1, clientX: toX, clientY: 300 })); // real move
    }

    it('rotates the dragged group toward a nearby mate during a free-rotation drag', () => {
        const container = createFakeContainer();
        const state = makeFreeRotationState();

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer: createFakeRenderer(),
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged: vi.fn(),
            onDrop: vi.fn(),
            onViewportChanged: vi.fn(),
            getSnapTolerances,
        });

        // Drag to the ramp midpoint (cap = T/2 = 10): 18° → 10°.
        dragPieceOne(container, toXMidpoint);

        expect(state.groupsById.get(8)!.rotation).toBeCloseTo(10);
    });

    it('does not rotate when rotation mode is not free', () => {
        const container = createFakeContainer();
        const state = makeFreeRotationState('quarter-turn');

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer: createFakeRenderer(),
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged: vi.fn(),
            onDrop: vi.fn(),
            onViewportChanged: vi.fn(),
            getSnapTolerances,
        });

        dragPieceOne(container, toXMidpoint);

        expect(state.groupsById.get(8)!.rotation).toBeCloseTo(18);
    });

    it('does not rotate during a multi-selection drag', () => {
        const container = createFakeContainer();
        const state = makeFreeRotationState();
        const selectionManager = new SelectionManager();
        selectionManager.toolActive = true;
        selectionManager.select(7);
        selectionManager.select(8);

        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer: createFakeRenderer(),
            viewportTransform: new ViewportTransform(),
            getState: () => state,
            onStateChanged: vi.fn(),
            onDrop: vi.fn(),
            onViewportChanged: vi.fn(),
            selectionManager,
            getSnapTolerances,
        });

        dragPieceOne(container, toXMidpoint);

        expect(state.groupsById.get(8)!.rotation).toBeCloseTo(18);
    });
});

describe('setupInteraction — marquee routing', () => {
    function dragBackground(
        container: ReturnType<typeof createFakeContainer>,
        opts: { shiftKey?: boolean } = {},
    ): void {
        // Background pointerdown, a move past the 8px threshold to promote to a drag, then up.
        const target = container as unknown as EventTarget;
        container.fire('pointerdown', fakePointerEvent({
            pointerId: 1, clientX: 0, clientY: 0, target, ...opts,
        }));
        container.fire('pointermove', fakePointerEvent({
            pointerId: 1, clientX: 40, clientY: 40, target, ...opts,
        }));
        container.fire('pointerup', fakePointerEvent({
            pointerId: 1, clientX: 40, clientY: 40, target, ...opts,
        }));
    }

    function setup(container: ReturnType<typeof createFakeContainer>, selectionManager: SelectionManager) {
        setupInteraction({
            container: container as unknown as HTMLElement,
            renderer: createFakeRenderer(),
            viewportTransform: new ViewportTransform(),
            getState: () => makeGameState(),
            onStateChanged: vi.fn(),
            onDrop: vi.fn(),
            onViewportChanged: vi.fn(),
            selectionManager,
        });
    }

    it('draws a marquee (appends an overlay) when the marquee is active', () => {
        const container = createFakeContainer();
        const selectionManager = new SelectionManager();
        selectionManager.toggleMarquee(); // arms marquee (and the tool)
        setup(container, selectionManager);

        dragBackground(container);

        expect(container.appendChild).toHaveBeenCalled();
    });

    it('pans (no overlay) when multi-select is on but the marquee is off', () => {
        const container = createFakeContainer();
        const selectionManager = new SelectionManager();
        selectionManager.toolActive = true; // tool on, marquee off
        setup(container, selectionManager);

        dragBackground(container);

        expect(container.appendChild).not.toHaveBeenCalled();
    });

    it('pans (no overlay) when both are off and no Shift', () => {
        const container = createFakeContainer();
        const selectionManager = new SelectionManager();
        setup(container, selectionManager);

        dragBackground(container);

        expect(container.appendChild).not.toHaveBeenCalled();
    });

    it('Shift+drag draws a marquee and enables multi-select without arming the marquee', () => {
        const container = createFakeContainer();
        const selectionManager = new SelectionManager();
        setup(container, selectionManager);

        dragBackground(container, { shiftKey: true });

        expect(selectionManager.toolActive).toBe(true);
        expect(selectionManager.marqueeActive).toBe(false);
        expect(container.appendChild).toHaveBeenCalled();
    });
});
