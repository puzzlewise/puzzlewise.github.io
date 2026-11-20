import { describe, it, expect } from 'vitest';
import { getPathBounds } from './path-bounds.js';

describe('getPathBounds', () => {
    it('should return start point bounds for empty path', () => {
        const bounds = getPathBounds('', { x: 10, y: 20 });
        expect(bounds).toEqual({ minX: 10, minY: 20, maxX: 10, maxY: 20 });
    });

    it('should handle absolute line commands', () => {
        const bounds = getPathBounds('M 0 0 L 100 50 L 50 100', { x: 0, y: 0 });
        expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    });

    it('should handle relative line commands', () => {
        const bounds = getPathBounds('l 100 0 l 0 80', { x: 10, y: 10 });
        expect(bounds).toEqual({ minX: 10, minY: 10, maxX: 110, maxY: 90 });
    });

    it('should include cubic bezier control points (absolute)', () => {
        // Control points at (50, -30) and (50, 130) extend beyond endpoints
        const bounds = getPathBounds('C 50 -30, 50 130, 100 50', { x: 0, y: 0 });
        expect(bounds.minY).toBe(-30);
        expect(bounds.maxY).toBe(130);
        expect(bounds.maxX).toBe(100);
    });

    it('should include cubic bezier control points (relative)', () => {
        const bounds = getPathBounds('c 20 -40, 80 -40, 100 0', { x: 0, y: 50 });
        expect(bounds.minY).toBe(10); // 50 + (-40)
        expect(bounds.maxX).toBe(100);
    });

    it('should include quadratic bezier control points', () => {
        const bounds = getPathBounds('Q 50 -20, 100 0', { x: 0, y: 0 });
        expect(bounds.minY).toBe(-20);
        expect(bounds.maxX).toBe(100);
    });

    it('should handle H and V commands', () => {
        const bounds = getPathBounds('H 200 V 150', { x: 10, y: 10 });
        expect(bounds).toEqual({ minX: 10, minY: 10, maxX: 200, maxY: 150 });
    });

    it('should handle relative h and v commands', () => {
        const bounds = getPathBounds('h 50 v 30', { x: 10, y: 10 });
        expect(bounds).toEqual({ minX: 10, minY: 10, maxX: 60, maxY: 40 });
    });

    it('should handle S (smooth cubic) commands', () => {
        const bounds = getPathBounds('S 50 -20, 100 0', { x: 0, y: 0 });
        expect(bounds.minY).toBe(-20);
        expect(bounds.maxX).toBe(100);
    });

    it('should handle Z command without error', () => {
        const bounds = getPathBounds('L 100 100 Z', { x: 0, y: 0 });
        expect(bounds.maxX).toBe(100);
        expect(bounds.maxY).toBe(100);
    });

    it('should handle a realistic jigsaw tab path', () => {
        // Simulates a tab that bulges outward (negative y = upward)
        const path = 'L 30 0 C 35 -25, 65 -25, 70 0 L 100 0';
        const bounds = getPathBounds(path, { x: 0, y: 0 });
        expect(bounds.minY).toBe(-25);
        expect(bounds.maxX).toBe(100);
        expect(bounds.minX).toBe(0);
    });

    it.each([
        ['numbers separated only by a sign', 'L10-20L-30-40', { minX: -30, minY: -40, maxX: 10, maxY: 0 }],
        ['a second decimal point starting a new number', 'L1.5.5 2.25.75', { minX: 0, minY: 0, maxX: 2.25, maxY: 0.75 }],
        ['a leading or trailing decimal point', 'L.5 2. L-.25 -3.', { minX: -0.25, minY: -3, maxX: 0.5, maxY: 2 }],
        ['exponents', 'L1e2 -2.5E1 L5e-1 1e0', { minX: 0, minY: -25, maxX: 100, maxY: 1 }],
        ['an exponent marker without digits', 'L1e 2', { minX: 0, minY: 0, maxX: 1, maxY: 2 }],
        ['commands and commas without whitespace', 'M5,5L10,20C1,2,3,4,50,60Z', { minX: 0, minY: 0, maxX: 50, maxY: 60 }],
        ['an incomplete trailing coordinate pair', 'L 10 20 30', { minX: 0, minY: 0, maxX: 10, maxY: 20 }],
        ['text that is not a command', 'L 10 20 x 99 99 L 30 5', { minX: 0, minY: 0, maxX: 30, maxY: 20 }],
    ])('should parse %s', (_name, path, expected) => {
        expect(getPathBounds(path, { x: 0, y: 0 })).toEqual(expected);
    });
});
