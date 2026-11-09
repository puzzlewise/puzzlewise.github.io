import type { Edge, Piece, PieceGroup, Point } from '../model/types.js';
import { localToWorld } from '../model/helpers.js';
import { getPathBounds } from './path-bounds.js';

/**
 * Memoized path-bounds for an edge. `getPathBounds` is a regex parser, and
 * free-rotation drag would re-parse every edge's path on each pointermove. Edge
 * objects are immutable for a puzzle's lifetime, so the cache keys off the Edge
 * reference; the WeakMap drops it when a new puzzle replaces `state.piecesById`.
 * The returned BoundingRect is shared — treat it as read-only.
 */
const edgePathBoundsCache = new WeakMap<
    Edge,
    { minX: number; minY: number; maxX: number; maxY: number }
>();

function cachedEdgePathBounds(
    edge: Edge,
): { minX: number; minY: number; maxX: number; maxY: number } {
    let bounds = edgePathBoundsCache.get(edge);
    if (!bounds) {
        bounds = getPathBounds(edge.path, edge.start);
        edgePathBoundsCache.set(edge, bounds);
    }
    return bounds;
}

/** Without it, a resumed game fills the cache in a long task on its first winning drop or marquee (#716). */
export function warmEdgePathBounds(piece: Readonly<Piece>): void {
    for (const edge of piece.edges) {
        if (edge.path) cachedEdgePathBounds(edge);
    }
}

export interface BoundingRect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface GroupBoundsOptions {
    /**
     * - `'local'`: un-rotated piece-offset frame; ignores `group.rotation`
     *   and `group.position`.
     * - `'world'`: applies `group.rotation` and `group.position` to every
     *   sampled point before computing the AABB.
     */
    space: 'local' | 'world';

    /**
     * If true, samples bezier control points from each edge's `path` (tighter
     * fit including tab geometry); if false, only `start`/`end` corners.
     */
    includePathGeometry: boolean;
}

/**
 * Single source of truth for group bounds; callers pick space/path-geometry via
 * `options`. Returns Infinity-valued bounds when the group has no findable
 * pieces — the sugar wrappers normalize that to zero-sized.
 */
export function getGroupBounds(
    group: PieceGroup,
    piecesById: ReadonlyMap<number, Readonly<Piece>>,
    options: GroupBoundsOptions,
): BoundingRect {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const expand = (localX: number, localY: number) => {
        const projected = options.space === 'world'
            ? localToWorld({ x: localX, y: localY }, group)
            : { x: localX, y: localY };
        if (projected.x < minX) minX = projected.x;
        if (projected.y < minY) minY = projected.y;
        if (projected.x > maxX) maxX = projected.x;
        if (projected.y > maxY) maxY = projected.y;
    };

    for (const [pieceId, offset] of group.pieces) {
        const piece = piecesById.get(pieceId);
        if (!piece) continue;

        for (const edge of piece.edges) {
            expand(offset.x + edge.start.x, offset.y + edge.start.y);
            expand(offset.x + edge.end.x, offset.y + edge.end.y);

            if (options.includePathGeometry && edge.path) {
                const pb = cachedEdgePathBounds(edge);
                expand(offset.x + pb.minX, offset.y + pb.minY);
                expand(offset.x + pb.maxX, offset.y + pb.maxY);
            }
        }
    }

    return { minX, minY, maxX, maxY };
}

/**
 * Piece offsets only (group-local, no edge geometry). For world-space bounds
 * including tab shapes use `getGroupBounds` with `space: 'world'` +
 * `includePathGeometry: true`.
 */
export function getGroupOffsetBounds(group: PieceGroup): BoundingRect {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const offset of group.pieces.values()) {
        if (offset.x < minX) {
            minX = offset.x;
        }

        if (offset.y < minY) {
            minY = offset.y;
        }

        if (offset.x > maxX) {
            maxX = offset.x;
        }

        if (offset.y > maxY) {
            maxY = offset.y;
        }
    }

    return { minX, minY, maxX, maxY };
}

