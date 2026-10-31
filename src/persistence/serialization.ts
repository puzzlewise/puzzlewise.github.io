/** GameState's Maps (PieceGroup.pieces) don't survive JSON; these helpers convert to/from a JSON-safe shape. */

import type {
    Edge,
    GameState,
    GridSize,
    ImageAttribution,
    Piece,
    PieceBounds,
    PieceGroup,
    Point,
    Size,
} from '../model/types.js';
import { buildGroupIndexes, buildPiecesById } from '../model/helpers.js';
import { getImageDimensions } from '../model/derive.js';
import { buildShape } from '../model/build-shape.js';
import { deriveMatePath } from '../model/edge-path.js';
import { sealPieceGeometry } from '../model/seal-geometry.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../game/init.js';
import { legacyDisableTabsToTabGenerator } from '../game/composable-config.js';
import { isDataUrl } from '../sharing/safe-url.js';
import type { ViewportState } from '../interaction/viewport-transform.js';

/** Bump when the serialized shape changes. */
export const STATE_VERSION = 14;

/**
 * Version history (migrations run on load; keep them — users still hold old saves):
 * - v1: no imageSize/attribution. v2: +imageSize/attribution. v3: +gridSize.
 * - v4: +seed. v5: +cutStyle. v6: +per-group quarter-turn rotation. v7: +generatorConfig.
 * - v8: typed composableConfig/fractalConfig replace generatorConfig.
 * - v9: rotation as float degrees; v≤8 quarter-turns migrated ×90.
 * - v10: composableConfig → opaque {baseCutGenerator,baseCutConfig,tabGenerator,tabConfig}
 *        (migrateLegacyComposableConfig).
 * - v11: split storage — STATIC omits groups/selection/completed; v≤10 full blobs still load.
 * - v12: pieces store `bounds`, drop `curvePoints`; `shape` omitted when buildShape(edges)
 *        rebuilds it byte-identically. This makes model/build-shape.ts part of the format:
 *        changing its output bytes re-renders every stored v12 puzzle and needs a version
 *        bump, not just a test update (serialization.test.ts pins the bytes).
 * - v13: `imageUrl` optional (absent = blank); v≤12 stored a synthesized white PNG,
 *        migrated to absent on load.
 * - v14: a non-canonical interior edge (mateEdgeId < id) omits path when deriveMatePath
 *        (model/edge-path.ts) rebuilds it byte-identically from its mate; this makes
 *        edge-path.ts part of the format.
 */
const SUPPORTED_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** An edge as stored in a blob: v≤11 blobs may carry curve samples. */
export type SerializedEdge = Omit<Edge, 'path'> & { path?: string; curvePoints?: Point[] };

/**
 * `shape` is omitted (v12+) when `buildShape(edges)` reproduces it
 * byte-identically; `bounds` is required on v12+ pieces and absent on v≤11
 * pieces (computed during migration).
 */
export interface SerializedPiece {
    id: number;
    edges: SerializedEdge[];
    shape?: string;
    imageOffset: Point;
    bounds?: PieceBounds;
}

export interface SerializedPieceGroup {
    id: number;
    pieces: Array<[number, Point]>;
    position: Point;
    /**
     * v9+ saves store float degrees in `[0, 360)`; v6–v8 stored
     * a quarter-turn count `{0, 1, 2, 3}` and are migrated on load. Missing
     * on v5 and earlier saves.
     */
    rotation?: number;
}

