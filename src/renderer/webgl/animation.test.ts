import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Point } from '../../model/types.js';
import { SETTLE_GRACE_MS, VIEWPORT_TRANSITION_MS } from '../types.js';
import { cubicBezierEase, EASE_IN_OUT, TransitionController, Tween, type ViewportValue } from './animation.js';

describe('EASE_IN_OUT', () => {
    test('EASE_IN_OUT(0)=0, (1)=1, (0.5)=0.5', () => {
        expect(EASE_IN_OUT(0)).toBe(0);
        expect(EASE_IN_OUT(1)).toBe(1);
        expect(EASE_IN_OUT(0.5)).toBeCloseTo(0.5, 6);
    });

    test('EASE_IN_OUT matches CSS ease-in-out at t=0.25 within 1e-3', () => {
        expect(Math.abs(EASE_IN_OUT(0.25) - 0.1291)).toBeLessThan(1e-3);
        expect(Math.abs(EASE_IN_OUT(0.75) - 0.8709)).toBeLessThan(1e-3);
    });

    test('is monotonic over [0,1]', () => {
        let prev = -Infinity;
        for (let i = 0; i <= 200; i++) {
            const y = EASE_IN_OUT(i / 200);
            expect(y).toBeGreaterThanOrEqual(prev);
            prev = y;
        }
    });

    test('clamps inputs outside [0,1]', () => {
        expect(EASE_IN_OUT(-1)).toBe(0);
        expect(EASE_IN_OUT(2)).toBe(1);
    });

    test('linear control points give the identity', () => {
        const linear = cubicBezierEase(0, 0, 1, 1);
        for (const x of [0.1, 0.3, 0.8]) {
            expect(linear(x)).toBeCloseTo(x, 6);
        }
    });
});

describe('Tween', () => {
    test('Tween progress clamps to 1 after duration', () => {
        const tween = new Tween(800, 1000);
        expect(tween.progress(1000)).toBe(0);
        expect(tween.progress(1400)).toBeCloseTo(0.5, 6);
        expect(tween.progress(5000)).toBe(1);
        expect(tween.progress(500)).toBe(0);
    });

    test('done reports completion at and after the duration', () => {
        const tween = new Tween(800, 1000);
        expect(tween.done(1799)).toBe(false);
        expect(tween.done(1800)).toBe(true);
    });

    test('zero duration is immediately complete', () => {
        const tween = new Tween(0, 10);
        expect(tween.progress(10)).toBe(1);
        expect(tween.done(10)).toBe(true);
    });
});

describe('Tween.done', () => {
    test('is true whenever progress is 1, even for zero duration under clock skew', () => {
        const tween = new Tween(0, 10);
        expect(tween.progress(5)).toBe(1);
        expect(tween.done(5)).toBe(true);
    });
});

