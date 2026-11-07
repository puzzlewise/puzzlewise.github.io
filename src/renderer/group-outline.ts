import { CHAIN_EPSILON, fmt } from '../model/build-shape.js';
import type { Piece, Point } from '../model/types.js';
import { translatePath } from './translate-path.js';

interface OuterEdge {
    start: Point;
    end: Point;
    d: string;
    used: boolean;
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * Only edges whose mate is outside the group, so the path grows with the
 * group's perimeter rather than its piece count. Loops may split differently
 * from the visible outline; the nonzero fill is the same as long as piece
 * outlines wind consistently, as every generator's do. Null when the edges
 * don't close into loops.
 */
export function groupOutlinePath(
    offsets: ReadonlyMap<number, Point>,
    pieces: ReadonlyMap<number, Piece>,
): string | null {
    const edges: OuterEdge[] = [];
    const byStart = new Map<string, OuterEdge[]>();
    for (const [pieceId, offset] of offsets) {
        const piece = pieces.get(pieceId);
        if (!piece) return null;
        for (const edge of piece.edges) {
            if (offsets.has(edge.matePieceId)) continue;
            const outer: OuterEdge = {
                start: { x: edge.start.x + offset.x, y: edge.start.y + offset.y },
                end: { x: edge.end.x + offset.x, y: edge.end.y + offset.y },
                d: translatePath(edge.path, offset.x, offset.y),
                used: false,
            };
            edges.push(outer);
            const key = cellKey(Math.floor(outer.start.x), Math.floor(outer.start.y));
            const bucket = byStart.get(key);
            if (bucket) bucket.push(outer);
            else byStart.set(key, [outer]);
        }
    }

    const near = (a: Point, b: Point): boolean =>
        Math.abs(a.x - b.x) < CHAIN_EPSILON && Math.abs(a.y - b.y) < CHAIN_EPSILON;
    const unusedStartingAt = (point: Point): OuterEdge | undefined => {
        const cx = Math.floor(point.x);
        const cy = Math.floor(point.y);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const found = byStart.get(cellKey(cx + dx, cy + dy))
                    ?.find((e) => !e.used && near(e.start, point));
                if (found) return found;
            }
        }
        return undefined;
    };

    const parts: string[] = [];
    for (const first of edges) {
        if (first.used) continue;
        parts.push(`M ${fmt(first.start.x)} ${fmt(first.start.y)}`);
        let edge: OuterEdge | undefined = first;
        let end = first.start;
        while (edge) {
            edge.used = true;
            parts.push(edge.d);
            end = edge.end;
            edge = unusedStartingAt(end);
        }
        if (!near(end, first.start)) return null;
        parts.push('Z');
    }
    return parts.join(' ');
}
