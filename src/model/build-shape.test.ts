import { describe, expect, it } from 'vitest';
import { buildShape, edgePathD, fmt } from './build-shape.js';
import { GEOMETRY_PRECISION_DECIMALS } from './quantize-geometry.js';
import type { Edge } from './types.js';

function edge(id: number, start: { x: number; y: number }, end: { x: number; y: number }, path: string): Edge {
    return { id, mateEdgeId: -1, matePieceId: -1, path, start, end };
}

describe('fmt', () => {
    it('emits integers without decimals and rounds others to 2 dp', () => {
        expect(fmt(5)).toBe('5');
        expect(fmt(-0)).toBe('0');
        expect(fmt(1.005)).toBe('1.00'); // toFixed rounds 1.005 to '1.00'
        expect(fmt(3.14159)).toBe('3.14');
    });

    /**
     * `GEOMETRY_PRECISION_DECIMALS` is derived from `fmt`'s precision. Pinning
     * it fails loudly if `fmt` is raised to a finer precision, which would
     * otherwise make storage the binding constraint on rendered geometry.
     */
    it('renders at the precision GEOMETRY_PRECISION_DECIMALS is anchored to', () => {
        const [, fraction] = fmt(1 / 3).split('.');

        expect(
            fraction,
            "fmt's precision changed: GEOMETRY_PRECISION_DECIMALS " +
            '(model/quantize-geometry.ts) is derived from it and has to move with ' +
            'it, or stored geometry becomes the binding constraint on rendered geometry',
        ).toHaveLength(GEOMETRY_PRECISION_DECIMALS);
    });
});

describe('edgePathD', () => {
    it('starts the edge path at its start point, formatted like the piece shape', () => {
        const e = edge(0, { x: 1.23456, y: 7 }, { x: 10, y: 0 }, 'L 10 0');
        expect(edgePathD(e)).toBe('M 1.23 7 L 10 0');
        expect(buildShape([e])).toBe(`${edgePathD(e)} Z`);
    });
});

describe('buildShape', () => {
    it('returns an empty string for no edges', () => {
        expect(buildShape([])).toBe('');
    });

    it('wraps a chained loop in a single M..Z subpath', () => {
        const edges = [
            edge(0, { x: 0, y: 0 }, { x: 10, y: 0 }, 'L 10 0'),
            edge(1, { x: 10, y: 0 }, { x: 10, y: 10 }, 'L 10 10'),
            edge(2, { x: 10, y: 10 }, { x: 0, y: 0 }, 'L 0 0'),
        ];
        expect(buildShape(edges)).toBe('M 0 0 L 10 0 L 10 10 L 0 0 Z');
    });

    it('starts a new M..Z subpath when the chain breaks by more than 0.5 px', () => {
        const edges = [
            edge(0, { x: 0, y: 0 }, { x: 10, y: 0 }, 'L 10 0'),
            edge(1, { x: 20, y: 20 }, { x: 30, y: 20 }, 'L 30 20'),
        ];
        expect(buildShape(edges)).toBe('M 0 0 L 10 0 Z M 20 20 L 30 20 Z');
    });

    it('tolerates sub-epsilon gaps between consecutive edges', () => {
        const edges = [
            edge(0, { x: 0, y: 0 }, { x: 10, y: 0 }, 'L 10 0'),
            edge(1, { x: 10.4, y: 0.4 }, { x: 10, y: 10 }, 'L 10 10'),
        ];
        expect(buildShape(edges)).toBe('M 0 0 L 10 0 L 10 10 Z');
    });
});
