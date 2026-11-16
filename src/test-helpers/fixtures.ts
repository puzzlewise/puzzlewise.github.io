/**
 * Canonical builders, replacing per-file copies that drifted (an inconsistent
 * fixture could paper over a real bug). Accept overrides to tune the shape.
 */

import type { Edge, GameState, Piece, PieceBounds, PieceGroup, Point } from '../model/types.js';
import {
    buildGroupIndexes,
    buildPiecesById,
    getPiece,
    getWorldPosition,
    rotatePoint,
} from '../model/helpers.js';
import { computePieceBounds } from '../model/derive.js';
import { ROTATION_COMPLETE_AT_FRACTION } from '../game/snap-proximity-rotation.js';

/** Re-exported for tests that need the `piecesById` index without `makeGameState`. */
export { buildPiecesById };

export interface MakePieceOpts {
    id?: number;
    edges?: Edge[];
    shape?: string;
    imageOffset?: Point;
    bounds?: PieceBounds;
}

export function makePiece(opts: MakePieceOpts = {}): Piece {
    const edges = opts.edges ?? [];
    return {
        id: opts.id ?? 0,
        edges,
        shape: opts.shape ?? '',
        imageOffset: opts.imageOffset ?? { x: 0, y: 0 },
        // Infinite for the default empty-edge piece (matches the old on-demand
        // walk); tests reading bounds pass real edges or an override.
        bounds: opts.bounds ?? computePieceBounds({ edges }),
    };
}

export interface MakeRectPieceOpts {
    id?: number;
    width?: number;
    height?: number;
    /** Column in the source-image grid; used to derive imageOffset. */
    col?: number;
    /** Row in the source-image grid; used to derive imageOffset. */
    row?: number;
    imageOffset?: Point;
    bounds?: PieceBounds;
}

/**
 * A 4-edge rectangular Piece spanning (0,0)–(width, height), all border edges.
 * Edge ids are deterministic (id*4 .. id*4+3) so they don't collide between
 * pieces. imageOffset defaults to (-col*width, -row*height) — the piece tiled
 * at (col, row) behind one source image; `col` defaults to `id`.
 */
export function makeRectPiece(opts: MakeRectPieceOpts = {}): Piece {
    const id = opts.id ?? 0;
    const width = opts.width ?? 100;
    const height = opts.height ?? 100;
    const col = opts.col ?? id;
    const row = opts.row ?? 0;
    const base = id * 4;

    const edges: Edge[] = [
        {
            id: base,
            mateEdgeId: -1,
            matePieceId: -1,
            path: `L${width},0`,
            start: { x: 0, y: 0 },
            end: { x: width, y: 0 },
        },
        {
            id: base + 1,
            mateEdgeId: -1,
            matePieceId: -1,
            path: `L${width},${height}`,
            start: { x: width, y: 0 },
            end: { x: width, y: height },
        },
        {
            id: base + 2,
            mateEdgeId: -1,
            matePieceId: -1,
            path: `L0,${height}`,
            start: { x: width, y: height },
            end: { x: 0, y: height },
        },
        {
            id: base + 3,
            mateEdgeId: -1,
            matePieceId: -1,
            path: 'L0,0',
            start: { x: 0, y: height },
            end: { x: 0, y: 0 },
        },
    ];

    return {
        id,
        edges,
        shape: `M0,0 L${width},0 L${width},${height} L0,${height} Z`,
        // `|| 0` normalizes `-0` to `0` so values survive JSON round-trips in
        // serialization tests.
        imageOffset: opts.imageOffset ?? {
            x: -col * width || 0,
            y: -row * height || 0,
        },
        bounds: opts.bounds ?? computePieceBounds({ edges }),
    };
}

/**
 * A border piece whose closed `outline` arrives split into `edgeCount`
 * multi-segment `L` edges, as generated pieces do. Edge ids are id*100000 + k.
 */
export function makeOutlinePiece(id: number, outline: readonly Point[], edgeCount = 4): Piece {
    const per = Math.ceil(outline.length / edgeCount);
    const edges: Edge[] = [];
    for (let k = 0; k * per < outline.length; k++) {
        const from = k * per;
        const to = Math.min(outline.length, from + per);
        const run = [...outline.slice(from + 1, to), outline[to % outline.length]];
        edges.push({
            id: id * 100000 + k,
            mateEdgeId: -1,
            matePieceId: -1,
            path: run.map((p) => `L ${p.x} ${p.y}`).join(' '),
            start: outline[from],
            end: outline[to % outline.length],
        });
    }
    const shape = `M ${outline[0].x} ${outline[0].y} ${outline.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ')} Z`;
    const xs = outline.map((p) => p.x);
    const ys = outline.map((p) => p.y);
    return {
        id,
        edges,
        shape,
        imageOffset: { x: 0, y: 0 },
        bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    };
}

