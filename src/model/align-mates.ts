import { buildShape } from './build-shape.js';
import { deriveMateSegments, formatEdgePath, parseEdgePath } from './edge-path.js';
import type { PathSegment } from './edge-path.js';
import { quantize } from './quantize-geometry.js';
import type { Edge, GeneratedPiece, Piece, PieceGroup, Point } from './types.js';

interface PieceEdges<E extends Edge> {
    edges: E[];
    imageOffset: Point;
}

function isPoint(p: Point | undefined): p is Point {
    return Number.isFinite(p?.x) && Number.isFinite(p?.y);
}

function segmentsEndingAt(path: string, end: Point): PathSegment[] | null {
    const segments = parseEdgePath(path);
    if (!segments) return null;
    segments[segments.length - 1] = { ...segments[segments.length - 1], to: end };
    return segments;
}

/**
 * The rule new games are built with, applied in place: each mutual pair is
 * derived from its lower-id side, and every other path ends at its own
 * vertex. Edges whose path or points aren't usable keep their stored bytes.
 * `keepEndedPaths`: a path already ending at its vertex keeps its bytes;
 * generation reformats it instead, and new-game bytes depend on that.
 */
function alignEdges<E extends Edge>(pieces: PieceEdges<E>[], keepEndedPaths: boolean): void {
    const owners = new Map<number, { edge: E; imageOffset: Point }>();
    for (const piece of pieces) {
        for (const edge of piece.edges) owners.set(edge.id, { edge, imageOffset: piece.imageOffset });
    }

    const done = new Set<E>();
    for (const piece of pieces) {
        for (const canon of piece.edges) {
            if (!(canon.id < canon.mateEdgeId)) continue;
            const mate = owners.get(canon.mateEdgeId);
            if (!mate || mate.edge.mateEdgeId !== canon.id || typeof canon.path !== 'string') continue;
            if (!isPoint(canon.start) || !isPoint(canon.end)) continue;
            if (!isPoint(piece.imageOffset) || !isPoint(mate.imageOffset)) continue;
            const segments = segmentsEndingAt(canon.path, canon.end);
            if (!segments) continue;
            canon.path = formatEdgePath(segments);
            mate.edge.path = formatEdgePath(
                deriveMateSegments(segments, canon.start, piece.imageOffset, mate.imageOffset),
            );
            done.add(canon).add(mate.edge);
        }
    }

    for (const piece of pieces) {
        for (const edge of piece.edges) {
            if (done.has(edge) || typeof edge.path !== 'string' || !isPoint(edge.end)) continue;
            const segments = parseEdgePath(edge.path);
            if (!segments) continue;
            const last = segments.length - 1;
            const { to } = segments[last];
            if (keepEndedPaths && to.x === edge.end.x && to.y === edge.end.y) continue;
            segments[last] = { ...segments[last], to: edge.end };
            edge.path = formatEdgePath(segments);
        }
    }
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

    alignEdges(aligned, false);

    return aligned.map((piece) => ({ ...piece, shape: buildShape(piece.edges) }));
}

const VERTEX_SNAP = 0.05;

/**
 * `imageOffset` must already be rounded: the result is exact only on the
 * 2-decimal grid the mate derivation works on. Vertices are rounded in each
 * piece's own frame in pre-v14 saves, so one corner can sit 0.01 px apart
 * between pieces. The first occurrence wins;
 * generated vertices are ≥3 px apart (`VERTEX_MERGE_TOLERANCE`), far beyond
 * `VERTEX_SNAP`.
 */
function vertexSnapper(): (local: Point, imageOffset: Point) => Point {
    const seen = new Map<string, Point[]>();
    return (local, imageOffset) => {
        if (!isPoint(local) || !isPoint(imageOffset)) return local;
        const image = { x: quantize(local.x - imageOffset.x), y: quantize(local.y - imageOffset.y) };
        const cx = Math.round(image.x / VERTEX_SNAP);
        const cy = Math.round(image.y / VERTEX_SNAP);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const hit = seen.get(`${cx + dx},${cy + dy}`)?.find(
                    (p) => Math.abs(p.x - image.x) <= VERTEX_SNAP && Math.abs(p.y - image.y) <= VERTEX_SNAP,
                );
                if (hit) return { x: quantize(hit.x + imageOffset.x), y: quantize(hit.y + imageOffset.y) };
            }
        }
        const key = `${cx},${cy}`;
        const bucket = seen.get(key);
        if (bucket) bucket.push(image);
        else seen.set(key, [image]);
        return { x: quantize(image.x + imageOffset.x), y: quantize(image.y + imageOffset.y) };
    };
}

/** For pre-v14 saves (#690). Pure, so a caller may persist the result. */
export function alignLegacyMates<P extends PieceEdges<Edge>>(pieces: readonly P[]): P[] {
    const snap = vertexSnapper();
    const copies = pieces.map((piece) => {
        const imageOffset = isPoint(piece.imageOffset)
            ? { x: quantize(piece.imageOffset.x), y: quantize(piece.imageOffset.y) }
            : piece.imageOffset;
        return {
            ...piece,
            imageOffset,
            edges: piece.edges.map((edge) => ({
                ...edge,
                start: snap(edge.start, imageOffset),
                end: snap(edge.end, imageOffset),
            })),
        };
    });
    alignEdges(copies, true);
    return copies;
}

/**
 * A merge sets the moved piece's offset from the stored endpoints, so in a
 * pre-v14 save every merge carries that save's endpoint error and chains of
 * merges add it up to about a tenth of a pixel. Aligned geometry mates only
 * where offset + imageOffset is the same for every piece of a group. A
 * correction of 1 px or more can't come from that drift, so such a group is
 * left exactly as stored rather than "fixed".
 */
const MAX_GROUP_OFFSET_CORRECTION = 1;

/** Pure, so a caller may persist the result; the first piece of each group is the anchor. */
export function alignLegacyGroupOffsets(
    groups: readonly PieceGroup[],
    piecesById: ReadonlyMap<number, Pick<Piece, 'imageOffset'>>,
): PieceGroup[] {
    return groups.map((group) => {
        const [first, ...rest] = group.pieces;
        const anchor = first && piecesById.get(first[0])?.imageOffset;
        if (rest.length === 0 || !isPoint(anchor) || !isPoint(first[1])) return group;
        const base = { x: first[1].x + anchor.x, y: first[1].y + anchor.y };

        const corrected = new Map(group.pieces);
        for (const [id, offset] of rest) {
            const imageOffset = piecesById.get(id)?.imageOffset;
            if (!isPoint(imageOffset) || !isPoint(offset)) continue;
            const ideal = { x: base.x - imageOffset.x, y: base.y - imageOffset.y };
            if (Math.hypot(ideal.x - offset.x, ideal.y - offset.y) >= MAX_GROUP_OFFSET_CORRECTION) return group;
            corrected.set(id, ideal);
        }
        return { ...group, pieces: corrected };
    });
}
