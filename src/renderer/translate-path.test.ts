import { describe, it, expect } from 'vitest';
import { PathDataError, translatePath } from './translate-path.js';

describe('translatePath', () => {
    it('shifts absolute move, line, curve and close commands', () => {
        expect(translatePath('M 0 0 L 10 0 C 1 2, 3 4, 5 6 Q 7 8 9 10 Z', 100, 50)).toBe(
            'M 100 50 L 110 50 C 101 52 103 54 105 56 Q 107 58 109 60 Z',
        );
    });

    it('shifts only the end point of an arc', () => {
        expect(translatePath('M 0 0 A 5 6 30 0 1 10 20', 100, 50)).toBe('M 100 50 A 5 6 30 0 1 110 70');
    });

    it('reads arc flags written without separators', () => {
        expect(translatePath('M0 0A5 5 0 0110 20', 1, 2)).toBe('M 1 2 A 5 5 0 0 1 11 22');
    });

    it('shifts horizontal and vertical lines along their own axis', () => {
        expect(translatePath('M 0 0 H 10 V 20', 100, 50)).toBe('M 100 50 H 110 V 70');
    });

    it('shifts smooth curves', () => {
        expect(translatePath('M 0 0 S 1 2 3 4 T 5 6', 10, 20)).toBe('M 10 20 S 11 22 13 24 T 15 26');
    });

    it('treats extra pairs after a move as absolute lines', () => {
        expect(translatePath('M 0 0 10 0 10 10 Z', 5, 5)).toBe('M 5 5 15 5 15 15 Z');
    });

    it('leaves relative commands alone', () => {
        expect(translatePath('M 0 0 l 10 0 c 1 2 3 4 5 6 a 5 5 0 0 1 10 0 h 3 v 4 z', 100, 50)).toBe(
            'M 100 50 l 10 0 c 1 2 3 4 5 6 a 5 5 0 0 1 10 0 h 3 v 4 z',
        );
    });

    it('shifts a leading relative move, which the spec reads as absolute', () => {
        expect(translatePath('m 1 2 3 4 l 3 4', 10, 20)).toBe('m 11 22 3 4 l 3 4');
    });

    it('parses compact numbers, commas and exponents', () => {
        expect(translatePath('M1-2L.5.5,1e1-3', 10, 10)).toBe('M 11 8 L 10.50 10.50 20 7');
    });

    it('keeps the app-wide two-decimal precision', () => {
        expect(translatePath('M 0.1 0.2', 33.333, 0.001)).toBe('M 33.43 0.20');
    });

    it('starts each closed subpath again from its own move', () => {
        expect(translatePath('M 0 0 L 1 0 Z M 5 5 L 6 5 Z', 1, 1)).toBe('M 1 1 L 2 1 Z M 6 6 L 7 6 Z');
    });

    it.each(['M 0 0 X 1 2', 'M 0 0 L 1 ?', '5 5', 'M 0 0 Z 1', 'M 0 0 A 5 5 0 <> 1 2', 'M 1e999 0'])('throws a PathDataError for %j', (d) => {
        expect(() => translatePath(d, 1, 1)).toThrow(PathDataError);
    });
});