/** `teeth` teeth 1 wide and `height` tall on a 2-tall base: 4·teeth + 2 points. */
export function combOutline(teeth: number, height = 20): Point[] {
    const points: Point[] = [];
    for (let i = 0; i < teeth; i++) {
        points.push({ x: 2 * i, y: 0 }, { x: 2 * i, y: height }, { x: 2 * i + 1, y: height }, { x: 2 * i + 1, y: 0 });
    }
    points.push({ x: 2 * teeth, y: -2 }, { x: 0, y: -2 });
    return points;
}

/**
 * The `piecesById` / `groupsById` / `pieceToGroup` indexes are derived from the
 * final pieces/groups (overrides included). Override them explicitly only to
 * exercise an inconsistent state.
 */
export function makeGameState(overrides: Partial<GameState> = {}): GameState {
    const pieces = overrides.pieces ?? [];
    const groups = overrides.groups ?? [];
    const { groupsById, pieceToGroup } = buildGroupIndexes(groups);

    const base: GameState = {
        pieces,
        groups,
        piecesById: buildPiecesById(pieces),
        groupsById,
        pieceToGroup,
        imageUrl: 'test.jpg',
        imageSize: { width: 800, height: 600 },
        gridSize: { cols: 8, rows: 6 },
        completed: false,
    };
    return { ...base, ...overrides };
}

/**
 * Two 100×100 pieces mated along a vertical edge, for snap/merge tests. Piece
 * 0's right edge (id 0) mates piece 1's left edge (id 1); all others are
 * borders. Un-rotated with offsets at (0,0), the aligned placement puts piece
 * 1's group origin exactly 100px right of piece 0's.
 */
export function makeMatedPiecePair(): { piece0: Piece; piece1: Piece } {
    const edge = (
        id: number, start: Point, end: Point,
        matePieceId = -1, mateEdgeId = -1,
    ): Edge => ({ id, matePieceId, mateEdgeId, path: '', start, end });

    const piece0 = makePiece({ id: 0, edges: [
        edge(10, { x: 0, y: 0 }, { x: 100, y: 0 }),
        edge(0, { x: 100, y: 0 }, { x: 100, y: 100 }, 1, 1),
        edge(11, { x: 100, y: 100 }, { x: 0, y: 100 }),
        edge(12, { x: 0, y: 100 }, { x: 0, y: 0 }),
    ] });
    const piece1 = makePiece({ id: 1, edges: [
        edge(13, { x: 0, y: 0 }, { x: 100, y: 0 }),
        edge(14, { x: 100, y: 0 }, { x: 100, y: 100 }),
        edge(15, { x: 100, y: 100 }, { x: 0, y: 100 }),
        edge(1, { x: 0, y: 100 }, { x: 0, y: 0 }, 0, 0),
    ] });

    return { piece0, piece1 };
}

/**
 * Single-piece group placed so the bbox center sits at `center` under
 * `rotation`. Assumes a 100×100 piece (local center (50, 50)). Placing by
 * center matters for rotation tests: `rotateGroup` keeps the bbox center fixed
 * in world space, so snap-distance reasoning pins that point, not `position`.
 */
export function makeCenteredGroup(
    id: number,
    pieceId: number,
    center: Point,
    rotation = 0,
): PieceGroup {
    const r = rotatePoint({ x: 50, y: 50 }, rotation);
    return {
        id,
        pieces: new Map([[pieceId, { x: 0, y: 0 }]]),
        position: { x: center.x - r.x, y: center.y - r.y },
        rotation,
    };
}

/**
 * The issue-#530 scenario: a stationary single-piece target (piece 0, group
 * 10, at origin) and a five-piece 500×100 moved row (pieces 1–5, group 11)
 * rotated `rotationDeg`, placed so piece 1's center sits at its aligned world
 * position (150, 50). Piece 1 is the row's only mated piece, 200px from the
 * row's bbox center, so at 8° a group-center-pivot snap sweeps its edge ≈27.9px
 * (2·200·sin 4°) — past MERGE_TOLERANCE_PX — while a piece-center pivot ≈0.
 */
