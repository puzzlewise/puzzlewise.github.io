/**
 * Same seed reproduces the exact cut pattern — essential for save/restore.
 *
 * Each shared internal edge is generated ONCE (first-side perspective: bottom of
 * upper piece, right of left piece); the mating second side reverses the point
 * array, which yields an exact mirror curve and guarantees perfect matching.
 */

import type { Edge, GeneratedPiece, Point, Size } from '../model/types.js';
import { fmt } from '../model/build-shape.js';
import {
    bezierPathToSvg,
    reverseBezierPath,
} from './composable/bezier-path.js';
import type { BezierPath } from './composable/bezier-path.js';
import { createSeededRandom } from './seeded-random.js';

const Dir = {
    Top: 0,
    Right: 1,
    Bottom: 2,
    Left: 3,
} as const;

type Dir = (typeof Dir)[keyof typeof Dir];

interface SharedEdgePaths {
    horizontal: BezierPath[][]; // [row][col] - edges between row and row+1
    vertical: BezierPath[][];   // [row][col] - edges between col and col+1
}

export function generateProceduralPuzzle(
    cols: number,
    rows: number,
    imageSize: Size,
    seed: number,
): GeneratedPiece[] {
    const random = createSeededRandom(seed);
    const pieceWidth = imageSize.width / cols;
    const pieceHeight = imageSize.height / rows;

    const horizontalIsTab = createIsTabMap(cols, rows - 1, random); // between rows
    const verticalIsTab = createIsTabMap(cols - 1, rows, random); // between cols

    const sharedPaths = generateAllSharedEdgePaths(
        cols,
        rows,
        pieceWidth,
        pieceHeight,
        horizontalIsTab,
        verticalIsTab,
        random,
    );

    let nextEdgeId = 0;

    const edgeIdMap: number[][][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => [-1, -1, -1, -1]),
    );

    for (let row = 0; row < rows - 1; row++) {
        for (let col = 0; col < cols; col++) {
            const id1 = nextEdgeId++;
            const id2 = nextEdgeId++;
            edgeIdMap[row][col][Dir.Bottom] = id1;
            edgeIdMap[row + 1][col][Dir.Top] = id2;
        }
    }

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols - 1; col++) {
            const id1 = nextEdgeId++;
            const id2 = nextEdgeId++;
            edgeIdMap[row][col][Dir.Right] = id1;
            edgeIdMap[row][col + 1][Dir.Left] = id2;
        }
    }

    for (let col = 0; col < cols; col++) {
        edgeIdMap[0][col][Dir.Top] = nextEdgeId++;
        edgeIdMap[rows - 1][col][Dir.Bottom] = nextEdgeId++;
    }
    for (let row = 0; row < rows; row++) {
        edgeIdMap[row][0][Dir.Left] = nextEdgeId++;
        edgeIdMap[row][cols - 1][Dir.Right] = nextEdgeId++;
    }

    const pieces: GeneratedPiece[] = [];

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const edges: Edge[] = [];

            for (const dir of [Dir.Top, Dir.Right, Dir.Bottom, Dir.Left]) {
                edges.push(
                    buildEdge({
                        id: edgeIdMap[row][col][dir],
                        dir,
                        row,
                        col,
                        rows,
                        cols,
                        pieceWidth,
                        pieceHeight,
                        edgeIdMap,
                        sharedPaths,
                    }),
                );
            }

            const shape = buildShape(edges);

            pieces.push({
                id: row * cols + col,
                edges,
                shape,
                imageOffset: {
                    x: -col * pieceWidth,
                    y: -row * pieceHeight,
                },
            });
        }
    }

    return pieces;
}