export interface SerializedGameState {
    version: number;
    pieces: SerializedPiece[];
    groups: SerializedPieceGroup[];
    imageUrl?: string;
    imageSize?: Size;
    gridSize?: GridSize;
    completed: boolean;
    attribution?: ImageAttribution;
    seed?: number;
    cutStyle?: string;
    /** Missing on early v6 saves (pre-rotation-mode); migrated on load by cut style. */
    rotationMode?: 'none' | 'quarter-turn' | 'free';
    /** v8+; only set when cutStyle === 'composable'. */
    composableConfig?: GameState['composableConfig'];
    /** v8+; only set when cutStyle === 'fractal'. */
    fractalConfig?: GameState['fractalConfig'];
    /** Only set when cutStyle === 'wavy'. */
    wavyConfig?: GameState['wavyConfig'];
    /** Only set when cutStyle === 'triangles'. */
    trianglesConfig?: GameState['trianglesConfig'];
    /** Only set when cutStyle === 'classic' with the sine generator. */
    classicConfig?: GameState['classicConfig'];
    /**
     * v7 legacy opaque config; migrated to typed composableConfig/fractalConfig
     * by cutStyle on load. v7 saves still exist, so keep it for input validation.
     */
    generatorConfig?: Record<string, unknown>;
    /**
     * Group ids selected for batch movement; omitted when empty. Deliberately
     * NOT gated behind a STATE_VERSION bump: it's additive/optional, so old
     * builds ignore the key rather than rejecting the whole save on deploy.
     */
    selection?: number[];
}

/** Static portion: geometry + immutable metadata. No groups/selection/completed. */
export interface SerializedStaticState {
    version: number;
    pieces: SerializedPiece[];
    imageUrl?: string;
    imageSize?: Size;
    gridSize?: GridSize;
    attribution?: ImageAttribution;
    seed?: number;
    cutStyle?: string;
    rotationMode?: 'none' | 'quarter-turn' | 'free';
    composableConfig?: GameState['composableConfig'];
    fractalConfig?: GameState['fractalConfig'];
    wavyConfig?: GameState['wavyConfig'];
    trianglesConfig?: GameState['trianglesConfig'];
    classicConfig?: GameState['classicConfig'];
    /** Present only on legacy v7 blobs read through the static path. */
    generatorConfig?: Record<string, unknown>;
}

export interface SerializedProgress {
    version: number;
    /** Seed of the puzzle this progress belongs to, for pairing with the static blob. */
    seed?: number;
    groups: SerializedPieceGroup[];
    selection?: number[];
    completed: boolean;
    /**
     * Last viewport (zoom + pan). Like {@link SerializedGameState.selection},
     * NOT gated behind a STATE_VERSION bump — old builds ignore the key.
     */
    viewport?: SerializedViewport;
}

export interface SerializedViewport {
    scale: number;
    offset: Point;
}

/**
 * Compile-time pin between {@link SerializedViewport} and the runtime
 * {@link ViewportState} it mirrors: save/restore assign one to the other by
 * structural compatibility with no conversion, so a field added to only one
 * would silently drop at save/restore — this fails to compile first. Emits no
 * runtime code; the {@link ViewportState} import is type-only.
 */
declare function __assertViewportContract(
    toDisk: ViewportState extends SerializedViewport ? true : never,
    fromDisk: SerializedViewport extends ViewportState ? true : never,
): void;

/**
 * Convert a GameState to the full single-blob (v≤10) JSON shape. The live path
 * writes split serializeStatic + serializeProgress instead; kept as the
 * counterpart to deserializeState (still loads legacy single-key saves).
 * `selection` lives outside GameState so it's passed separately; empty/omitted
 * leaves the field off.
 */
export function serializeState(
    state: GameState,
    selection?: Iterable<number>,
): SerializedGameState {
    const serialized: SerializedGameState = {
        version: STATE_VERSION,
        pieces: serializePieces(state.pieces),
        groups: state.groups.map(serializeGroup),
        imageSize: state.imageSize,
        gridSize: state.gridSize,
        completed: state.completed,
    };

    if (state.imageUrl !== null) {
        serialized.imageUrl = state.imageUrl;
    }

    if (selection !== undefined) {
        const ids = [...selection];
        if (ids.length > 0) {
            serialized.selection = ids;
        }
    }

    if (state.attribution) {
        serialized.attribution = state.attribution;
    }

    if (state.seed !== undefined) {
        serialized.seed = state.seed;
    }

    if (state.cutStyle) {
        serialized.cutStyle = state.cutStyle;
    }

    if (state.rotationMode) {
        serialized.rotationMode = state.rotationMode;
    }

    if (state.composableConfig) {
        serialized.composableConfig = state.composableConfig;
    }

    if (state.fractalConfig) {
        serialized.fractalConfig = state.fractalConfig;
    }

    if (state.wavyConfig) {
        serialized.wavyConfig = state.wavyConfig;
    }

    if (state.trianglesConfig) {
        serialized.trianglesConfig = state.trianglesConfig;
    }

    if (state.classicConfig) {
        serialized.classicConfig = state.classicConfig;
    }

    return serialized;
}

