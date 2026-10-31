import type { Edge, GeneratedPiece, Size } from '../../model/types.js';
import { fmt } from '../../model/build-shape.js';
import type { ArcData, DiagonalConnection, Tile } from './types.js';
import { connectionKey, makeTile } from './tile.js';
import { addArcs, makeArc } from './arcs.js';

interface ArcRef { pieceIdx: number; arcIdx: number }
type ArcIndex = Map<string, ArcRef[]>;

interface ArcOp { type: 'arc'; pieceIdx: number; arcIdx: number }
interface LineOp { type: 'line'; sx: number; sy: number; ex: number; ey: number }
type Op = ArcOp | LineOp;

interface RectBorder { xMin: number; yMin: number; xMax: number; yMax: number }

/**
 * Two arcs are "mates" when they share the same center + quadrant
 * but belong to different pieces (one has sign=0, the other sign=1).
 */
export function convertToStandardPieces(
    fractalPieces: DiagonalConnection[][],
    orphanDiscs: Array<{ tile: Tile; ownerPieceIdx: number }>,
    rad: number,
    frameOffset: number,
    imageSize: Size,
    gridCols: number,
    gridRows: number,
    borderless: boolean,
): GeneratedPiece[] {
    const allPieceArcs = buildMainContourArcs(fractalPieces, rad, frameOffset);
    const gapFills = computeGapFills(allPieceArcs, fractalPieces, rad, frameOffset);

    // Capture BEFORE appending diamond/disc arcs so those extras render as their
    // own closed sub-paths below.
    const mainArcCount = allPieceArcs.map(arcs => arcs.length);

    appendDiamondFillerArcs(allPieceArcs, gapFills, rad, frameOffset);
    appendOrphanDiscArcs(allPieceArcs, orphanDiscs, rad, frameOffset);

    const { arcIndex, arcKeys } = buildArcIndex(allPieceArcs);
    const isMateless = markMatelessArcs(arcIndex, arcKeys);

    // Non-borderless: fit the TRIMMED rectangle (shrunk by `rad` per side,
    // aligned with outer-row tile centers); mateless arcs in the outer strip
    // get replaced below with straight border lines ("flat edge, no bumps").
    // Borderless: fit the FULL puzzle bounds so outer-row arcs sit at the image
    // edges and border pieces keep their organic curves.
    const shift = borderless ? 0 : rad;
    const puzzleWidth = borderless
        ? gridCols * 2 * rad
        : (gridCols - 1) * 2 * rad;
    const puzzleHeight = borderless
        ? gridRows * 2 * rad
        : (gridRows - 1) * 2 * rad;
    const scaleX = imageSize.width / puzzleWidth;
    const scaleY = imageSize.height / puzzleHeight;

    scaleArcsToImage(allPieceArcs, shift, scaleX, scaleY);

    const rectBorder: RectBorder = {
        xMin: 0, yMin: 0,
        xMax: imageSize.width, yMax: imageSize.height,
    };
    const pieceSubPaths = buildSubPaths(
        allPieceArcs, mainArcCount, isMateless, borderless, rectBorder,
    );

    const { subPathEdgeIds, arcToEdgeId } = allocateEdgeIds(pieceSubPaths);

    const pieces: GeneratedPiece[] = [];
    for (let pi = 0; pi < pieceSubPaths.length; pi++) {
        const piece = buildPiece(
            pi,
            pieceSubPaths[pi],
            subPathEdgeIds[pi],
            allPieceArcs,
            arcIndex,
            arcKeys,
            arcToEdgeId,
            scaleX,
            scaleY,
        );
        if (piece) pieces.push(piece);
    }
    return pieces;
}

/**
 * Pre-build a Set per piece so addArcs's sibling-key probes are O(1), not O(n).
 */
function buildMainContourArcs(
    fractalPieces: DiagonalConnection[][],
    rad: number,
    frameOffset: number,
): ArcData[][] {
    const allPieceArcs: ArcData[][] = [];
    for (const p of fractalPieces) {
        const arcs: ArcData[] = [];
        const connectionSet = new Set<string>();
        for (const c of p) connectionSet.add(connectionKey(c));
        addArcs(p[0], connectionSet, arcs, rad, frameOffset, true);
        allPieceArcs.push(arcs);
    }
    return allPieceArcs;
}

