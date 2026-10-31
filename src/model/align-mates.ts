import { buildShape } from './build-shape.js';
import { deriveMatePath, formatEdgePath, parseEdgePath } from './edge-path.js';
import type { GeneratedEdge, GeneratedPiece, Point } from './types.js';

function endingAt(path: string, end: Point): string | null {
    const segments = parseEdgePath(path);
    if (!segments) return null;
    segments[segments.length - 1] = { ...segments[segments.length - 1], to: end };
    return formatEdgePath(segments);
}

/**
 * Runs after `quantizePieceGeometry`: derivation needs the rounded offsets and
 * `start`/`end` the pieces keep.
 */
export function alignMatePaths(pieces: GeneratedPiece[]): GeneratedPiece[] {
    const aligned = pieces.map((piece) => ({
        ...piece,
        edges: piece.edges.map((edge) => ({ ...edge, path: endingAt(edge.path, edge.end) ?? edge.path })),
    }));

    const owners = new Map<number, { edge: GeneratedEdge; imageOffset: Point }>();
    for (const piece of aligned) {
        for (const edge of piece.edges) owners.set(edge.id, { edge, imageOffset: piece.imageOffset });
    }

    for (const piece of aligned) {
        for (const canon of piece.edges) {
            if (canon.id >= canon.mateEdgeId) continue;
            const mate = owners.get(canon.mateEdgeId);
            if (mate?.edge.mateEdgeId !== canon.id) continue;
            const path = deriveMatePath(canon.path, canon.start, piece.imageOffset, mate.imageOffset);
            if (path !== null) mate.edge.path = path;
        }
    }

    return aligned.map((piece) => ({ ...piece, shape: buildShape(piece.edges) }));
}
