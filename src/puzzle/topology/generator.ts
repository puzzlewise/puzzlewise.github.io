/**
 * Base-cut and tab generators are looked up from the registry by id, so
 * one code path serves the sine grid, Venn, and future plug-ins. See
 * issue #166 for the architecture.
 */

import type { GeneratedPiece, Point, Size } from '../../model/types.js';
import { buildDCEL, getFaceEdges } from './dcel.js';
import type { Face, HalfEdge } from './dcel.js';
import { walkLoop } from './half-edge-loop.js';
import { facesToPieceDefinitions } from './faces-to-pieces.js';
import type { EdgeDefinition } from '../composable/types.js';
import { composePuzzle } from '../composable/compose.js';
import { applyTabs } from './apply-tabs.js';
import type { TabDebugSession, TabDebugReport } from './tab-debug.js';
import { autoGroupSmallPieces } from './auto-group.js';
import type { AutoGroup } from './auto-group.js';
import { getBaseCutGenerator, getTabGenerator } from './generator-registry.js';
import { stripBorderRing } from './strip-border-ring.js';
import { clampGridDim } from './grid-dim.js';
import { diagnostics } from '../../diagnostics.js';

/**
 * Generators are referenced by id; their parameters are opaque records
 * each generator validates internally. `tabGeneratorId: 'none'` skips tabs.
 */
export interface TopologyGeneratorConfig {
    /** Base-cut generator id (default: 'sine'). */
    baseCutGeneratorId?: string;
    /** Opaque config forwarded to the base-cut generator. */
    baseCutConfig?: Record<string, unknown>;
    /** Tab generator id (default: 'classic'; pass 'none' to skip). */
    tabGeneratorId?: string;
    /** Opaque config forwarded to the tab generator. */
    tabConfig?: Record<string, unknown>;
    /**
     * Minimum area (px²) below which a piece is auto-grouped with its
     * largest neighbour by {@link autoGroupSmallPieces} (a post-pass);
     * groups surface via {@link TopologyPuzzle.autoGroups} to glue tiny
     * noise slivers into neighbours. Omit (`undefined`) to skip — then
     * `autoGroups` is empty and every piece stands alone.
     */
    minPieceArea?: number;
    /**
     * Borderless mode. When true AND the base cut advertises
     * `supportsBorderless`, its grid is oversized and the outer ring is
     * stripped (see strip-border-ring.ts); otherwise ignored.
     */
    borderless?: boolean;
    /**
     * Optional dev-time debug session capturing every tab candidate (plus
     * traced-tab template/transform params); report via
     * {@link TopologyPuzzle.tabDebugReport}. Production omits it.
     */
    tabDebug?: TabDebugSession;
}

/**
 * A generated puzzle whose face count didn't match its base-cut generator's
 * {@link BaseCutGenerator.expectedPieceCount}. Both counts are
 * pre-composition and pre-border-strip, so directly comparable (for
 * borderless they describe the oversized grid). A diagnostic, not an error —
 * the puzzle still plays; the count is reported so a fused-piece bug isn't
 * invisible (#512).
 */
export interface PieceCountMismatch {
    /** Faces the base-cut generator intended to produce. */
    expected: number;
    /** Faces the DCEL actually yielded. */
    actual: number;
    /** Which base-cut generator declared the expectation. */
    baseCutId: string;
}

/**
 * Populated when the caller supplied
 * {@link TopologyGeneratorConfig.minPieceArea}; empty otherwise (every
 * piece is its own group). Glues tiny noise slivers into starting groups.
 */
export interface TopologyPuzzle {
    pieces: GeneratedPiece[];
    autoGroups: AutoGroup[];
    /**
     * Populated only when {@link TopologyGeneratorConfig.tabDebug} was
     * passed. Each entry records half-edge id, edge position, mate piece,
     * acceptance, and (traced tabs) the template used.
     */
    tabDebugReport?: TabDebugReport;
    /**
     * Set only when the base cut declared an expected face count and the
     * pipeline produced a different one; absent otherwise (including when
     * the generator has no `expectedPieceCount`).
     */
    pieceCountMismatch?: PieceCountMismatch;
}