function generateAllSharedEdgePaths(
    cols: number,
    rows: number,
    pieceWidth: number,
    pieceHeight: number,
    horizontalIsTab: boolean[][],
    verticalIsTab: boolean[][],
    random: () => number,
): SharedEdgePaths {
    // Horizontal edges (between row and row+1); first side = bottom of upper piece
    const horizontal: BezierPath[][] = [];
    for (let row = 0; row < rows - 1; row++) {
        horizontal[row] = [];
        for (let col = 0; col < cols; col++) {
            const start: Point = { x: pieceWidth, y: pieceHeight };
            const end: Point = { x: 0, y: pieceHeight };

            horizontal[row][col] = generateSharedEdgePath(
                start,
                end,
                horizontalIsTab[row][col],
                random,
            );
        }
    }

    // Vertical edges (between col and col+1); first side = right of left piece
    const vertical: BezierPath[][] = [];
    for (let row = 0; row < rows; row++) {
        vertical[row] = [];
        for (let col = 0; col < cols - 1; col++) {
            const start: Point = { x: pieceWidth, y: 0 };
            const end: Point = { x: pieceWidth, y: pieceHeight };

            vertical[row][col] = generateSharedEdgePath(
                start,
                end,
                verticalIsTab[row][col],
                random,
            );
        }
    }

    return { horizontal, vertical };
}

/**
 * Bézier path for a shared edge (classic 6-segment jigsaw shape), from the
 * first-side perspective, in an edge-relative frame: along-edge (dxh,dyh) and
 * perpendicular (dxv,dyv), combined by pointAt. `start`/`end` are piece-local.
 */
function generateSharedEdgePath(
    start: Point,
    end: Point,
    isTab: boolean,
    random: () => number,
): BezierPath {
    const dxh = end.x - start.x;
    const dyh = end.y - start.y;

    // Perpendicular (90° CCW); for a tab this points outward from the piece
    const sign = isTab ? 1 : -1;
    const dxv = -dyh * sign;
    const dyv = dxh * sign;

    const scalex = lerp(0.65, 1.0, random());
    const scaley = lerp(0.7, 1.1, random());
    const mid = lerp(0.38, 0.62, random()); // center position along edge

    // neckRatio: neck width / head width
    const neckRatio = lerp(0.25, 0.80, random());

    const pointAt = (coeffh: number, coeffv: number): Point => ({
        x: start.x + coeffh * dxh + coeffv * dxv,
        y: start.y + coeffh * dyh + coeffv * dyv,
    });

    const halfWidth = 0.17 * scalex; // half-width of the tab head

    // Tab key points: pa neck-entry, pb head-left, pc head-top, pd head-right, pe neck-exit
    const neckHalfWidth = halfWidth * neckRatio;

    const pa = pointAt(mid - neckHalfWidth, 0.08 * scaley);
    const pb = pointAt(mid - halfWidth * 0.9, 0.25 * scaley);
    const pc = pointAt(mid, 0.33 * scaley);
    const pd = pointAt(mid + halfWidth * 0.9, 0.25 * scaley);
    const pe = pointAt(mid + neckHalfWidth, 0.08 * scaley);

    // First/last segments keep control points ON the edge line (zero perpendicular)
    // to prevent bulging that depends on tab direction.
    const cp1_1 = pointAt(mid - neckHalfWidth * 2.5, 0);
    const cp1_2 = pointAt(mid - neckHalfWidth * 1.5, 0);

    const cp2_1 = pointAt(mid - neckHalfWidth * 0.7, 0.12 * scaley);
    const cp2_2 = pointAt(mid - halfWidth * 1.1, 0.20 * scaley);

    const cp3_1 = pointAt(mid - halfWidth * 0.6, 0.32 * scaley);
    const cp3_2 = pointAt(mid - halfWidth * 0.3, 0.33 * scaley);

    const cp4_1 = pointAt(mid + halfWidth * 0.3, 0.33 * scaley);
    const cp4_2 = pointAt(mid + halfWidth * 0.6, 0.32 * scaley);

    const cp5_1 = pointAt(mid + halfWidth * 1.1, 0.20 * scaley);
    const cp5_2 = pointAt(mid + neckHalfWidth * 0.7, 0.12 * scaley);

    const cp6_1 = pointAt(mid + neckHalfWidth * 1.5, 0);
    const cp6_2 = pointAt(mid + neckHalfWidth * 2.5, 0);

    return [
        start,
        cp1_1,
        cp1_2,
        pa,
        cp2_1,
        cp2_2,
        pb,
        cp3_1,
        cp3_2,
        pc,
        cp4_1,
        cp4_2,
        pd,
        cp5_1,
        cp5_2,
        pe,
        cp6_1,
        cp6_2,
        end,
    ];
}