/**
 * Group bounding box in un-rotated local space, including bezier control points
 * for tab geometry beyond the corners. Use this (not `getGroupVisualBounds`)
 * for rotation pivot math or anywhere you need rotation-invariant bounds.
 */
export function getGroupLocalBounds(
    group: PieceGroup,
    piecesById: ReadonlyMap<number, Readonly<Piece>>,
): { minX: number; minY: number; width: number; height: number } {
    const b = getGroupBounds(group, piecesById, {
        space: 'local',
        includePathGeometry: true,
    });

    if (!isFinite(b.minX)) {
        return { minX: 0, minY: 0, width: 0, height: 0 };
    }

    return {
        minX: b.minX,
        minY: b.minY,
        width: b.maxX - b.minX,
        height: b.maxY - b.minY,
    };
}

/**
 * Center of the assembled image rectangle in un-rotated local space. Samples
 * piece-body corners only (no tabs), so for a completed puzzle (flat border)
 * this is the image's geometric center — use it as the pivot when spinning the
 * finished puzzle upright, so the spin isn't offset by asymmetric tabs.
 * Returns the local origin for a group with no findable pieces.
 */
export function getGroupImageCenter(
    group: PieceGroup,
    piecesById: ReadonlyMap<number, Readonly<Piece>>,
): Point {
    const b = getGroupBounds(group, piecesById, {
        space: 'local',
        includePathGeometry: false,
    });

    if (!isFinite(b.minX)) {
        return { x: 0, y: 0 };
    }

    return {
        x: (b.minX + b.maxX) / 2,
        y: (b.minY + b.maxY) / 2,
    };
}

/**
 * Center of one piece's tab-inclusive footprint in the group's un-rotated local
 * space — the rotation-snap pivot shared by merge measurement, merge
 * application, and the snap assists; they must agree or the measured snapDelta
 * lands the group elsewhere.
 *
 * Sampled from edge path geometry, not `piece.bounds`: legacy-Classic edges
 * carry no `curvePoints`, so their `bounds` exclude tabs and the centers
 * diverge. Throws if the piece is not in the group.
 */
export function pieceCenterLocal(group: PieceGroup, piece: Piece): Point {
    const offset = group.pieces.get(piece.id);
    if (!offset) throw new Error(`Piece ${piece.id} not in group ${group.id}`);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const expand = (x: number, y: number) => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };
    for (const edge of piece.edges) {
        expand(edge.start.x, edge.start.y);
        expand(edge.end.x, edge.end.y);
        if (edge.path) {
            const pb = cachedEdgePathBounds(edge);
            expand(pb.minX, pb.minY);
            expand(pb.maxX, pb.maxY);
        }
    }

    if (!isFinite(minX)) {
        return { x: offset.x, y: offset.y };
    }

    return {
        x: offset.x + (minX + maxX) / 2,
        y: offset.y + (minY + maxY) / 2,
    };
}

/**
 * Group bounding box as rendered (accounts for `group.rotation`). Coordinates
 * are offsets from `group.position`, so `group.position.x + bounds.minX` is the
 * world-space left edge. Use for layout/gather packing; for rotation pivot math
 * use `getGroupLocalBounds`.
 */
export function getGroupVisualBounds(
    group: PieceGroup,
    piecesById: ReadonlyMap<number, Readonly<Piece>>,
): { minX: number; minY: number; width: number; height: number } {
    const b = getGroupBounds(group, piecesById, {
        space: 'world',
        includePathGeometry: true,
    });

    if (!isFinite(b.minX)) {
        return { minX: 0, minY: 0, width: 0, height: 0 };
    }

    return {
        minX: b.minX - group.position.x,
        minY: b.minY - group.position.y,
        width: b.maxX - b.minX,
        height: b.maxY - b.minY,
    };
}
