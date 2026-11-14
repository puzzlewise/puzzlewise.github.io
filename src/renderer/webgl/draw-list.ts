import type { RendererAppearance } from '../appearance.js';
import type { GeometryStore } from './geometry-store.js';

export interface DrawPasses {
    strokesUnder: boolean;
    fringe: boolean;
    strokesOver: boolean;
}

export interface DrawOrder {
    orderedGroupIds(): readonly number[];
    groupLayout(groupId: number): readonly { id: number }[];
    isOuterEdge(edgeId: number): boolean;
}

/** The fringe is the only edge antialiasing without an outline; strokes and fringe share the stroke vertices. */
export function drawPasses(appearance: RendererAppearance, strokesReady: boolean): DrawPasses {
    const outline = strokesReady && appearance.outline === 'outline';
    return {
        strokesUnder: outline && !appearance.innerOutline,
        fringe: strokesReady,
        strokesOver: outline && appearance.innerOutline,
    };
}

/** Returns a view of `scratch` when it is large enough. */
export function assembleIndices(
    order: DrawOrder,
    store: GeometryStore,
    passes: DrawPasses,
    scratch?: Uint32Array,
): Uint32Array {
    const result: Uint32Array[] = [];
    const outerEdges: number[] = [];
    const pushStroke = (edgeId: number): void => {
        const parts = store.strokeParts(edgeId);
        if (parts) result.push(parts.band, parts.startCap, parts.endCap);
    };
    // Inner-outline strokes keep only their interior half, but a cap's interior
    // half still reaches past a convex corner, outside the piece. Where the
    // neighboring edge is outer too, its band already covers the corner.
    const pushInnerStroke = (edgeId: number): void => {
        const parts = store.strokeParts(edgeId);
        if (!parts) return;
        const corners = store.cornersOf(edgeId);
        const keepCap = (convex = false, neighbor = -1): boolean => !convex || !order.isOuterEdge(neighbor);
        result.push(parts.band);
        if (keepCap(corners?.startConvex, corners?.prev)) result.push(parts.startCap);
        if (keepCap(corners?.endConvex, corners?.next)) result.push(parts.endCap);
    };
    const needsEdges = passes.strokesUnder || passes.fringe || passes.strokesOver;

    for (const groupId of order.orderedGroupIds()) {
        const layout = order.groupLayout(groupId);
        outerEdges.length = 0;
        if (needsEdges) {
            for (const { id } of layout) {
                for (const edgeId of store.edgesOf(id)) {
                    if (order.isOuterEdge(edgeId)) outerEdges.push(edgeId);
                }
            }
        }
        if (passes.strokesUnder) {
            for (const edgeId of outerEdges) pushStroke(edgeId);
        }
        for (const { id } of layout) {
            const fill = store.fillIndices(id);
            if (fill) result.push(fill);
        }
        if (passes.fringe) {
            for (const edgeId of outerEdges) {
                const fringe = store.fringeIndices(edgeId);
                if (fringe) result.push(fringe);
            }
        }
        if (passes.strokesOver) {
            for (const edgeId of outerEdges) pushInnerStroke(edgeId);
        }
    }

    let length = 0;
    for (const part of result) length += part.length;
    const out = scratch && scratch.length >= length ? scratch.subarray(0, length) : new Uint32Array(length);
    let offset = 0;
    for (const part of result) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