function transformBezierPath(
    path: BezierPath,
    originalStart: Point,
    originalEnd: Point,
    newStart: Point,
    newEnd: Point,
): BezierPath {
    const origDx = originalEnd.x - originalStart.x;
    const origDy = originalEnd.y - originalStart.y;
    const newDx = newEnd.x - newStart.x;
    const newDy = newEnd.y - newStart.y;

    const origLen = Math.sqrt(origDx * origDx + origDy * origDy);
    const newLen = Math.sqrt(newDx * newDx + newDy * newDy);

    const origUx = origDx / origLen;
    const origUy = origDy / origLen;
    const origNx = -origUy;
    const origNy = origUx;

    const newUx = newDx / newLen;
    const newUy = newDy / newLen;
    const newNx = -newUy;
    const newNy = newUx;

    const scale = newLen / origLen;

    return path.map((p) => {
        const relX = p.x - originalStart.x;
        const relY = p.y - originalStart.y;

        const alongEdge = relX * origUx + relY * origUy;
        const perpEdge = relX * origNx + relY * origNy;

        const scaledAlong = alongEdge * scale;
        const scaledPerp = perpEdge * scale;

        return {
            x: newStart.x + scaledAlong * newUx + scaledPerp * newNx,
            y: newStart.y + scaledAlong * newUy + scaledPerp * newNy,
        };
    });
}

interface BuildEdgeParams {
    id: number;
    dir: Dir;
    row: number;
    col: number;
    rows: number;
    cols: number;
    pieceWidth: number;
    pieceHeight: number;
    edgeIdMap: number[][][];
    sharedPaths: SharedEdgePaths;
}

function buildEdge(params: BuildEdgeParams): Edge {
    const {
        id,
        dir,
        row,
        col,
        rows,
        cols,
        pieceWidth,
        pieceHeight,
        edgeIdMap,
        sharedPaths,
    } = params;

    const isBorder = isBorderEdge(dir, row, col, rows, cols);
    const { start, end } = getEdgeEndpoints(dir, pieceWidth, pieceHeight);

    let mateEdgeId = -1;
    let matePieceId = -1;

    if (!isBorder) {
        const matePos = getMatePosition(dir, row, col);
        const mateDir = getOppositeDir(dir);
        mateEdgeId = edgeIdMap[matePos.row][matePos.col][mateDir];
        matePieceId = matePos.row * cols + matePos.col;
    }

    let path: string;

    if (isBorder) {
        path = buildFlatEdgePath(end);
    } else {
        path = buildSharedEdgePath(
            dir,
            row,
            col,
            start,
            end,
            pieceWidth,
            pieceHeight,
            sharedPaths,
        );
    }

    return { id, mateEdgeId, matePieceId, path, start, end };
}

