import { describe, expect, test } from 'vitest';
import { cubicBezierEase, EASE_IN_OUT, Tween } from './animation.js';

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