export function serializeStatic(state: GameState): SerializedStaticState {
    const s: SerializedStaticState = {
        version: STATE_VERSION,
        pieces: serializePieces(state.pieces),
        imageSize: state.imageSize,
        gridSize: state.gridSize,
    };
    if (state.imageUrl !== null) {
        s.imageUrl = state.imageUrl;
    }
    if (state.attribution) s.attribution = state.attribution;
    if (state.seed !== undefined) s.seed = state.seed;
    if (state.cutStyle) s.cutStyle = state.cutStyle;
    if (state.rotationMode) s.rotationMode = state.rotationMode;
    if (state.composableConfig) s.composableConfig = state.composableConfig;
    if (state.fractalConfig) s.fractalConfig = state.fractalConfig;
    if (state.wavyConfig) s.wavyConfig = state.wavyConfig;
    if (state.trianglesConfig) s.trianglesConfig = state.trianglesConfig;
    if (state.classicConfig) s.classicConfig = state.classicConfig;
    return s;
}

export function serializeProgress(
    state: GameState,
    selection?: Iterable<number>,
    viewport?: SerializedViewport,
): SerializedProgress {
    const p: SerializedProgress = {
        version: STATE_VERSION,
        groups: state.groups.map(serializeGroup),
        completed: state.completed,
    };
    if (state.seed !== undefined) p.seed = state.seed;
    if (selection !== undefined) {
        const ids = [...selection];
        if (ids.length > 0) p.selection = ids;
    }
    if (viewport !== undefined) p.viewport = viewport;
    return p;
}

interface EdgeOwner<E> {
    edge: E;
    imageOffset: Point;
}

function edgeOwners<E extends { id: number }>(
    pieces: Array<{ edges: E[]; imageOffset: Point }>,
): Map<number, EdgeOwner<E>> {
    const owners = new Map<number, EdgeOwner<E>>();
    for (const piece of pieces) {
        if (!Array.isArray(piece.edges)) continue;
        for (const edge of piece.edges) owners.set(edge.id, { edge, imageOffset: piece.imageOffset });
    }
    return owners;
}

function pathFromMate(
    edge: SerializedEdge,
    imageOffset: Point,
    owners: Map<number, EdgeOwner<SerializedEdge>>,
): string | null {
    if (edge.mateEdgeId < 0 || edge.mateEdgeId >= edge.id) return null;
    const canon = owners.get(edge.mateEdgeId);
    if (canon?.edge.mateEdgeId !== edge.id || typeof canon.edge.path !== 'string') return null;
    return deriveMatePath(canon.edge.path, canon.edge.start, canon.imageOffset, imageOffset);
}

/**
 * Omits `shape` when buildShape(edges) rebuilds it, and a mate edge's `path`
 * when its canonical edge rebuilds it, each byte-identically. Verified per
 * item, never per generator — whether the bytes match is a per-item fact (see
 * game/init-geometry-precision.test.ts).
 */
function serializePieces(pieces: Piece[]): SerializedPiece[] {
    const owners = edgeOwners<SerializedEdge>(pieces);
    return pieces.map((piece) => {
        const edges = piece.edges.map((edge): SerializedEdge => {
            if (pathFromMate(edge, piece.imageOffset, owners) !== edge.path) return edge;
            const { path: _omitted, ...rest } = edge;
            return rest;
        });
        const serialized: SerializedPiece = { ...piece, edges };
        if (buildShape(piece.edges) === piece.shape) delete serialized.shape;
        return serialized;
    });
}