/**
 * Find cells addArcs missed (gaps from fillEmptyCells) and assign each to the
 * neighbouring piece whose concave arc borders it; fall back to the connection's
 * own piece when no concave arc claims the border.
 */
function computeGapFills(
    allPieceArcs: ArcData[][],
    fractalPieces: DiagonalConnection[][],
    rad: number,
    frameOffset: number,
): Map<number, Array<{ cellX: number; cellY: number }>> {
    // A convex arc (sign=1) at tile (tx,ty) quad q covers the adjacent cell
    // (offsets in the switch below).
    const coveredCells = new Set<string>();
    for (const arcs of allPieceArcs) {
        for (const a of arcs) {
            if (a.sign !== 1) continue;
            const tx = Math.round((a.cx - rad - frameOffset) / (2 * rad));
            const ty = Math.round((a.cy - rad - frameOffset) / (2 * rad));
            let cx: number, cy: number;
            switch (a.quad) {
                case 0: cx = tx; cy = ty - 1; break;
                case 1: cx = tx - 1; cy = ty - 1; break;
                case 2: cx = tx - 1; cy = ty; break;
                case 3: cx = tx; cy = ty; break;
                default: continue;
            }
            coveredCells.add(`${cx},${cy}`);
        }
    }

    // Cell (cx,cy) is bordered by concave arcs at:
    //   tile(cx,cy) q=3, tile(cx+1,cy) q=2, tile(cx,cy+1) q=0, tile(cx+1,cy+1) q=1
    const concaveArcOwner = new Map<string, number>(); // key "tx,ty,q" → pieceIdx
    for (let pi = 0; pi < allPieceArcs.length; pi++) {
        for (const a of allPieceArcs[pi]) {
            if (a.sign !== 0) continue;
            const tx = Math.round((a.cx - rad - frameOffset) / (2 * rad));
            const ty = Math.round((a.cy - rad - frameOffset) / (2 * rad));
            concaveArcOwner.set(`${tx},${ty},${a.quad}`, pi);
        }
    }

    const gapFills = new Map<number, Array<{ cellX: number; cellY: number }>>();
    for (let pi = 0; pi < fractalPieces.length; pi++) {
        for (const con of fractalPieces[pi]) {
            const key = `${con.cell.x},${con.cell.y}`;
            if (coveredCells.has(key)) continue;

            const cx = con.cell.x;
            const cy = con.cell.y;
            const borderArcs = [
                `${cx},${cy},3`,
                `${cx + 1},${cy},2`,
                `${cx},${cy + 1},0`,
                `${cx + 1},${cy + 1},1`,
            ];

            let owner = pi;
            for (const arcKey of borderArcs) {
                const arcOwner = concaveArcOwner.get(arcKey);
                if (arcOwner !== undefined) {
                    owner = arcOwner;
                    break;
                }
            }

            if (!gapFills.has(owner)) gapFills.set(owner, []);
            gapFills.get(owner)!.push({ cellX: cx, cellY: cy });
            coveredCells.add(key);
        }
    }
    return gapFills;
}

/**
 * Append four convex arcs per gap cell to the owner piece. Each side uses sign=1
 * so it traverses the same geometric arc as the neighbouring concave arc but in
 * the opposite direction — matching the start↔end invariant merge-detection
 * expects of a mate pair. Sides are ordered right→top→left→bottom to chain into
 * a closed loop.
 */
function appendDiamondFillerArcs(
    allPieceArcs: ArcData[][],
    gapFills: Map<number, Array<{ cellX: number; cellY: number }>>,
    rad: number,
    frameOffset: number,
): void {
    for (const [owner, gaps] of gapFills) {
        for (const { cellX, cellY } of gaps) {
            const sides: Array<{ tile: Tile; quad: number }> = [
                { tile: makeTile(cellX + 1, cellY), quad: 2 },
                { tile: makeTile(cellX, cellY), quad: 3 },
                { tile: makeTile(cellX, cellY + 1), quad: 0 },
                { tile: makeTile(cellX + 1, cellY + 1), quad: 1 },
            ];
            for (const { tile, quad } of sides) {
                allPieceArcs[owner].push(
                    makeArc(tile, rad, frameOffset, quad, 1),
                );
            }
        }
    }
}

