/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RotationFocus } from '../interaction/rotation-focus.js';
import { createRotateHandle } from './rotate-handle.js';

describe('rotate-handle gesture', () => {
    let container: HTMLElement;
    let rotationFocus: RotationFocus;
    let onRotate: ReturnType<typeof vi.fn>;
    let onCommit: ReturnType<typeof vi.fn>;
    let onRotateStart: ReturnType<typeof vi.fn>;
    let onRotateEnd: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        document.body.replaceChildren();
        container = document.createElement('div');
        document.body.appendChild(container);
        rotationFocus = new RotationFocus();
        onRotate = vi.fn();
        onCommit = vi.fn();
        onRotateStart = vi.fn(() => ({ x: 150, y: 150 }));
        onRotateEnd = vi.fn();

        // jsdom does not implement pointer capture — stub the methods on the
        // prototype so all buttons created during the test have them.
        HTMLButtonElement.prototype.setPointerCapture = vi.fn();
        HTMLButtonElement.prototype.releasePointerCapture = vi.fn();
        HTMLButtonElement.prototype.hasPointerCapture = vi.fn(() => false);
    });

    afterEach(() => {
        document.body.replaceChildren();
        // @ts-expect-error — deleting stub added in beforeEach
        delete HTMLButtonElement.prototype.setPointerCapture;
        // @ts-expect-error
        delete HTMLButtonElement.prototype.releasePointerCapture;
        // @ts-expect-error
        delete HTMLButtonElement.prototype.hasPointerCapture;
    });

    function makeHandle(opts: Partial<Parameters<typeof createRotateHandle>[0]> = {}) {
        return createRotateHandle({
            container,
            rotationFocus,
            onRotate: onRotate as (groupId: number, deltaDegrees: number) => void,
            onCommit: onCommit as (groupId: number) => void,
            onRotateStart: onRotateStart as (groupId: number) => { x: number; y: number } | null,
            onRotateEnd: onRotateEnd as (groupId: number) => void,
            getFocusedGroupScreenBounds: () => ({ left: 100, right: 200, top: 100, bottom: 200 }),
            getViewportSize: () => ({ width: 800, height: 600 }),
            getGroupRotation: () => 0,
            screenToWorld: (cx, cy) => ({ x: cx, y: cy }), // identity for tests
            ...opts,
        });
    }

    function dispatchPointerEvent(target: EventTarget, type: string, init: Partial<PointerEventInit>): void {
        const evt = new PointerEvent(type, { pointerId: 1, bubbles: true, ...init });
        target.dispatchEvent(evt);
    }

    it('emits onRotate with a delta proportional to the angular change', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;

        // Pointer starts at (250, 150) — pivot (150, 150), so initial angle = 0 rad.
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });
        // Move to (150, 250) — angle = 90° clockwise.
        dispatchPointerEvent(button, 'pointermove', { clientX: 150, clientY: 250 });

        expect(onRotate).toHaveBeenCalled();
        const lastCall = onRotate.mock.calls.at(-1)!;
        expect(lastCall[0]).toBe(0);
        // Delta from current (0) to target (90) is 90°.
        expect(lastCall[1]).toBeCloseTo(90, 1);

        handle.destroy();
    });

    it('cancels touchstart on the handle', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        const event = new Event('touchstart', { bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);

        handle.destroy();
    });

    it('calls onCommit on pointerup', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });
        dispatchPointerEvent(button, 'pointermove', { clientX: 150, clientY: 250 });
        dispatchPointerEvent(button, 'pointerup', { clientX: 150, clientY: 250 });

        expect(onCommit).toHaveBeenCalledWith(0);

        handle.destroy();
    });

    it('cancels (no onCommit) when a second pointer lands on window', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });

        const secondFinger = new PointerEvent('pointerdown', {
            pointerId: 2, bubbles: true, clientX: 500, clientY: 500,
        });
        window.dispatchEvent(secondFinger);

        onRotate.mockClear();
        dispatchPointerEvent(button, 'pointermove', { clientX: 150, clientY: 250 });
        expect(onRotate).not.toHaveBeenCalled();
        expect(onCommit).not.toHaveBeenCalled();

        handle.destroy();
    });

    it('cancels gesture on pointercancel without calling onCommit', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });
        dispatchPointerEvent(button, 'pointercancel', { clientX: 250, clientY: 150 });

        expect(onCommit).not.toHaveBeenCalled();

        onRotate.mockClear();
        dispatchPointerEvent(button, 'pointermove', { clientX: 150, clientY: 250 });
        expect(onRotate).not.toHaveBeenCalled();

        handle.destroy();
    });

    it('uses the current group rotation to compute additive delta after re-rotation', () => {
        // Simulate a host that applies onRotate to the model. After the first
        // move, the group is at 45°. The next move should emit a delta from
        // that new rotation, not from R0=0.
        let currentRotation = 0;
        const handle = makeHandle({
            getGroupRotation: () => currentRotation,
            onRotate: vi.fn((_, delta) => { currentRotation += delta; }),
        });
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });

        // First move: pointer at angle 45° → target 45°, delta 45°.
        dispatchPointerEvent(button, 'pointermove', { clientX: 220.7, clientY: 220.7 });

        // Second move: pointer at angle 90° → target 90°, delta = 90 − 45 = 45°.
        dispatchPointerEvent(button, 'pointermove', { clientX: 150, clientY: 250 });

        expect(currentRotation).toBeCloseTo(90, 0);

        handle.destroy();
    });

    it('removes the window pointerdown listener when focus switches mid-drag', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });

        rotationFocus.setFocus(1);

        // No direct way to observe the detached window listener; instead
        // verify a pointermove on the old button no longer emits onRotate.
        onRotate.mockClear();
        dispatchPointerEvent(button, 'pointermove', { clientX: 150, clientY: 250 });
        expect(onRotate).not.toHaveBeenCalled();

        handle.destroy();
    });

    it('calls onRotateStart on pointerdown', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });

        expect(onRotateStart).toHaveBeenCalledWith(0);

        handle.destroy();
    });

    it('never opens the gesture when the group rotation is unavailable', () => {
        // Guard order in pointerdown is load-bearing: the rotation check must
        // run before onRotateStart, or a declined drag leaves the host with
        // an opened gesture (snap context, pivot latch) it never unwinds.
        const handle = makeHandle({ getGroupRotation: () => null });
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });

        expect(onRotateStart).not.toHaveBeenCalled();

        handle.destroy();
    });

    it('declines the drag when onRotateStart returns null — no onRotate/onCommit/onRotateEnd', () => {
        onRotateStart.mockReturnValue(null);
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });
        dispatchPointerEvent(button, 'pointermove', { clientX: 150, clientY: 250 });
        dispatchPointerEvent(button, 'pointerup', { clientX: 150, clientY: 250 });

        expect(onRotate).not.toHaveBeenCalled();
        expect(onCommit).not.toHaveBeenCalled();
        expect(onRotateEnd).not.toHaveBeenCalled();

        handle.destroy();
    });

    it('calls onRotateEnd (no onCommit) when focus switches mid-drag', () => {
        // This cancel path nulls the module-level active handle before the
        // drag is cancelled; the drag must still end for the group it
        // belonged to, or a host's per-gesture latch survives into the next
        // drag.
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });

        rotationFocus.setFocus(1);

        expect(onRotateEnd).toHaveBeenCalledWith(0);
        expect(onCommit).not.toHaveBeenCalled();

        handle.destroy();
    });

    it('calls onRotateEnd on pointerup (commit)', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });
        dispatchPointerEvent(button, 'pointerup', { clientX: 250, clientY: 150 });

        expect(onRotateEnd).toHaveBeenCalledWith(0);

        handle.destroy();
    });

    it('calls onRotateEnd on pointercancel (no commit)', () => {
        const handle = makeHandle();
        handle.show();
        rotationFocus.setFocus(0);

        const button = container.querySelector('.rotate-handle')! as HTMLButtonElement;
        dispatchPointerEvent(button, 'pointerdown', { clientX: 250, clientY: 150 });
        dispatchPointerEvent(button, 'pointercancel', { clientX: 250, clientY: 150 });

        expect(onRotateEnd).toHaveBeenCalledWith(0);
        expect(onCommit).not.toHaveBeenCalled();

        handle.destroy();
    });
});

describe('rotate-handle icon', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        document.body.replaceChildren();
    });

    it('builds the icon for a later handle without parsing its source again', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const rotationFocus = new RotationFocus();
        const handle = createRotateHandle({
            container,
            rotationFocus,
            onRotate: () => {},
            onCommit: () => {},
            onRotateStart: () => null,
            onRotateEnd: () => {},
            getFocusedGroupScreenBounds: () => ({ left: 100, right: 200, top: 100, bottom: 200 }),
            getViewportSize: () => ({ width: 800, height: 600 }),
            getGroupRotation: () => 0,
            screenToWorld: (x, y) => ({ x, y }),
        });
        handle.show();
        rotationFocus.setFocus(0);
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');

        rotationFocus.setFocus(1);

        const buttons = container.querySelectorAll('.rotate-handle');
        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) expect(button.querySelector('svg')).not.toBeNull();
        expect(parse).not.toHaveBeenCalled();
        handle.destroy();
    });
});
