import { describe, it, expect } from 'vitest';
import { deriveMatePath, formatEdgePath, parseEdgePath } from './edge-path.js';
import type { Point } from './types.js';

const ZERO: Point = { x: 0, y: 0 };

const ROUND_TRIP_PATHS = [
    'L 10 0',
    'C 12 3, 12 7, 10 10',
    'A 12.50 12.50 0 0,1 25 0',
    'L 1.50 2 C 3 4, 5 6, 7.25 8 L 9 10',
];

describe('parseEdgePath / formatEdgePath', () => {
    it.each(ROUND_TRIP_PATHS)('round-trips %s exactly', (path) => {
        const segments = parseEdgePath(path);
        expect(segments).not.toBeNull();
        expect(formatEdgePath(segments!)).toBe(path);
    });

    it('accepts legacy unformatted floats and formats them to 2 decimals', () => {
        const segments = parseEdgePath('L 135.00000000001 -2e-7');
        expect(segments).not.toBeNull();
        expect(formatEdgePath(segments!)).toBe('L 135 0');
    });

    it.each(['Q 1 2 3 4', 'L 1', '', 'L 1 2 3', 'L 1 x', 'C 1 2, 3 4, 5', 'A 1 1 0 2,1 5 5', 'L 0x10 0'])(
        'returns null for %j',
        (path) => {
            expect(parseEdgePath(path)).toBeNull();
        },
    );
});

describe('deriveMatePath', () => {
    it('reverses lines and translates by the offset difference', () => {
        expect(deriveMatePath('L 5 0 L 10 0', ZERO, ZERO, { x: -10, y: 0 })).toBe('L -5 0 L -10 0');
    });

    it('swaps the control points of a cubic', () => {
        expect(deriveMatePath('C 1 2, 3 4, 5 6', ZERO, ZERO, ZERO)).toBe('C 3 4, 1 2, 0 0');
    });

    it('flips the arc sweep', () => {
        expect(deriveMatePath('A 5 5 0 0,1 10 0', ZERO, ZERO, ZERO)).toBe('A 5 5 0 0,0 0 0');
    });

    it('returns null for an unparseable path', () => {
        expect(deriveMatePath('Q 1 2 3 4', ZERO, ZERO, ZERO)).toBeNull();
    });

    it('absorbs float noise in the offset arithmetic', () => {
        expect(deriveMatePath('L 0.1 0', ZERO, { x: 0.2, y: 0 }, { x: 0.3, y: 0 })).toBe('L 0.10 0');
    });

    it.each([
        ['L 10 0', { x: 0, y: 0 }],
        ['C 12 3, 12 7, 10 10', { x: 3.25, y: -1.5 }],
        ['A 12.50 12.50 0 0,1 25 0', { x: 100, y: 50.75 }],
        ['L 1.50 2 C 3 4, 5 6, 7.25 8 L 9 10', { x: -2.5, y: 4 }],
    ])('is an involution for %s', (path, start) => {
        const from: Point = { x: -64.33, y: 0 };
        const to: Point = { x: -118.4, y: -0.07 };
        const segments = parseEdgePath(path)!;
        const last = segments[segments.length - 1].to;
        const mateStart: Point = {
            x: Math.round((last.x - from.x + to.x) * 100) / 100,
            y: Math.round((last.y - from.y + to.y) * 100) / 100,
        };

        const mate = deriveMatePath(path, start, from, to)!;
        expect(mate).not.toBeNull();
        expect(deriveMatePath(mate, mateStart, to, from)).toBe(formatEdgePath(segments));
    });
});