/**
 * Append four concave arcs per orphan disc to its owner piece. The orphan tile
 * has no diagonal, so addArcs never visits it; the owner (a neighbour whose
 * diagonal occupies an adjacent cell) gets the disc as an extra closed sub-path.
 * Ordering q=0..3 with sign=0 chains right→top→left→bottom into a loop. Mates
 * resolve through the arc index — 1–2 self-mate with the owner's convex arcs,
 * the rest sit on the outer border.
 */
function appendOrphanDiscArcs(
    allPieceArcs: ArcData[][],
    orphanDiscs: Array<{ tile: Tile; ownerPieceIdx: number }>,
    rad: number,
    frameOffset: number,
): void {
    for (const { tile, ownerPieceIdx } of orphanDiscs) {
        for (let q = 0; q < 4; q++) {
            allPieceArcs[ownerPieceIdx].push(
                makeArc(tile, rad, frameOffset, q, 0),
            );
        }
    }
}

/**
 * Index arcs by (cx,cy,quad) for mate lookup. Built BEFORE scaling so keys use
 * abstract coordinates. Returns the index plus a parallel `arcKeys[pi][ai]`
 * table used by the mateless check and later mate resolution in `buildPiece`.
 */
function buildArcIndex(allPieceArcs: ArcData[][]): {
    arcIndex: ArcIndex;
    arcKeys: string[][];
} {
    const arcIndex: ArcIndex = new Map();
    const arcKeys: string[][] = [];
    for (let pi = 0; pi < allPieceArcs.length; pi++) {
        const arcs = allPieceArcs[pi];
        arcKeys[pi] = [];
        for (let ai = 0; ai < arcs.length; ai++) {
            const a = arcs[ai];
            const key = `${a.cx},${a.cy},${a.quad}`;
            arcKeys[pi][ai] = key;
            let list = arcIndex.get(key);
            if (!list) {
                list = [];
                arcIndex.set(key, list);
            }
            list.push({ pieceIdx: pi, arcIdx: ai });
        }
    }
    return { arcIndex, arcKeys };
}

/**
 * A mateless arc's (cx,cy,quad) key has no other arc at the same location — it
 * sits on the outer border. Non-borderless mode replaces these with straight
 * lines along the trimmed rectangle.
 */
function markMatelessArcs(
    arcIndex: ArcIndex,
    arcKeys: string[][],
): boolean[][] {
    return arcKeys.map(keys =>
        keys.map(key => (arcIndex.get(key) ?? []).length === 1),
    );
}

/**
 * Scale/translate arcs so the puzzle fills the image, mutating sx/sy/ex/ey/cx/cy
 * in place. Radii stay in abstract coordinates and are scaled per-axis at draw time.
 */
function scaleArcsToImage(
    allPieceArcs: ArcData[][],
    shift: number,
    scaleX: number,
    scaleY: number,
): void {
    for (const arcs of allPieceArcs) {
        for (const a of arcs) {
            a.sx = (a.sx - shift) * scaleX;
            a.ex = (a.ex - shift) * scaleX;
            a.cx = (a.cx - shift) * scaleX;
            a.sy = (a.sy - shift) * scaleY;
            a.ey = (a.ey - shift) * scaleY;
            a.cy = (a.cy - shift) * scaleY;
        }
    }
}

/**
 * Emit drawable ops per sub-path: one main contour (if any), then each 4-arc
 * extra (diamond filler or orphan disc) as its own closed sub-path. Non-borderless
 * mode collapses runs of mateless arcs into straight border lines; sub-paths that
 * wrap the seam are rotated so the first arc is non-mateless, and sub-paths fully
 * outside the trimmed rectangle are dropped.
 */