function buildSharedEdgePath(
    dir: Dir,
    row: number,
    col: number,
    start: Point,
    end: Point,
    pieceWidth: number,
    pieceHeight: number,
    sharedPaths: SharedEdgePaths,
): string {
    let storedPath: BezierPath;
    let originalStart: Point;
    let originalEnd: Point;
    let isSecondSide: boolean;

    switch (dir) {
        case Dir.Bottom:
            // First side: bottom edge of this piece
            storedPath = sharedPaths.horizontal[row][col];
            originalStart = { x: pieceWidth, y: pieceHeight };
            originalEnd = { x: 0, y: pieceHeight };
            isSecondSide = false;
            break;

        case Dir.Top:
            // Second side: top edge = mate of the piece-above's bottom edge (horizontal[row-1])
            storedPath = sharedPaths.horizontal[row - 1][col];
            originalStart = { x: pieceWidth, y: pieceHeight };
            originalEnd = { x: 0, y: pieceHeight };
            isSecondSide = true;
            break;

        case Dir.Right:
            // First side: right edge of this piece
            storedPath = sharedPaths.vertical[row][col];
            originalStart = { x: pieceWidth, y: 0 };
            originalEnd = { x: pieceWidth, y: pieceHeight };
            isSecondSide = false;
            break;

        case Dir.Left:
            // Second side: left edge = mate of the left-piece's right edge (vertical[col-1])
            storedPath = sharedPaths.vertical[row][col - 1];
            originalStart = { x: pieceWidth, y: 0 };
            originalEnd = { x: pieceWidth, y: pieceHeight };
            isSecondSide = true;
            break;
    }

    let pathToUse = storedPath;
    if (isSecondSide) {
        pathToUse = reverseBezierPath(storedPath);
        const temp = originalStart;
        originalStart = originalEnd;
        originalEnd = temp;
    }

    const transformedPath = transformBezierPath(
        pathToUse,
        originalStart,
        originalEnd,
        start,
        end,
    );

    return bezierPathToSvg(transformedPath);
}

function isBorderEdge(
    dir: Dir,
    row: number,
    col: number,
    rows: number,
    cols: number,
): boolean {
    switch (dir) {
        case Dir.Top:
            return row === 0;
        case Dir.Bottom:
            return row === rows - 1;
        case Dir.Left:
            return col === 0;
        case Dir.Right:
            return col === cols - 1;
    }
}

function getEdgeEndpoints(
    dir: Dir,
    w: number,
    h: number,
): { start: Point; end: Point } {
    switch (dir) {
        case Dir.Top:
            return { start: { x: 0, y: 0 }, end: { x: w, y: 0 } };
        case Dir.Right:
            return { start: { x: w, y: 0 }, end: { x: w, y: h } };
        case Dir.Bottom:
            return { start: { x: w, y: h }, end: { x: 0, y: h } };
        case Dir.Left:
            return { start: { x: 0, y: h }, end: { x: 0, y: 0 } };
    }
}

function getOppositeDir(dir: Dir): Dir {
    switch (dir) {
        case Dir.Top:
            return Dir.Bottom;
        case Dir.Bottom:
            return Dir.Top;
        case Dir.Left:
            return Dir.Right;
        case Dir.Right:
            return Dir.Left;
    }
}

function getMatePosition(
    dir: Dir,
    row: number,
    col: number,
): { row: number; col: number } {
    switch (dir) {
        case Dir.Top:
            return { row: row - 1, col };
        case Dir.Bottom:
            return { row: row + 1, col };
        case Dir.Left:
            return { row, col: col - 1 };
        case Dir.Right:
            return { row, col: col + 1 };
    }
}

/**
 * 2D map of isTab flags per shared internal edge (true = first side gets a tab).
 *
 * Advances the PRNG by 6 calls per edge: historically randomTabParams() consumed
 * 6 values (isTab + 5 shape fields the generator never read). Share links store
 * only the seed and re-run this generator, so the exact PRNG call sequence is an
 * on-the-wire contract; the 5 reserved calls are also slots for future per-edge
 * randomness.
 */
function createIsTabMap(
    width: number,
    height: number,
    random: () => number,
): boolean[][] {
    return Array.from({ length: height }, () =>
        Array.from({ length: width }, () => {
            const isTab = random() < 0.5;
            random(); random(); random(); random(); random();
            return isTab;
        }),
    );
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function buildFlatEdgePath(end: Point): string {
    return `L ${end.x} ${end.y}`;
}

function buildShape(edges: Edge[]): string {
    if (edges.length === 0) return '';

    const first = edges[0];
    const parts = [`M ${fmt(first.start.x)} ${fmt(first.start.y)}`];

    for (const edge of edges) {
        parts.push(edge.path);
    }

    parts.push('Z');

    return parts.join(' ');
}