describe('TransitionController', () => {
    const FROM = { scale: 1, offsetX: 0, offsetY: 0 };
    const TO = { scale: 3, offsetX: 100, offsetY: -50 };

    function controller() {
        const viewport = vi.fn<(v: ViewportValue) => void>();
        const rotation = vi.fn<(groupId: number, deg: number, pivot: Point) => void>();
        return { viewport, rotation, transitions: new TransitionController({ viewport, rotation }) };
    }

    function settledFlag(promise: Promise<void>): { settled: boolean } {
        const flag = { settled: false };
        void promise.then(() => { flag.settled = true; });
        return flag;
    }

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('a viewport tween eases from the current transform and resolves with the target applied', async () => {
        const { viewport, transitions } = controller();
        const done = settledFlag(transitions.transitionViewport(FROM, TO, 1000));

        expect(transitions.tick(1000 + VIEWPORT_TRANSITION_MS / 2)).toBe(true);
        const mid = viewport.mock.lastCall![0];
        expect(mid.scale).toBeCloseTo(2, 6);
        expect(mid.offsetX).toBeCloseTo(50, 6);
        expect(mid.offsetY).toBeCloseTo(-25, 6);

        expect(transitions.tick(1000 + VIEWPORT_TRANSITION_MS)).toBe(false);
        expect(viewport).toHaveBeenLastCalledWith(TO);
        await vi.advanceTimersByTimeAsync(0);
        expect(done.settled).toBe(true);
    });

    test('setViewportTransform during a viewport tween cancels it and resolves its promise', async () => {
        const { viewport, transitions } = controller();
        const done = settledFlag(transitions.transitionViewport(FROM, TO, 1000));
        transitions.tick(1100);

        const pinch = { scale: 0.5, offsetX: 7, offsetY: 8 };
        transitions.setViewport(pinch);

        expect(viewport).toHaveBeenLastCalledWith(pinch);
        expect(transitions.tick(1400)).toBe(false);
        await vi.advanceTimersByTimeAsync(VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS);
        expect(viewport).toHaveBeenLastCalledWith(pinch);
        expect(done.settled).toBe(true);
    });

    test('a new viewport transition replaces the running one and resolves its promise', async () => {
        const { viewport, transitions } = controller();
        const first = settledFlag(transitions.transitionViewport(FROM, TO, 1000));
        const target = { scale: 2, offsetX: 1, offsetY: 2 };
        const second = settledFlag(transitions.transitionViewport(TO, target, 1200));

        await vi.advanceTimersByTimeAsync(0);
        expect(first.settled).toBe(true);
        expect(second.settled).toBe(false);
        transitions.tick(1200 + VIEWPORT_TRANSITION_MS);
        expect(viewport).toHaveBeenLastCalledWith(target);
        await vi.advanceTimersByTimeAsync(0);
        expect(second.settled).toBe(true);
    });

    test('a group rotation interpolates degrees about the pivot', () => {
        const { rotation, transitions } = controller();
        const pivot = { x: 5, y: 6 };
        void transitions.animateGroupRotation(4, 90, 0, pivot, 0);

        transitions.tick(VIEWPORT_TRANSITION_MS / 2);
        expect(rotation.mock.lastCall![0]).toBe(4);
        expect(rotation.mock.lastCall![1]).toBeCloseTo(45, 6);
        expect(rotation.mock.lastCall![2]).toBe(pivot);
        expect(transitions.isRotating(4)).toBe(true);

        transitions.tick(VIEWPORT_TRANSITION_MS);
        expect(rotation).toHaveBeenLastCalledWith(4, 0, pivot);
        expect(transitions.isRotating(4)).toBe(false);
    });

    test('a new game cancels the rotation override and resolves its promise', async () => {
        const { rotation, transitions } = controller();
        const done = settledFlag(transitions.animateGroupRotation(4, 90, 0, { x: 0, y: 0 }, 0));
        transitions.tick(100);
        const calls = rotation.mock.calls.length;

        transitions.newGame();

        expect(transitions.isRotating(4)).toBe(false);
        expect(transitions.tick(400)).toBe(false);
        await vi.advanceTimersByTimeAsync(VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS);
        expect(rotation.mock.calls.length).toBe(calls);
        expect(done.settled).toBe(true);
    });

    test('a rotation pins its starting angle before the first frame', () => {
        const { rotation, transitions } = controller();
        void transitions.animateGroupRotation(4, 90, 0, { x: 5, y: 6 }, 0);

        expect(rotation).toHaveBeenCalledExactlyOnceWith(4, 90, { x: 5, y: 6 });
    });

    test('a rotation override is released once, only after its spin ends', () => {
        const { transitions } = controller();
        void transitions.animateGroupRotation(4, 90, 0, { x: 0, y: 0 }, 0);
        void transitions.animateGroupRotation(7, 0, 90, { x: 0, y: 0 }, 100);

        expect(transitions.takeSettledRotations()).toEqual([]);
        transitions.tick(VIEWPORT_TRANSITION_MS);
        expect(transitions.takeSettledRotations()).toEqual([4]);
        expect(transitions.takeSettledRotations()).toEqual([]);
        transitions.tick(100 + VIEWPORT_TRANSITION_MS);
        expect(transitions.takeSettledRotations()).toEqual([7]);
    });

    test('a rotation settled by the guard timer is released', async () => {
        const { transitions } = controller();
        void transitions.animateGroupRotation(4, 90, 0, { x: 0, y: 0 }, 0);

        await vi.advanceTimersByTimeAsync(VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS);

        expect(transitions.takeSettledRotations()).toEqual([4]);
    });

    test('a new game forgets rotation overrides instead of releasing them into its groups', () => {
        const { transitions } = controller();
        void transitions.animateGroupRotation(4, 90, 0, { x: 0, y: 0 }, 0);
        transitions.tick(VIEWPORT_TRANSITION_MS);

        transitions.newGame();

        expect(transitions.takeSettledRotations()).toEqual([]);
    });

    test('without frames, the guard timer applies the final values and resolves', async () => {
        const { viewport, rotation, transitions } = controller();
        const zoom = settledFlag(transitions.transitionViewport(FROM, TO, 0));
        const spin = settledFlag(transitions.animateGroupRotation(2, 270, 360, { x: 1, y: 1 }, 0));

        await vi.advanceTimersByTimeAsync(VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS - 1);
        expect(zoom.settled).toBe(false);
        expect(spin.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(viewport).toHaveBeenLastCalledWith(TO);
        expect(rotation).toHaveBeenLastCalledWith(2, 360, { x: 1, y: 1 });
        expect(zoom.settled).toBe(true);
        expect(spin.settled).toBe(true);
    });

    test('dispose resolves every running transition without applying it', async () => {
        const { viewport, transitions } = controller();
        const zoom = settledFlag(transitions.transitionViewport(FROM, TO, 0));

        transitions.dispose();

        await vi.advanceTimersByTimeAsync(VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS);
        expect(zoom.settled).toBe(true);
        expect(viewport).not.toHaveBeenCalled();
    });
});
