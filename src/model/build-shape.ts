/**
 * Shared with persistence: `serializePieces` omits `piece.shape` from the blob
 * when this reproduces it byte-identically from the edge paths (a shape it
 * cannot is stored verbatim), and the loader rebuilds it from those paths.
 *
 * ON-DISK CONTRACT (v12+): for an omitted `shape` the bytes emitted here *are*
 * the stored geometry. Changing the output (spacing, `Z` placement,
 * `CHAIN_EPSILON`, `fmt`) re-renders every saved v12 puzzle and needs a
 * `STATE_VERSION` bump. Tripwire: the rebuild fixture in
 * `persistence/serialization.test.ts`.
 */

import type { Edge, Point } from './types.js';

/**
 * The 2-decimal cap is app-wide — every rendered path comes through here — and
 * the anchor for `GEOMETRY_PRECISION_DECIMALS` (`model/quantize-geometry.ts`),
 * which rounds stored coordinates to the precision that can reach the screen.
 * Raising it without raising that constant makes storage the binding
 * constraint on rendered geometry; a test pins the coupling.
 */
export function fmt(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Tolerance for matching consecutive edges' end→start in piece-local px. */
const CHAIN_EPSILON = 0.5;

export function buildShape(edges: Edge[]): string {
    if (edges.length === 0) return '';
    const parts: string[] = [];
    let prevEnd: Point | null = null;
    for (const edge of edges) {
        const continuesChain =
            prevEnd !== null
            && Math.abs(prevEnd.x - edge.start.x) < CHAIN_EPSILON
            && Math.abs(prevEnd.y - edge.start.y) < CHAIN_EPSILON;
        if (!continuesChain) {
            if (parts.length > 0) parts.push('Z');
            parts.push(`M ${fmt(edge.start.x)} ${fmt(edge.start.y)}`);
        }
        parts.push(edge.path);
        prevEnd = edge.end;
    }
    parts.push('Z');
    return parts.join(' ');
}