export function makeWideRowScenario(rotationDeg: number): {
    state: GameState;
    movedGroup: PieceGroup;
    targetGroup: PieceGroup;
    piece0: Piece;
    piece1: Piece;
} {
    const { piece0, piece1 } = makeMatedPiecePair();
    const edge = (id: number, start: Point, end: Point): Edge =>
        ({ id, matePieceId: -1, mateEdgeId: -1, path: '', start, end });
    const fillers = [2, 3, 4, 5].map((id) => makePiece({ id, edges: [
        edge(id * 10, { x: 0, y: 0 }, { x: 100, y: 0 }),
        edge(id * 10 + 1, { x: 100, y: 0 }, { x: 100, y: 100 }),
        edge(id * 10 + 2, { x: 100, y: 100 }, { x: 0, y: 100 }),
        edge(id * 10 + 3, { x: 0, y: 100 }, { x: 0, y: 0 }),
    ] }));
    const r = rotatePoint({ x: 50, y: 50 }, rotationDeg);
    const movedGroup: PieceGroup = {
        id: 11,
        pieces: new Map([
            [1, { x: 0, y: 0 }], [2, { x: 100, y: 0 }], [3, { x: 200, y: 0 }],
            [4, { x: 300, y: 0 }], [5, { x: 400, y: 0 }],
        ]),
        position: { x: 150 - r.x, y: 50 - r.y },
        rotation: rotationDeg,
    };
    const targetGroup: PieceGroup = {
        id: 10,
        pieces: new Map([[0, { x: 0, y: 0 }]]),
        position: { x: 0, y: 0 },
        rotation: 0,
    };
    const state = makeGameState({
        pieces: [piece0, piece1, ...fillers],
        groups: [targetGroup, movedGroup],
        rotationMode: 'free',
    });
    return { state, movedGroup, targetGroup, piece0, piece1 };
}

/**
 * A game state that round-trips through persistence. `recombine` rejects an
 * empty `pieces` array (makeGameState()'s bare default), so a saved-and-read
 * fixture needs at least one real piece and a group holding it.
 */
export function makeSavedGameState(): GameState {
    const pieces = [makeRectPiece({ id: 0 })];
    const groups: PieceGroup[] = [
        { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]), position: { x: 0, y: 0 }, rotation: 0 },
    ];
    return makeGameState({ pieces, groups, imageUrl: 'test-image.jpg' });
}

/**
 * The wide row with a second mate at the far end: piece 1 (center (50, 50))
 * mates group 10, piece 5 (center (450, 50)) mates group 12. At 8° both
 * candidates qualify at ramp fractions 0.25 and 0.5, anchored to
 * `ROTATION_COMPLETE_AT_FRACTION` so the caps survive a retune. Each target
 * starts flush and is shifted along x by its candidate distance; a +x shift of
 * the row trades the two distances.
 *
 * `closest` picks which piece carries the closer candidate. Run both
 * arrangements: `getBorderEdges` always visits piece 1 before piece 5, so only
 * running both separates closest-wins from iteration-order accidents.
 */
export function makeTwoMatedEndsRow(closest: 1 | 5): { state: GameState } {
    const { state: base, movedGroup, targetGroup } = makeWideRowScenario(8);
    const piece5 = getPiece(base, 5);
    piece5.edges[1] = { ...piece5.edges[1], matePieceId: 6, mateEdgeId: 63 };
    const piece6 = makePiece({ id: 6, edges: [
        { id: 60, matePieceId: -1, mateEdgeId: -1, path: '', start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
        { id: 61, matePieceId: -1, mateEdgeId: -1, path: '', start: { x: 100, y: 0 }, end: { x: 100, y: 100 } },
        { id: 62, matePieceId: -1, mateEdgeId: -1, path: '', start: { x: 100, y: 100 }, end: { x: 0, y: 100 } },
        { id: 63, matePieceId: 5, mateEdgeId: 51, path: '', start: { x: 0, y: 100 }, end: { x: 0, y: 0 } },
    ] });

    const rampDistance = (fraction: number): number =>
        18 * (ROTATION_COMPLETE_AT_FRACTION + fraction * (1 - ROTATION_COMPLETE_AT_FRACTION));
    const [d1, d5] = closest === 1
        ? [rampDistance(0.25), rampDistance(0.5)]
        : [rampDistance(0.5), rampDistance(0.25)];
    const center5 = getWorldPosition({ x: 50, y: 50 }, 5, movedGroup);
    const state = makeGameState({
        pieces: [...base.pieces, piece6],
        groups: [
            { ...targetGroup, position: { x: -d1, y: 0 } },
            movedGroup,
            {
                id: 12,
                pieces: new Map([[6, { x: 0, y: 0 }]]),
                position: { x: center5.x + 50 + d5, y: center5.y - 50 },
                rotation: 0,
            },
        ],
        rotationMode: 'free',
    });
    return { state };
}
