/**
 * Rounds every generated coordinate — edge endpoints, curve samples, image
 * offset — to {@link GEOMETRY_PRECISION_DECIMALS} decimals, so a generated
 * puzzle's geometry is identical in memory, in `localStorage`, and regenerated
 * from a share link. Only generated geometry: pre-existing saves are not
 * re-rounded on load.
 *
 * Runs before sealing (`model/seal-geometry.ts`), so the `bounds` sealing
 * derives from curve samples inherit this precision; the other order would put
 * full-precision numbers back into the blob.
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

/**
 * Rounded in image space, not the local frame: both sides of a cut then share
 * one 2-decimal image point, so mates' endpoints agree exactly across frames.
 */
function quantizeVertex(point: Point, rawOffset: Point, offset: Point): Point {
    return {
        x: quantize(quantize(point.x - rawOffset.x) + offset.x),
        y: quantize(quantize(point.y - rawOffset.y) + offset.y),
    };
}

function quantizeEdge(edge: GeneratedEdge, rawOffset: Point, offset: Point): GeneratedEdge {
    const quantized: GeneratedEdge = {
        ...edge,
        start: quantizeVertex(edge.start, rawOffset, offset),
        end: quantizeVertex(edge.end, rawOffset, offset),
    };
    if (edge.curvePoints) {
        quantized.curvePoints = edge.curvePoints.map(quantizePoint);
    }
    return quantized;
}

/** Pure: inputs are left untouched (pieces are treated as immutable). */
export function quantizePieceGeometry(pieces: GeneratedPiece[]): GeneratedPiece[] {
    return pieces.map((piece) => {
        const imageOffset = quantizePoint(piece.imageOffset);
        return {
            ...piece,
            edges: piece.edges.map((edge) => quantizeEdge(edge, piece.imageOffset, imageOffset)),
            imageOffset,
        };
    });
}
