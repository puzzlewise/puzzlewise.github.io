/** See issue #171 for design discussion. */

import type { Point } from '../../model/types.js';
import type { PieceDefinition, EdgeDefinition } from '../composable/types.js';
import type { HalfEdge, TopologyGraph } from './dcel.js';
import { getFaceEdges } from './dcel.js';

export function facesToPieceDefinitions(
    dcel: TopologyGraph,
): PieceDefinition[] {
    const innerFaces = dcel.faces.filter(f => !f.isOuter);

    const faceIdToPieceId = new Map<number, number>();
    innerFaces.forEach((face, index) => {
        faceIdToPieceId.set(face.id, index);
    });

    let nextEdgeId = 0;
    const halfEdgeToEdgeId = new Map<number, number>();
    for (const face of innerFaces) {
        const edges = getFaceEdges(face);
        for (const he of edges) {
            if (!halfEdgeToEdgeId.has(he.id)) {
                halfEdgeToEdgeId.set(he.id, nextEdgeId++);
            }
            if (!halfEdgeToEdgeId.has(he.twin.id)) {
                halfEdgeToEdgeId.set(he.twin.id, nextEdgeId++);
            }
        }
        // Assign edge IDs for inner-boundary loops too, or the
        // halfEdgeToEdgeDef call below throws on them.
        for (const innerStart of face.innerBoundaries) {
            const innerEdges = walkLoop(innerStart);
            for (const he of innerEdges) {
                if (!halfEdgeToEdgeId.has(he.id)) {
                    halfEdgeToEdgeId.set(he.id, nextEdgeId++);
                }
                if (!halfEdgeToEdgeId.has(he.twin.id)) {
                    halfEdgeToEdgeId.set(he.twin.id, nextEdgeId++);
                }
            }
        }
    }

    return innerFaces.map(face => {
        const pieceId = faceIdToPieceId.get(face.id)!;
        const outerHE = getFaceEdges(face);

        // Outer boundary only — inner edges are inside it, so they don't
        // extend the bbox.
        const bbox = computeFaceBBox(outerHE);

        // Loop boundaries are implicit in the flat edge list — the renderer
        // detects them where consecutive edges' end/start don't match. All
        // loops share the same piece-local frame (bbox).
        const allHE: HalfEdge[] = [...outerHE];
        for (const innerStart of face.innerBoundaries) {
            allHE.push(...walkLoop(innerStart));
        }

        const edges: EdgeDefinition[] = allHE.map(he =>
            halfEdgeToEdgeDef(he, bbox, faceIdToPieceId, halfEdgeToEdgeId),
        );

        return {
            id: pieceId,
            edges,
            imageOffset: { x: -bbox.minX, y: -bbox.minY },
        };
    });
}

function walkLoop(start: HalfEdge): HalfEdge[] {
    const loop: HalfEdge[] = [];
    let current = start;
    do {
        loop.push(current);
        current = current.next;
    } while (current !== start);
    return loop;
}

interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function computeFaceBBox(halfEdges: HalfEdge[]): BBox {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const he of halfEdges) {
        // Sampled, so curved edges get an accurate bbox.
        const pts = he.curve.sample(8);
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }

    return { minX, minY, maxX, maxY };
}

function halfEdgeToEdgeDef(
    he: HalfEdge,
    bbox: BBox,
    faceIdToPieceId: Map<number, number>,
    halfEdgeToEdgeId: Map<number, number>,
): EdgeDefinition {
    const origin = he.origin.position;
    const target = he.twin.origin.position;

    // Convert to piece-local coordinates (relative to bbox top-left)
    const start: Point = {
        x: origin.x - bbox.minX,
        y: origin.y - bbox.minY,
    };
    const end: Point = {
        x: target.x - bbox.minX,
        y: target.y - bbox.minY,
    };

    const edgeId = halfEdgeToEdgeId.get(he.id)!;
    const twinFace = he.twin.face;
    const isBorder = !twinFace || twinFace.isOuter;

    if (isBorder) {
        return {
            id: edgeId,
            start,
            end,
            mateEdgeId: -1,
            matePieceId: -1,
            curvePoints: extractCurvePoints(he, bbox),
        };
    }

    const matePieceId = faceIdToPieceId.get(twinFace.id) ?? -1;
    const mateEdgeId = halfEdgeToEdgeId.get(he.twin.id) ?? -1;

    const minHalfEdgeId = Math.min(he.id, he.twin.id);
    const maxHalfEdgeId = Math.max(he.id, he.twin.id);
    const sharedEdgeKey = `he_${minHalfEdgeId}_${maxHalfEdgeId}`;
    const isFirstSide = he.id === minHalfEdgeId;

    return {
        id: edgeId,
        start,
        end,
        mateEdgeId,
        matePieceId,
        sharedEdgeKey,
        isFirstSide,
        curvePoints: extractCurvePoints(he, bbox),
    };
}

/** Piece-local coordinates; undefined for straight edges (saves space). */
function extractCurvePoints(he: HalfEdge, bbox: BBox): Point[] | undefined {
    const pts = he.curve.sample(8);
    if (isEssentiallyStraight(pts)) {
        return undefined;
    }

    // Vertex merging (VERTEX_MERGE_TOLERANCE) leaves the curve's own ends up to
    // ~1 px off the shared vertex, so the vertices are authoritative.
    const local = pts.map(p => ({
        x: p.x - bbox.minX,
        y: p.y - bbox.minY,
    }));
    local[0] = {
        x: he.origin.position.x - bbox.minX,
        y: he.origin.position.y - bbox.minY,
    };
    local[local.length - 1] = {
        x: he.twin.origin.position.x - bbox.minX,
        y: he.twin.origin.position.y - bbox.minY,
    };
    return local;
}

function isEssentiallyStraight(pts: Point[], tolerance = 0.5): boolean {
    if (pts.length <= 2) return true;

    const start = pts[0];
    const end = pts[pts.length - 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < 1e-6) return true;

    const nx = -dy / len;
    const ny = dx / len;

    for (let i = 1; i < pts.length - 1; i++) {
        const px = pts[i].x - start.x;
        const py = pts[i].y - start.y;
        const deviation = Math.abs(px * nx + py * ny);
        if (deviation > tolerance) return false;
    }

    return true;
}
