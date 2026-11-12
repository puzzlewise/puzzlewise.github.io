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
        return now - this.startMs >= this.durationMs;
    }
}
