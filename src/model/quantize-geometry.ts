/**
 * Rounds every generated coordinate — edge endpoints, curve samples, image
 * offset — to {@link GEOMETRY_PRECISION_DECIMALS} decimals, so a generated
 * puzzle's geometry is identical in memory, in `localStorage`, and regenerated
 * from a share link. Only generated geometry: pre-existing saves are not
 * re-rounded on load.
 *
 * Runs before sealing (`model/seal-geometry.ts`), so the `bounds` sealing
 * derives from curve samples inherit this precision; the other order would put
 * full-precision numbers back into the blob. Path strings (`piece.shape`,
 * `edge.path`) are left byte-identical — already `toFixed(2)` from `fmt` —
 * which keeps existing share links reproducing the same rendered geometry.
 */

import type { GeneratedEdge, GeneratedPiece, Point } from './types.js';

/**
 * Two independent limits agree on 2: `fmt` (`model/build-shape.ts`) already
 * truncates rendered paths to `toFixed(2)`, so finer precision can't reach the
 * screen; and the ≤0.005 px rounding error here is far below the strictest
 * merge tolerance (`ui/merge-tolerance.ts`).
 */
export const GEOMETRY_PRECISION_DECIMALS = 2;

const FACTOR = 10 ** GEOMETRY_PRECISION_DECIMALS;

/**
 * `-0` is folded to `0`: `JSON.stringify` writes it `"0"`, so leaving it would
 * make in-memory geometry differ from what's read back. A non-finite result is
 * discarded for the input — `value * FACTOR` overflows to Infinity above
 * ~1.798e306, which `JSON.stringify` writes as `null`; and `NaN`/`±Infinity`
 * inputs pass through unchanged, since this pass rounds coordinates, it does not
 * police them.
 */
export function quantize(value: number): number {
    const rounded = Math.round(value * FACTOR) / FACTOR;
    if (!Number.isFinite(rounded)) return value;
    return rounded === 0 ? 0 : rounded;
}

function quantizePoint(point: Point): Point {
    return { x: quantize(point.x), y: quantize(point.y) };
}

function quantizeEdge(edge: GeneratedEdge): GeneratedEdge {
    const quantized: GeneratedEdge = {
        ...edge,
        start: quantizePoint(edge.start),
        end: quantizePoint(edge.end),
    };
    if (edge.curvePoints) {
        quantized.curvePoints = edge.curvePoints.map(quantizePoint);
    }
    return quantized;
}

/** Pure: inputs are left untouched (pieces are treated as immutable). */
export function quantizePieceGeometry(pieces: GeneratedPiece[]): GeneratedPiece[] {
    return pieces.map((piece) => ({
        ...piece,
        edges: piece.edges.map(quantizeEdge),
        imageOffset: quantizePoint(piece.imageOffset),
    }));
}
