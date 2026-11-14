import type { RendererAppearance } from '../appearance.js';
import type { GeometryStore } from './geometry-store.js';
import { KIND_DEBUG_STROKE, KIND_MATELESS } from './shaders.js';

export interface DrawPasses {
    strokesUnder: boolean;
    fringe: boolean;
    strokesOver: boolean;
    debugStrokes: boolean;
    mateless: boolean;
}

export interface DrawOrder {
    orderedGroupIds(): readonly number[];
    groupLayout(groupId: number): readonly { id: number }[];
    isOuterEdge(edgeId: number): boolean;
}

/** World units the outline stroke reaches past the piece edge. */
export const OUTLINE_HALF_WIDTH = 1.5;

/** The fringe is the only edge antialiasing without an outline; strokes and fringe share the stroke vertices. */
export function drawPasses(
    appearance: Pick<RendererAppearance, 'outline' | 'innerOutline'>
        & Partial<Pick<RendererAppearance, 'debugPieces' | 'matelessEdges'>>,
    strokesReady: boolean,
): DrawPasses {
    const outline = strokesReady && appearance.outline === 'outline';
    return {
        strokesUnder: outline && !appearance.innerOutline,
        fringe: strokesReady,
        strokesOver: outline && appearance.innerOutline,
        debugStrokes: strokesReady && (appearance.debugPieces ?? false),
        mateless: strokesReady && (appearance.matelessEdges ?? false),
    };
}

/** Returns whether vertices were added. */
export function addDebugStrokes(store: GeometryStore, passes: DrawPasses): boolean {
    const mateless = passes.mateless && store.addStrokeCopies(KIND_MATELESS);
    const debug = passes.debugStrokes && store.addStrokeCopies(KIND_DEBUG_STROKE);
    return mateless || debug;
}

function outerEdgesOf(order: DrawOrder, store: GeometryStore, groupId: number, out: number[]): number[] {
    out.length = 0;
    for (const { id } of order.groupLayout(groupId)) {
        for (const edgeId of store.edgesOf(id)) {
            if (order.isOuterEdge(edgeId)) out.push(edgeId);
        }
    }
    return out;
}

function concatenate(parts: readonly Uint32Array[], scratch?: Uint32Array): Uint32Array {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = scratch && scratch.length >= length ? scratch.subarray(0, length) : new Uint32Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** What a group's drop-shadows are cast from: its fills, plus the outline stroke or else the AA fringe. */
export function silhouetteIndices(order: DrawOrder, store: GeometryStore, groupId: number, stroke: boolean): Uint32Array {
    const parts: Uint32Array[] = [];
    for (const { id } of order.groupLayout(groupId)) {
        const fill = store.fillIndices(id);
        if (fill) parts.push(fill);
    }
    for (const edgeId of outerEdgesOf(order, store, groupId, [])) {
        if (stroke) {
            const strokeParts = store.strokeParts(edgeId);
            if (strokeParts) parts.push(strokeParts.band, strokeParts.startCap, strokeParts.endCap);
        } else {
            const fringe = store.fringeIndices(edgeId);
            if (fringe) parts.push(fringe);
        }
    }
    return concatenate(parts);
}

/** Returns a view of `scratch` when it is large enough. `halos` lists index runs drawn under each group. */
export function assembleIndices(
    order: DrawOrder,
    store: GeometryStore,
    passes: DrawPasses,
    scratch?: Uint32Array,
    halos?: (groupId: number) => readonly Uint32Array[],
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
    const pushMateless = (): void => {
        for (const edgeId of outerEdges) {
            const copy = store.strokeCopy(KIND_MATELESS, edgeId);
            if (copy) result.push(copy);
        }
    };
    const needsEdges = passes.strokesUnder || passes.fringe || passes.strokesOver || passes.mateless;
    // SVG draws each piece's white debug fill over its mateless stroke, hiding the inner half.
    const matelessUnderFills = passes.mateless && passes.debugStrokes;

    for (const groupId of order.orderedGroupIds()) {
        const layout = order.groupLayout(groupId);
        if (halos) result.push(...halos(groupId));
        if (needsEdges) outerEdgesOf(order, store, groupId, outerEdges);
        else outerEdges.length = 0;
        if (passes.strokesUnder) {
            for (const edgeId of outerEdges) pushStroke(edgeId);
        }
        if (matelessUnderFills) pushMateless();
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
        if (passes.mateless && !matelessUnderFills) pushMateless();
        if (passes.debugStrokes) {
            for (const { id } of layout) {
                for (const edgeId of store.edgesOf(id)) {
                    const copy = store.strokeCopy(KIND_DEBUG_STROKE, edgeId);
                    if (copy) result.push(copy);
                }
            }
        }
        if (passes.strokesOver) {
            for (const edgeId of outerEdges) pushInnerStroke(edgeId);
        }
    }

    return concatenate(result, scratch);
}
