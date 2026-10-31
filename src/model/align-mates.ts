import { buildShape } from './build-shape.js';
import { deriveMateSegments, formatEdgePath, parseEdgePath } from './edge-path.js';
import type { PathSegment } from './edge-path.js';
import type { GeneratedEdge, GeneratedPiece, Point } from './types.js';

function segmentsEndingAt(path: string, end: Point): PathSegment[] | null {
    const segments = parseEdgePath(path);
    if (!segments) return null;
    segments[segments.length - 1] = { ...segments[segments.length - 1], to: end };
    return segments;
}

/**
 * Runs after `quantizePieceGeometry`: derivation needs the rounded offsets and
 * `start`/`end` the pieces keep.
 */
export function alignMatePaths(pieces: GeneratedPiece[]): GeneratedPiece[] {
    const aligned = pieces.map((piece) => ({
        ...piece,
        edges: piece.edges.map((edge) => ({ ...edge })),
    }));

    const owners = new Map<number, { edge: GeneratedEdge; imageOffset: Point }>();
    for (const piece of aligned) {
        for (const edge of piece.edges) owners.set(edge.id, { edge, imageOffset: piece.imageOffset });
    }

    const done = new Set<GeneratedEdge>();
    for (const piece of aligned) {
        for (const canon of piece.edges) {
            if (canon.id >= canon.mateEdgeId) continue;
            const mate = owners.get(canon.mateEdgeId);
            if (mate?.edge.mateEdgeId !== canon.id) continue;
            const segments = segmentsEndingAt(canon.path, canon.end);
            if (!segments) continue;
            canon.path = formatEdgePath(segments);
            mate.edge.path = formatEdgePath(
                deriveMateSegments(segments, canon.start, piece.imageOffset, mate.imageOffset),
            );
            done.add(canon).add(mate.edge);
        }
    }

    for (const piece of aligned) {
        for (const edge of piece.edges) {
            if (done.has(edge)) continue;
            const segments = segmentsEndingAt(edge.path, edge.end);
            if (segments) edge.path = formatEdgePath(segments);
        }
    }

    return aligned.map((piece) => ({ ...piece, shape: buildShape(piece.edges) }));
}