function restoreEdgePaths(
    piece: SerializedPiece,
    i: number,
    owners: Map<number, EdgeOwner<SerializedEdge>>,
): Edge[] {
    return piece.edges.map((edge) => {
        if (edge.path === undefined) {
            const path = pathFromMate(edge, piece.imageOffset, owners);
            if (path === null) throw new Error(`Invalid state: piece ${i} edge ${edge.id} has no path`);
            return { ...edge, path };
        }
        if (typeof edge.path !== 'string') {
            throw new Error(`Invalid state: piece ${i} edge ${edge.id} has a non-string path`);
        }
        return edge as Edge;
    });
}

/**
 * Finite on all four sides and not inverted: an inverted box propagates a
 * negative dimension into `deriveImageSize`. No writer here produces one, so a
 * blob carrying it is corrupt — reject it rather than mis-render later.
 */
function isUsableBounds(bounds: PieceBounds | undefined): bounds is PieceBounds {
    if (bounds == null) return false;
    const { minX, minY, maxX, maxY } = bounds;
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return false;
    return maxX >= minX && maxY >= minY;
}

/**
 * - v12+: `bounds` must be present and usable (throw otherwise); a missing
 *   `shape` is rebuilt from the edge paths.
 * - v≤11: `shape` always present; `bounds` computed from stored endpoints +
 *   curve samples (the walk the app ran before v12), and the samples dropped.
 *
 * Both branches finish through `sealPieceGeometry`, so the "bounds present, no
 * curve samples" invariant is enforced in one place. Only v12+ runs
 * `isUsableBounds` — a v12 box is untrusted disk data, while the v≤11 box is
 * computed here and rejecting it would make saves every build loads unreadable.
 */
function restorePieces(pieces: SerializedPiece[], version: number): Piece[] {
    if (version >= 12) {
        const owners = version >= 14 ? edgeOwners(pieces) : null;
        return sealPieceGeometry(pieces.map((piece, i) => {
            const { bounds } = piece;
            if (!isUsableBounds(bounds)) {
                throw new Error(`Invalid state: piece ${i} has no usable bounds`);
            }
            if (!Array.isArray(piece.edges)) {
                throw new Error(`Invalid state: piece ${i} has no edges`);
            }
            if (piece.shape !== undefined && typeof piece.shape !== 'string') {
                throw new Error(`Invalid state: piece ${i} has a non-string shape`);
            }
            const edges = owners ? restoreEdgePaths(piece, i, owners) : piece.edges as Edge[];
            return {
                ...piece,
                edges,
                bounds,
                shape: piece.shape ?? buildShape(edges),
            };
        }));
    }
    return sealPieceGeometry(pieces.map((piece, i) => {
        if (typeof piece.shape !== 'string') {
            throw new Error(`Invalid state: piece ${i} has no shape`);
        }
        if (!Array.isArray(piece.edges)) {
            throw new Error(`Invalid state: piece ${i} has no edges`);
        }
        // Drop any `bounds`: no v≤11 writer produced it, so one here is
        // untrustworthy — these saves' bounds come from their curve samples.
        const { bounds: _ignored, ...rest } = piece;
        return { ...rest, edges: piece.edges as Edge[], shape: piece.shape };
    }));
}

