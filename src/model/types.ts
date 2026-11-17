/**
 * Graph-based, shape-agnostic model types — no grid assumptions. Generators
 * produce pieces conforming to these.
 */

export interface Point {
    x: number;
    y: number;
}

export interface Size {
    width: number;
    height: number;
}

/** Connectivity via mate relationships; border edges use -1 for both mate fields. */
export interface Edge {
    /** Globally unique across all pieces. */
    id: number;
    /** The matching edge on the adjacent piece (-1 for border edges). */
    mateEdgeId: number;
    /** Which piece the mate edge belongs to (-1 for border edges). */
    matePieceId: number;
    /** SVG path segment for this edge (relative to piece-local coords). */
    path: string;
    /** Where this edge starts on the piece (piece-local coords). */
    start: Point;
    /** Where this edge ends on the piece (piece-local coords). */
    end: Point;
}

/**
 * Piece-local axis-aligned bounding box, frozen at sealing
 * (`model/seal-geometry.ts`) from endpoints and curve samples that aren't
 * retained afterward. On load it returns verbatim from a v12+ blob; recomputed
 * only when migrating an older save whose edges still carry the samples.
 */
export interface PieceBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * A generator edge, before sealing: may carry the cut curve's dense samples
 * (present for curved edges, absent for straight; tab protrusions live only in
 * `path`). `sealPieceGeometry` folds them into `bounds` and drops them — sealed
 * edges never have them; only v≤11 saves still persist them.
 */
export interface GeneratedEdge extends Edge {
    curvePoints?: Point[];
}

/**
 * A piece before sealing: edges may carry `curvePoints`, no `bounds` yet.
 * `sealPieceGeometry` turns this into a `Piece`.
 */
export interface GeneratedPiece {
    id: number;
    edges: GeneratedEdge[];
    shape: string;
    imageOffset: Point;
}

/**
 * Knows its shape and connectivity, but nothing about
 * where it is on the table — that's the group's job.
 */
export interface Piece {
    id: number;
    /**
     * Flat list of edges forming one or more loops chained end-to-start; a loop
     * boundary is where the chain breaks (an edge's `start` no longer matches
     * the previous `end`). Holes add loops after the outer boundary.
     */
    edges: Edge[];
    /** Full SVG clip-path `d` attribute built from all edges. */
    shape: string;
    /** Offset to position the source image behind the clip-path (piece-local coords). */
    imageOffset: Point;
    /** Piece-local bbox. Stored, not derived: the curve samples it came from are dropped after generation. */
    bounds: PieceBounds;
}

/**
 * Every piece is always in exactly one group.
 * A solo (unmerged) piece is a single-piece group.
 */
export interface PieceGroup {
    id: number;
    /** pieceId → offset of that piece within the group's local space. */
    pieces: Map<number, Point>;
    /** The group's position in world (table) coordinates. */
    position: Point;
    /**
     * Rotation in float degrees, normalized to `[0, 360)`. Quarter-turn mode
     * stores `{0, 90, 180, 270}`; free mode any float. Piece offsets and edge
     * endpoints stay in un-rotated local coords; the rotation is applied at
     * render time and in world-position lookups. `rotationMode === 'none'`
     * puzzles always have 0.
     */
    rotation: number;
}

export interface ImageAttribution {
    photographerName: string;
    photographerUrl: string;
    /** Link to the original photo page. */
    photoUrl: string;
}

export interface GridSize {
    cols: number;
    rows: number;
}

/** Lives here, not `app/orientation.ts`, so `images` can use it without an images→app cycle. */
export type Orientation = 'landscape' | 'portrait';

/**
 * The `*ById` and `pieceToGroup` Maps are derived indexes for O(1) lookup on
 * hot paths; they are NOT serialized (`deserializeState` rebuilds them).
 * Mutate `groups` only via the helpers in `model/helpers.ts` so they stay
 * consistent.
 */
export interface GameState {
    /** All pieces in the puzzle (immutable after generation). */
    pieces: Piece[];
    /** Current groups (mutates as pieces merge). */
    groups: PieceGroup[];
    /** pieceId → Piece. Built once at construction; never mutates. */
    piecesById: Map<number, Piece>;
    /** groupId → PieceGroup. Kept in sync with `groups`. */
    groupsById: Map<number, PieceGroup>;
    /** pieceId → the group containing that piece. Kept in sync with `groups`. */
    pieceToGroup: Map<number, PieceGroup>;
    /** Puzzle image URL, or `null` for a blank puzzle (pieces painted flat white). */
    imageUrl: string | null;
    /** Pixel dimensions of the puzzle image. */
    imageSize: Size;
    gridSize: GridSize;
    /** True when all pieces have been merged into a single group. */
    completed: boolean;
    attribution?: ImageAttribution;
    /** PRNG seed used for procedural cut generation. Reproduces the same cuts. */
    seed?: number;
    cutStyle?: string;
    /**
     * How groups can be rotated: `'none'` disables it (all groups at 0);
     * `'quarter-turn'` snaps to 90° via toolbar; `'free'` is continuous via a
     * drag handle, with merge alignment tolerating ±10° misalignment.
     */
    rotationMode?: 'none' | 'quarter-turn' | 'free';
    /**
     * Composable-cut config (set only when `cutStyle === 'composable'`). Needed
     * to reproduce the puzzle from its seed; inlined (mirrors `ComposableConfig`)
     * to keep this module free of puzzle-layer imports.
     */
    composableConfig?: {
        baseCutGenerator?: string;
        baseCutConfig?: Record<string, unknown>;
        tabGenerator?: string;
        tabConfig?: Record<string, unknown>;
        minPieceArea?: number;
        /** Borderless mode (strip the outer ring of pieces). */
        borderless?: boolean;
    };
    /** Fractal-cut config (set only when `cutStyle === 'fractal'`); needed to reproduce from seed. */
    fractalConfig?: {
        borderless?: boolean;
    };
    /** Wavy-cut config (set only when `cutStyle === 'wavy'`); needed to reproduce from seed. */
    wavyConfig?: {
        borderless?: boolean;
        /**
         * Trace-set version for hand-traced tabs. Present on new Wavy games;
         * absent on legacy Wavy puzzles, which reproduce with classic tabs. See
         * project_share_link_prng_contract.
         */
        traceSetVersion?: number;
    };
    /**
     * Triangles-cut config (set only when `cutStyle === 'triangles'`); needed to
     * reproduce from seed. Only the trace-set version varies (other params fixed
     * by the preset).
     */
    trianglesConfig?: {
        /**
         * Trace-set version for hand-traced tabs; pins the tab-library snapshot
         * so future releases don't change existing puzzles. See
         * project_share_link_prng_contract.
         */
        traceSetVersion?: number;
    };
    /**
     * Classic-cut config (set only for a Classic puzzle from the sine-based
     * generator). Its presence is the generator discriminator: WITH a
     * traceSetVersion reproduces via the composable sine pipeline, WITHOUT one
     * (every pre-upgrade link/save) via the legacy generateProceduralPuzzle. See
     * project_share_link_prng_contract.
     */
    classicConfig?: {
        traceSetVersion?: number;
    };
}