export function generateTopologyPuzzle(
    cols: number,
    rows: number,
    imageSize: Size,
    random: () => number,
    config?: TopologyGeneratorConfig,
): TopologyPuzzle {
    const baseCutId = config?.baseCutGeneratorId ?? 'sine';
    const tabId = config?.tabGeneratorId ?? 'classic';

    // The sine grid needs cols/rows; generators that ignore them aren't harmed.
    const baseCutGenerator = getBaseCutGenerator(baseCutId);
    // Borderless only applies when the generator advertises support (it must
    // oversize its grid); otherwise ignored.
    const applyBorderless =
        config?.borderless === true && baseCutGenerator.supportsBorderless === true;
    // Apply grid dims AFTER spreading the opaque baseCutConfig so a crafted
    // `cf.bgc.rows`/`cols` can't override them, and clamp against out-of-range
    // grids (see clampGridDim in grid-dim.ts). A no-op for legitimate puzzles.
    const baseCutCfg = {
        ...config?.baseCutConfig,
        cols: clampGridDim(cols),
        rows: clampGridDim(rows),
        borderless: applyBorderless,
    };
    const curves = baseCutGenerator.generate(imageSize, random, baseCutCfg);

    diagnostics.log('cuts', `Generated ${curves.length} curves (4 border + ${curves.length - 4} internal)`, {
        curveSegments: curves.map((c, i) => ({
            index: i,
            segments: c.segments.length,
            start: c.start,
            end: c.end,
        })),
    });

    const graph = buildDCEL({ curves });

    // The `none` generator returns null on every edge, so no special-casing here.
    const tabGenerator = getTabGenerator(tabId);
    // Triangular pieces have little interior room, so the traced resolver's
    // shallow ladder leaves edges flat; opt them into the deep ladder. Other
    // cuts keep today's ladder (and its exact share-link output). Derived from
    // baseCutId here so no config site can forget to set it.
    const tabConfig =
        baseCutId === 'triangular'
            ? { ...config?.tabConfig, deepResolve: true }
            : config?.tabConfig;
    applyTabs(graph, tabGenerator, random, {
        tabConfig,
        onCandidate: config?.tabDebug?.onCandidate,
    });

    // Tiny faces aren't merged here — the auto-group pass below glues them
    // into starting groups instead of mutating the DCEL.
    const computeArea = (face: { outerEdge: HalfEdge }) => {
        let area = 0;
        for (const current of walkLoop(face.outerEdge)) {
            const a = current.origin.position;
            const b = current.twin.origin.position;
            area += (a.x * b.y - b.x * a.y);
        }
        return area / 2;
    };
    logFaceDetails('dcel-faces', graph.faces, computeArea as (face: Face) => number);

    const pieceDefs = facesToPieceDefinitions(graph);

    diagnostics.log('pieces', `Generated ${pieceDefs.length} piece definitions`);

    // Piece-count invariant (#512). Placed before composePuzzle and
    // stripBorderRing so `expected` and `actual` share a coordinate system
    // (no strip arithmetic). Warn, never throw — a wrong count is a bad
    // puzzle, not an unusable one.
    let pieceCountMismatch: PieceCountMismatch | undefined;
    const expectedPieces = baseCutGenerator.expectedPieceCount?.(baseCutCfg);
    if (expectedPieces !== undefined && expectedPieces !== pieceDefs.length) {
        pieceCountMismatch = {
            expected: expectedPieces,
            actual: pieceDefs.length,
            baseCutId,
        };
        // The printed grid is the REQUESTED (clamped) one; `expected` counts
        // the generator's own grid, oversized for borderless. So a borderless
        // 16x12 expects 18x14=252, and the message annotates that rather than
        // reading as nonsense. The framework doesn't recompute the oversizing —
        // that rule belongs to the generator (`expectedPieceCount`).
        const grid = baseCutCfg.borderless
            ? `${baseCutCfg.cols}x${baseCutCfg.rows}, borderless — expected counts`
                + " the generator's oversized grid, pre-strip"
            : `${baseCutCfg.cols}x${baseCutCfg.rows}`;
        diagnostics.warn(
            `[piece-count] ${baseCutId}: expected ${expectedPieces} pieces, `
            + `got ${pieceDefs.length} (requested grid ${grid})`,
        );
    }

    // Area/adjacency come from the piece definitions (not DCEL faces) so
    // auto-group uses the same identifiers callers see. Adjacency follows
    // mate relationships across all loops — inner-boundary edges count as
    // neighbours, so a tiny piece inside a hole glues to the frame.
    const minPieceArea = config?.minPieceArea;
    let autoGroups: AutoGroup[] = [];
    if (minPieceArea !== undefined) {
        const areas = new Map<number, number>();
        const neighbours = new Map<number, Set<number>>();
        for (const def of pieceDefs) {
            areas.set(def.id, computeOuterLoopArea(def.edges));
            const ns = new Set<number>();
            for (const e of def.edges) {
                if (e.matePieceId >= 0) ns.add(e.matePieceId);
            }
            neighbours.set(def.id, ns);
        }
        autoGroups = autoGroupSmallPieces(
            {
                pieceIds: pieceDefs.map(d => d.id),
                areas,
                neighbours,
            },
            minPieceArea,
        );
    }

    // Tabs are already baked into the edge geometry by `applyTabs`, so
    // disable the composition layer's own tab logic.
    const composed = composePuzzle(pieceDefs, null, random, { disableTabs: true });

    // Strip the outer ring AFTER composition. composePuzzle draws no
    // randomness here (disableTabs: true), so stripping can't perturb the
    // seeded stream.
    const { pieces, autoGroups: finalAutoGroups } = applyBorderless
        ? stripBorderRing(composed, autoGroups)
        : { pieces: composed, autoGroups };

    if (applyBorderless) {
        diagnostics.log(
            'borderless-strip',
            `Stripped outer ring: ${composed.length - pieces.length} removed, ${pieces.length} survivors`,
            { before: composed.length, removed: composed.length - pieces.length, after: pieces.length },
        );
    }

    const tabDebugReport = config?.tabDebug?.finish(graph);

    return { pieces, autoGroups: finalAutoGroups, tabDebugReport, pieceCountMismatch };
}