/** Throws if the data is invalid or the version is unsupported. */
export function deserializeState(data: SerializedGameState): GameState {
    if (!SUPPORTED_VERSIONS.includes(data.version)) {
        throw new Error(
            `Unsupported state version: ${data.version} (expected one of ${SUPPORTED_VERSIONS.join(', ')})`,
        );
    }

    validateSerializedState(data);

    const pieces = restorePieces(data.pieces, data.version);

    const groups = data.groups.map(deserializeGroup);

    // v≤8 stored rotation as quarter-turns; v9+ as degrees. Migrate by ×90.
    if (data.version <= 8) {
        for (const group of groups) {
            group.rotation = group.rotation * 90;
        }
    }

    const { groupsById, pieceToGroup } = buildGroupIndexes(groups);

    // For v1 saves (no imageSize), derive it from piece data
    const imageSize = data.imageSize ?? deriveImageSize(pieces);

    // For v1/v2 saves (no gridSize), assume the original 8×6 default
    const gridSize = data.gridSize ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };

    const state: GameState = {
        pieces,
        groups,
        piecesById: buildPiecesById(pieces),
        groupsById,
        pieceToGroup,
        imageUrl: readImageUrl(data.imageUrl),
        imageSize,
        gridSize,
        completed: data.completed,
    };

    if (data.attribution) {
        state.attribution = data.attribution;
    }

    if (data.seed !== undefined) {
        state.seed = data.seed;
    }

    if (data.cutStyle) {
        state.cutStyle = data.cutStyle;
    }

    state.rotationMode = resolveRotationMode(data, groups);

    const composableConfig = resolveComposableConfig(data);
    if (composableConfig) {
        state.composableConfig = composableConfig;
    }

    const fractalConfig = resolveFractalConfig(data);
    if (fractalConfig) {
        state.fractalConfig = fractalConfig;
    }

    if (data.wavyConfig) {
        state.wavyConfig = data.wavyConfig;
    }

    if (data.trianglesConfig) {
        state.trianglesConfig = data.trianglesConfig;
    }

    if (data.classicConfig) {
        state.classicConfig = data.classicConfig;
    }

    return state;
}

/**
 * The static blob may be a v11 static-only blob or a legacy v≤10 full blob
 * (its inline groups are ignored — groups come from `progress`).
 *
 * Progress blobs are always written at the current version (rotations in
 * degrees); no quarter-turn→degrees migration is applied here — legacy v≤10
 * saves load via `deserializeState`.
 */
export function recombine(
    staticData: SerializedStaticState,
    progress: SerializedProgress,
): GameState {
    if (!SUPPORTED_VERSIONS.includes(staticData.version)) {
        throw new Error(
            `Unsupported state version: ${staticData.version} (expected one of ${SUPPORTED_VERSIONS.join(', ')})`,
        );
    }
    if (!SUPPORTED_VERSIONS.includes(progress.version)) {
        throw new Error(
            `Unsupported progress version: ${progress.version} (expected one of ${SUPPORTED_VERSIONS.join(', ')})`,
        );
    }
    if (!Array.isArray(staticData.pieces) || staticData.pieces.length === 0) {
        throw new Error('Invalid state: pieces must be a non-empty array');
    }
    validateImageUrl(staticData.imageUrl, staticData.version);
    const pieces = restorePieces(staticData.pieces, staticData.version);
    validateGroups(progress.groups);

    const groups = progress.groups.map(deserializeGroup);
    const { groupsById, pieceToGroup } = buildGroupIndexes(groups);
    const imageSize = staticData.imageSize ?? deriveImageSize(pieces);
    const gridSize = staticData.gridSize ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };

    const state: GameState = {
        pieces,
        groups,
        piecesById: buildPiecesById(pieces),
        groupsById,
        pieceToGroup,
        imageUrl: readImageUrl(staticData.imageUrl),
        imageSize,
        gridSize,
        completed: progress.completed,
    };
    if (staticData.attribution) state.attribution = staticData.attribution;
    if (staticData.seed !== undefined) state.seed = staticData.seed;
    if (staticData.cutStyle) state.cutStyle = staticData.cutStyle;
    state.rotationMode = resolveRotationMode(staticData, groups);
    const composableConfig = resolveComposableConfig(staticData);
    if (composableConfig) state.composableConfig = composableConfig;
    const fractalConfig = resolveFractalConfig(staticData);
    if (fractalConfig) state.fractalConfig = fractalConfig;
    if (staticData.wavyConfig) state.wavyConfig = staticData.wavyConfig;
    if (staticData.trianglesConfig) state.trianglesConfig = staticData.trianglesConfig;
    if (staticData.classicConfig) state.classicConfig = staticData.classicConfig;
    return state;
}