function buildSubPaths(
    allPieceArcs: ArcData[][],
    mainArcCount: number[],
    isMateless: boolean[][],
    borderless: boolean,
    rectBorder: RectBorder,
): Op[][][] {
    const pieceSubPaths: Op[][][] = allPieceArcs.map(() => []);

    for (let pi = 0; pi < allPieceArcs.length; pi++) {
        const arcs = allPieceArcs[pi];
        if (arcs.length === 0) continue;

        const ranges: Array<[number, number]> = [];
        if (mainArcCount[pi] > 0) ranges.push([0, mainArcCount[pi]]);
        for (let k = mainArcCount[pi]; k < arcs.length; k += 4) {
            ranges.push([k, k + 4]);
        }

        for (const [spStart, spEnd] of ranges) {
            const n = spEnd - spStart;

            if (borderless) {
                // Keep every arc — border arcs stay curved, so border pieces look
                // like interior ones.
                const subOps: Op[] = [];
                for (let i = 0; i < n; i++) {
                    subOps.push({ type: 'arc', pieceIdx: pi, arcIdx: spStart + i });
                }
                pieceSubPaths[pi].push(subOps);
                continue;
            }

            // Rotate so the first arc is non-mateless; otherwise a run wrapping
            // the seam splits in two and its leading line starts outside the
            // trimmed rectangle.
            let rot = 0;
            while (rot < n && isMateless[pi][spStart + rot]) rot++;
            if (rot === n) continue; // fully outside trimmed rectangle

            const subOps: Op[] = [];
            let i = 0;
            while (i < n) {
                const ai = spStart + ((i + rot) % n);
                if (!isMateless[pi][ai]) {
                    subOps.push({ type: 'arc', pieceIdx: pi, arcIdx: ai });
                    i++;
                    continue;
                }
                let j = i;
                while (j < n && isMateless[pi][spStart + ((j + rot) % n)]) j++;
                const firstAi = spStart + ((i + rot) % n);
                const lastAi = spStart + ((j - 1 + rot) % n);
                const runStart = allPieceArcs[pi][firstAi];
                const runEnd = allPieceArcs[pi][lastAi];
                for (const ln of borderPathBetween(
                    runStart.sx, runStart.sy, runEnd.ex, runEnd.ey, rectBorder,
                )) {
                    subOps.push({ type: 'line', ...ln });
                }
                i = j;
            }

            pieceSubPaths[pi].push(subOps);
        }
    }

    return pieceSubPaths;
}

/**
 * Allocate edge IDs in sub-path order per piece, recording an arc → edge-id map
 * so arc-to-arc mate relationships carry into the final Edge[] when a mate looks
 * up the same (pieceIdx, arcIdx) during assembly.
 */
function allocateEdgeIds(pieceSubPaths: Op[][][]): {
    subPathEdgeIds: number[][][];
    arcToEdgeId: Map<string, number>;
} {
    let nextEdgeId = 0;
    const arcToEdgeId = new Map<string, number>();
    const subPathEdgeIds: number[][][] = pieceSubPaths.map(sps =>
        sps.map(ops => ops.map(op => {
            const edgeId = nextEdgeId++;
            if (op.type === 'arc') {
                arcToEdgeId.set(`${op.pieceIdx},${op.arcIdx}`, edgeId);
            }
            return edgeId;
        })),
    );
    return { subPathEdgeIds, arcToEdgeId };
}

/**
 * Returns null when the piece has no sub-paths (fully trimmed in non-borderless).
 */