/**
 * Area of the outer loop (the prefix of `edges` before the first chain
 * break, where the previous `end` no longer matches the current `start`).
 *
 * Curve-bounded faces (Venn crescents) have arc boundaries whose endpoints
 * are circle intersections; shoelace on endpoints alone collapses them to
 * ~0 area, tripping the auto-group threshold. So we feed each edge's
 * `curvePoints` polyline when present; straight edges contribute just their
 * endpoint.
 */
function computeOuterLoopArea(edges: EdgeDefinition[]): number {
    if (edges.length === 0) return 0;
    const polyline: Point[] = [];
    for (let i = 0; i < edges.length; i++) {
        const cur = edges[i];
        if (i > 0) {
            const prev = edges[i - 1];
            // Chain break = end of outer loop. Inner-boundary loops are holes;
            // their area would only confuse the "is this piece tiny" threshold.
            if (Math.abs(prev.end.x - cur.start.x) > 0.5
                || Math.abs(prev.end.y - cur.start.y) > 0.5) {
                break;
            }
        }
        if (cur.curvePoints && cur.curvePoints.length >= 2) {
            // curvePoints[0] === cur.start; skip the first to avoid
            // duplicating the previous edge's endpoint.
            const startIdx = polyline.length === 0 ? 0 : 1;
            for (let j = startIdx; j < cur.curvePoints.length; j++) {
                polyline.push(cur.curvePoints[j]);
            }
        } else {
            if (polyline.length === 0) polyline.push(cur.start);
            polyline.push(cur.end);
        }
    }
    if (polyline.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < polyline.length; i++) {
        const a = polyline[i];
        const b = polyline[(i + 1) % polyline.length];
        area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) / 2;
}

function logFaceDetails(
    stage: string,
    faces: Face[],
    computeArea: (face: Face) => number,
): void {
    if (!diagnostics.enabled) return;
    const innerFaces = faces.filter(f => !f.isOuter);
    diagnostics.log(stage, `Total faces: ${faces.length}, inner: ${innerFaces.length}`);

    for (const face of innerFaces) {
        const edges = getFaceEdges(face);
        const area = computeArea(face);
        const verts = edges.map(e => e.origin.position);
        const bbox = computeBBox(verts);
        diagnostics.log(stage, `Face ${face.id}: edges=${edges.length}, area=${area.toFixed(1)}, bbox=${bboxStr(bbox)}`);
    }
}

function computeBBox(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

function bboxStr(b: { minX: number; minY: number; maxX: number; maxY: number }): string {
    return `[${b.minX.toFixed(0)},${b.minY.toFixed(0)}]→[${b.maxX.toFixed(0)},${b.maxY.toFixed(0)}]`;
}
