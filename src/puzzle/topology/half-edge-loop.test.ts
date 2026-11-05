import { describe, it, expect } from 'vitest';
import { walkLoop } from './half-edge-loop.js';
import { buildDCEL, countFaceEdges, getFaceVertices } from './dcel.js';
import type { HalfEdge, TopologyGraph } from './dcel.js';
import { Curve } from './curve.js';
import { facesToPieceDefinitions } from './faces-to-pieces.js';

function rectangle(): TopologyGraph {
    return buildDCEL({
        curves: [
            Curve.line({ x: 0, y: 0 }, { x: 100, y: 0 }),
            Curve.line({ x: 100, y: 0 }, { x: 100, y: 80 }),
            Curve.line({ x: 100, y: 80 }, { x: 0, y: 80 }),
            Curve.line({ x: 0, y: 80 }, { x: 0, y: 0 }),
        ],
    });
}

function innerFaceStart(graph: TopologyGraph): HalfEdge {
    const face = graph.faces.find(f => !f.isOuter);
    if (!face) throw new Error('rectangle has no inner face');
    return face.outerEdge;
}

function corruptIntoRho(start: HalfEdge): void {
    const third = start.next.next;
    third.next.next = third;
}

describe('walkLoop', () => {
    it('returns each half-edge of a face once, in next order, from the start', () => {
        const start = innerFaceStart(rectangle());
        const loop = walkLoop(start);
        expect(loop).toHaveLength(4);
        expect(loop[0]).toBe(start);
        for (let i = 0; i < loop.length; i++) {
            expect(loop[i].next).toBe(loop[(i + 1) % loop.length]);
        }
        expect(new Set(loop).size).toBe(4);
    });

    it('handles a half-edge whose next is itself', () => {
        const he = { id: 0 } as HalfEdge;
        he.next = he;
        expect(walkLoop(he)).toEqual([he]);
    });

    it('throws instead of looping forever when the walk never returns to its start', () => {
        const start = innerFaceStart(rectangle());
        corruptIntoRho(start);
        expect(() => walkLoop(start)).toThrow(/never returns/);
    });

    it('throws on a long tail before a long cycle', () => {
        const edges = Array.from({ length: 1000 }, (_, id) => ({ id }) as HalfEdge);
        for (let i = 0; i < edges.length - 1; i++) edges[i].next = edges[i + 1];
        edges[edges.length - 1].next = edges[600];
        expect(() => walkLoop(edges[0])).toThrow(/never returns/);
    });
});

describe('face walks on a corrupted graph', () => {
    it('throw instead of hanging', () => {
        const graph = rectangle();
        const face = graph.faces.find(f => !f.isOuter)!;
        corruptIntoRho(face.outerEdge);
        expect(() => countFaceEdges(face)).toThrow(/never returns/);
        expect(() => getFaceVertices(face)).toThrow(/never returns/);
        expect(() => facesToPieceDefinitions(graph)).toThrow(/never returns/);
    });
});