function buildPiece(
    pieceIdx: number,
    subPaths: Op[][],
    edgeIds: number[][],
    allPieceArcs: ArcData[][],
    arcIndex: ArcIndex,
    arcKeys: string[][],
    arcToEdgeId: Map<string, number>,
    scaleX: number,
    scaleY: number,
): GeneratedPiece | null {
    if (subPaths.length === 0) return null;

    let minX = Infinity, minY = Infinity;
    for (const sp of subPaths) {
        for (const op of sp) {
            if (op.type === 'arc') {
                const a = allPieceArcs[op.pieceIdx][op.arcIdx];
                minX = Math.min(minX, a.sx, a.ex);
                minY = Math.min(minY, a.sy, a.ey);
            } else {
                minX = Math.min(minX, op.sx, op.ex);
                minY = Math.min(minY, op.sy, op.ey);
            }
        }
    }

    const edges: Edge[] = [];
    const shapeParts: string[] = [];

    for (let spi = 0; spi < subPaths.length; spi++) {
        const sp = subPaths[spi];
        const spEdgeIds = edgeIds[spi];

        for (let oi = 0; oi < sp.length; oi++) {
            const op = sp[oi];
            const edgeId = spEdgeIds[oi];
            let sx: number, sy: number, ex: number, ey: number;
            let path: string;
            let mateEdgeId = -1;
            let matePieceId = -1;

            if (op.type === 'arc') {
                const a = allPieceArcs[op.pieceIdx][op.arcIdx];
                sx = a.sx; sy = a.sy; ex = a.ex; ey = a.ey;
                const rx = a.r * scaleX;
                const ry = a.r * scaleY;
                path = `A ${fmt(rx)} ${fmt(ry)} 0 0,${a.sign} ${fmt(ex - minX)} ${fmt(ey - minY)}`;

                const key = arcKeys[op.pieceIdx][op.arcIdx];
                const candidates = arcIndex.get(key) ?? [];
                for (const c of candidates) {
                    if (c.pieceIdx === op.pieceIdx && c.arcIdx === op.arcIdx) continue;
                    const mateId = arcToEdgeId.get(`${c.pieceIdx},${c.arcIdx}`);
                    if (mateId !== undefined) {
                        mateEdgeId = mateId;
                        matePieceId = c.pieceIdx;
                        break;
                    }
                }
            } else {
                sx = op.sx; sy = op.sy; ex = op.ex; ey = op.ey;
                path = `L ${fmt(ex - minX)} ${fmt(ey - minY)}`;
            }

            if (oi === 0) {
                shapeParts.push(`M ${fmt(sx - minX)} ${fmt(sy - minY)}`);
            }
            shapeParts.push(path);
            if (oi === sp.length - 1) {
                shapeParts.push('Z');
            }

            edges.push({
                id: edgeId,
                mateEdgeId,
                matePieceId,
                path,
                start: { x: sx - minX, y: sy - minY },
                end: { x: ex - minX, y: ey - minY },
            });
        }
    }

    return {
        id: pieceIdx,
        edges,
        shape: shapeParts.join(' '),
        imageOffset: { x: -minX, y: -minY },
    };
}

/**
 * Walk the rectangle boundary from (px,py) to (qx,qy); both must already lie on
 * the boundary. Returns one segment when they share a side, or two (through the
 * shared corner) otherwise. Replaces runs of mateless arcs in a trimmed sub-path.
 */
function borderPathBetween(
    px: number, py: number, qx: number, qy: number,
    rect: RectBorder,
): Array<{ sx: number; sy: number; ex: number; ey: number }> {
    const eps = 1e-6;
    const onTop = (_x: number, y: number) => Math.abs(y - rect.yMin) < eps;
    const onBottom = (_x: number, y: number) => Math.abs(y - rect.yMax) < eps;
    const onLeft = (x: number, _y: number) => Math.abs(x - rect.xMin) < eps;
    const onRight = (x: number, _y: number) => Math.abs(x - rect.xMax) < eps;

    // Which border side each endpoint lies on. A corner point is on two sides —
    // pick the one matching the other point, else fall through to corner-bridging.
    const pSides = [
        ...(onTop(px, py) ? ['top'] : []),
        ...(onBottom(px, py) ? ['bottom'] : []),
        ...(onLeft(px, py) ? ['left'] : []),
        ...(onRight(px, py) ? ['right'] : []),
    ];
    const qSides = [
        ...(onTop(qx, qy) ? ['top'] : []),
        ...(onBottom(qx, qy) ? ['bottom'] : []),
        ...(onLeft(qx, qy) ? ['left'] : []),
        ...(onRight(qx, qy) ? ['right'] : []),
    ];

    const shared = pSides.find(s => qSides.includes(s));
    if (shared) {
        return [{ sx: px, sy: py, ex: qx, ey: qy }];
    }

    const corners: Array<[string, string, number, number]> = [
        ['top', 'left', rect.xMin, rect.yMin],
        ['top', 'right', rect.xMax, rect.yMin],
        ['bottom', 'left', rect.xMin, rect.yMax],
        ['bottom', 'right', rect.xMax, rect.yMax],
    ];
    for (const [s1, s2, cx, cy] of corners) {
        const match =
            (pSides.includes(s1) && qSides.includes(s2))
            || (pSides.includes(s2) && qSides.includes(s1));
        if (match) {
            return [
                { sx: px, sy: py, ex: cx, ey: cy },
                { sx: cx, sy: cy, ex: qx, ey: qy },
            ];
        }
    }

    // Fallback: endpoints on opposite sides or off the boundary — shouldn't happen
    // for well-formed sub-paths; draw a direct line rather than fail.
    return [{ sx: px, sy: py, ex: qx, ey: qy }];
}