/**
 * At v10 the on-disk shape changed from legacy long-named fields
 * (horizontalAmplitude, …) to opaque {baseCutGenerator,baseCutConfig,tabGenerator,tabConfig}.
 * - v10+: new shape, pass through.
 * - v7–v9: legacy shape (under composableConfig for v8/v9, generatorConfig for v7); migrate.
 * - v≤6: no composable config.
 */
function resolveComposableConfig(
    data: SerializedStaticState,
): GameState['composableConfig'] | undefined {
    if (data.composableConfig) {
        const cfg = data.composableConfig as Record<string, unknown>;
        // v10+ saves already use the new shape. Detect by the presence of
        // any new-shape field (any one is sufficient — the keys are
        // disjoint from the legacy field names).
        if (
            'baseCutGenerator' in cfg ||
            'baseCutConfig' in cfg ||
            'tabGenerator' in cfg ||
            'tabConfig' in cfg
        ) {
            return data.composableConfig;
        }
        return migrateLegacyComposableConfig(cfg);
    }

    if (data.cutStyle !== 'composable' || !data.generatorConfig) {
        return undefined;
    }

    return migrateLegacyComposableConfig(data.generatorConfig);
}

/** v7/v8/v9 → v10 migration. */
function migrateLegacyComposableConfig(
    legacy: Record<string, unknown>,
): NonNullable<GameState['composableConfig']> {
    const baseCutConfig: Record<string, unknown> = {};
    if (typeof legacy.horizontalAmplitude === 'number') {
        baseCutConfig.ha = legacy.horizontalAmplitude;
    }
    if (typeof legacy.horizontalFrequency === 'number') {
        baseCutConfig.hf = legacy.horizontalFrequency;
    }
    if (typeof legacy.verticalAmplitude === 'number') {
        baseCutConfig.va = legacy.verticalAmplitude;
    }
    if (typeof legacy.verticalFrequency === 'number') {
        baseCutConfig.vf = legacy.verticalFrequency;
    }

    const config: NonNullable<GameState['composableConfig']> = {
        baseCutGenerator: 'sine',
        baseCutConfig,
        tabGenerator: legacyDisableTabsToTabGenerator(legacy.disableTabs),
        tabConfig: {},
    };
    return config;
}

/**
 * v8+ stores it directly. v7 saves stored an opaque `generatorConfig`;
 * for fractal puzzles, migrate the `borderless` flag into the typed shape.
 */
function resolveFractalConfig(
    data: SerializedStaticState,
): GameState['fractalConfig'] | undefined {
    if (data.fractalConfig) {
        return data.fractalConfig;
    }

    if (data.cutStyle !== 'fractal' || !data.generatorConfig) {
        return undefined;
    }

    const gc = data.generatorConfig;
    if (typeof gc.borderless !== 'boolean') {
        return {};
    }
    return { borderless: gc.borderless };
}

/**
 * Honour an explicitly recorded mode; else infer: any non-zero group rotation
 * (or a pre-field fractal save) implies quarter-turn, matching what the player
 * saw; otherwise 'none'.
 */
function resolveRotationMode(
    data: SerializedStaticState,
    groups: PieceGroup[],
): 'none' | 'quarter-turn' | 'free' {
    if (
        data.rotationMode === 'quarter-turn' ||
        data.rotationMode === 'none' ||
        data.rotationMode === 'free'
    ) {
        return data.rotationMode;
    }

    if (groups.some((g) => g.rotation !== 0)) {
        return 'quarter-turn';
    }

    if (data.cutStyle === 'fractal') {
        return 'quarter-turn';
    }

    return 'none';
}

/**
 * Other fields are inert padding — `getImageDimensions` only reads `pieces`.
 * Takes restored `Piece[]` (run blob pieces through `restorePieces` first):
 * `getImageDimensions` reads `piece.bounds`, present only on restored pieces.
 */
