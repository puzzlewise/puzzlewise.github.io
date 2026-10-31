import { alignMatePaths } from './align-mates.js';
import { quantizePieceGeometry } from './quantize-geometry.js';
import { sealPieceGeometry } from './seal-geometry.js';
import type { GeneratedPiece, Piece } from './types.js';

export function finalizePieceGeometry(pieces: GeneratedPiece[]): Piece[] {
    return sealPieceGeometry(alignMatePaths(quantizePieceGeometry(pieces)));
}
