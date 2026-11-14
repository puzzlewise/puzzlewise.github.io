import type { Point } from '../../model/types.js';
import { SETTLE_GRACE_MS, VIEWPORT_TRANSITION_MS } from '../types.js';

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 1e-3;
const SOLVE_PRECISION = 1e-7;
const BISECTION_MAX_ITERATIONS = 50;

function coordinate(t: number, a: number, b: number): number {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
}

function slope(t: number, a: number, b: number): number {
    const u = 1 - t;
    return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b);
}

export function cubicBezierEase(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
    const solveT = (x: number): number => {
        let t = x;
        for (let i = 0; i < NEWTON_ITERATIONS; i++) {
            const dx = slope(t, x1, x2);
            if (Math.abs(dx) < NEWTON_MIN_SLOPE) {
                break;
            }
            t -= (coordinate(t, x1, x2) - x) / dx;
        }
        if (t >= 0 && t <= 1 && Math.abs(coordinate(t, x1, x2) - x) < SOLVE_PRECISION) {
            return t;
        }
        let lo = 0;
        let hi = 1;
        t = x;
        for (let i = 0; i < BISECTION_MAX_ITERATIONS; i++) {
            const err = coordinate(t, x1, x2) - x;
            if (Math.abs(err) < SOLVE_PRECISION) {
                break;
            }
            if (err > 0) {
                hi = t;
            } else {
                lo = t;
            }
            t = (lo + hi) / 2;
        }
        return t;
    };

    return (x: number): number => {
        if (x <= 0) {
            return 0;
        }
        if (x >= 1) {
            return 1;
        }
        return coordinate(solveT(x), y1, y2);
    };
}

export const EASE_IN_OUT = cubicBezierEase(0.42, 0, 0.58, 1);

export class Tween {
    private readonly durationMs: number;
    private readonly startMs: number;

    constructor(durationMs: number, now: number) {
        this.durationMs = durationMs;
        this.startMs = now;
    }

    progress(now: number): number {
        if (this.durationMs <= 0) {
            return 1;
        }
        const linear = Math.min(1, Math.max(0, (now - this.startMs) / this.durationMs));
        return EASE_IN_OUT(linear);
    }

    done(now: number): boolean {
        return this.progress(now) === 1;
    }
}

export interface ViewportValue {
    scale: number;
    offsetX: number;
    offsetY: number;
}

export interface TransitionTargets {
    viewport(value: ViewportValue): void;
    rotation(groupId: number, deg: number, pivot: Point): void;
}

interface Running {
    tween: Tween;
    apply(progress: number): void;
    timer: ReturnType<typeof setTimeout>;
    resolve(): void;
}

const VIEWPORT_KEY = 'viewport';

/**
 * Each transition also settles on a timer, applying its final value: a hidden
 * tab runs no animation frames, and callers await these promises.
 */
export class TransitionController {
    private readonly targets: TransitionTargets;
    private readonly running = new Map<string, Running>();
    /** A rotation override outlives its spin until the caller's next model sync releases it. */
    private readonly overridden = new Set<number>();

    constructor(targets: TransitionTargets) {
        this.targets = targets;
    }

    transitionViewport(from: ViewportValue, to: ViewportValue, now: number): Promise<void> {
        return this.start(VIEWPORT_KEY, now, (p) => this.targets.viewport(p === 1 ? to : {
            scale: from.scale + (to.scale - from.scale) * p,
            offsetX: from.offsetX + (to.offsetX - from.offsetX) * p,
            offsetY: from.offsetY + (to.offsetY - from.offsetY) * p,
        }));
    }

    /** Cancels a running viewport tween; otherwise it would override a pinch or wheel until it ends. */
    setViewport(value: ViewportValue): void {
        this.cancel(VIEWPORT_KEY);
        this.targets.viewport(value);
    }

    animateGroupRotation(groupId: number, fromDeg: number, toDeg: number, pivot: Point, now: number): Promise<void> {
        // Pinned now: the caller writes the group's final model transform right after this call.
        this.overridden.add(groupId);
        this.targets.rotation(groupId, fromDeg, pivot);
        return this.start(rotationKey(groupId), now, (p) => {
            this.targets.rotation(groupId, p === 1 ? toDeg : fromDeg + (toDeg - fromDeg) * p, pivot);
        });
    }

    isRotating(groupId: number): boolean {
        return this.running.has(rotationKey(groupId));
    }

    takeSettledRotations(): number[] {
        const settled = [...this.overridden].filter((groupId) => !this.isRotating(groupId));
        for (const groupId of settled) this.overridden.delete(groupId);
        return settled;
    }

    /** Group ids restart at 0 each game, so a surviving rotation would spin a group of the new one. */
    newGame(): void {
        for (const key of this.running.keys()) {
            if (key !== VIEWPORT_KEY) this.cancel(key);
        }
        this.overridden.clear();
    }

    tick(now: number): boolean {
        for (const [key, running] of this.running) {
            running.apply(running.tween.progress(now));
            if (running.tween.done(now)) this.finish(key, running);
        }
        return this.running.size > 0;
    }

    dispose(): void {
        for (const key of this.running.keys()) this.cancel(key);
        this.overridden.clear();
    }

    private start(key: string, now: number, apply: (progress: number) => void): Promise<void> {
        this.cancel(key);
        return new Promise((resolve) => {
            const running: Running = {
                tween: new Tween(VIEWPORT_TRANSITION_MS, now),
                apply,
                resolve,
                timer: setTimeout(() => {
                    if (this.running.get(key) !== running) return;
                    apply(1);
                    this.finish(key, running);
                }, VIEWPORT_TRANSITION_MS + SETTLE_GRACE_MS),
            };
            this.running.set(key, running);
        });
    }

    private cancel(key: string): void {
        const running = this.running.get(key);
        if (running) this.finish(key, running);
    }

    private finish(key: string, running: Running): void {
        clearTimeout(running.timer);
        this.running.delete(key);
        running.resolve();
    }
}

function rotationKey(groupId: number): string {
    return `rotation:${groupId}`;
}