function deriveImageSize(pieces: Piece[]): Size {
    const tempState: GameState = {
        pieces,
        groups: [],
        piecesById: buildPiecesById(pieces),
        groupsById: new Map(),
        pieceToGroup: new Map(),
        imageUrl: null,
        imageSize: { width: 0, height: 0 },
        gridSize: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        completed: false,
    };

    return getImageDimensions(tempState);
}

/**
 * A `data:` URL is the synthesized white PNG a v≤12 blank puzzle stored;
 * collapsed to null at every version. localStorage has no upstream scheme
 * guard, so this is the only thing keeping a hand-edited `data:` URL out of the
 * `<image>` href.
 */
function readImageUrl(imageUrl: string | undefined): string | null {
    return imageUrl === undefined || isDataUrl(imageUrl)
        ? null
        : imageUrl;
}

function validateImageUrl(imageUrl: unknown, version: number): void {
    if (version >= 13 && imageUrl === undefined) return;
    if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
        throw new Error('Invalid state: imageUrl must be a non-empty string');
    }
}

/**
 * Tolerates missing/garbage data (old saves, hand-edited storage): absent/non-array
 * yields `[]`, non-finite entries dropped. Ids aren't checked against live
 * groups — the caller prunes stale ones.
 */
export function readSelection(data: SerializedGameState | SerializedProgress): number[] {
    if (!Array.isArray(data.selection)) {
        return [];
    }
    return data.selection.filter(
        (id): id is number => typeof id === 'number' && Number.isFinite(id),
    );
}

/**
 * Tolerates missing/garbage data (old saves, hand-edited storage): missing,
 * non-object, non-finite `scale`, or a bad `offset` all yield `undefined`. Never throws.
 */
export function readViewport(data: SerializedProgress): SerializedViewport | undefined {
    const vp = data.viewport as unknown;
    if (typeof vp !== 'object' || vp === null) {
        return undefined;
    }
    const { scale, offset } = vp as { scale?: unknown; offset?: unknown };
    if (typeof scale !== 'number' || !Number.isFinite(scale)) {
        return undefined;
    }
    if (typeof offset !== 'object' || offset === null) {
        return undefined;
    }
    const { x, y } = offset as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
        return undefined;
    }
    return { scale, offset: { x, y } };
}

function serializeGroup(group: PieceGroup): SerializedPieceGroup {
    return {
        id: group.id,
        pieces: Array.from(group.pieces.entries()),
        position: group.position,
        rotation: group.rotation,
    };
}

function deserializeGroup(group: SerializedPieceGroup): PieceGroup {
    return {
        id: group.id,
        pieces: new Map(group.pieces),
        position: group.position,
        rotation: normalizeStoredRotation(group.rotation),
    };
}

/**
 * v≤5 saves have no rotation; coerce missing/invalid to 0. Returns the raw
 * stored value (quarter-turns for v≤8, degrees for v≥9) — the caller converts
 * quarter-turns by ×90.
 */
function normalizeStoredRotation(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return 0;
}

function validateGroups(groups: SerializedPieceGroup[] | undefined): void {
    if (!Array.isArray(groups) || groups.length === 0) {
        throw new Error('Invalid state: groups must be a non-empty array');
    }
    for (const group of groups) {
        if (typeof group.id !== 'number') {
            throw new Error('Invalid state: group id must be a number');
        }
        if (!Array.isArray(group.pieces) || group.pieces.length === 0) {
            throw new Error(`Invalid state: group ${group.id} must have at least one piece`);
        }
        if (!Number.isFinite(group.position?.x) || !Number.isFinite(group.position?.y)) {
            throw new Error(`Invalid state: group ${group.id} must have a valid position`);
        }
    }
}

function validateSerializedState(data: SerializedGameState): void {
    if (!Array.isArray(data.pieces) || data.pieces.length === 0) {
        throw new Error('Invalid state: pieces must be a non-empty array');
    }

    validateImageUrl(data.imageUrl, data.version);

    if (typeof data.completed !== 'boolean') {
        throw new Error('Invalid state: completed must be a boolean');
    }

    validateGroups(data.groups);
}
