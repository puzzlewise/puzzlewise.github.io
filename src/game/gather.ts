import type { Point, Piece, PieceGroup, Size } from '../model/types.js';
import { getGroupVisualBounds } from './group-bounds.js';

export const GATHER_PADDING = 50;

export const SPLIT_GATHER_GUTTER_PIECES = 3.5;

export interface WorldRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface GatherResult {
    /** Map of groupId → new world position. */
    positions: Map<number, Point>;
    /** Bounding box of the entire layout in world coordinates. */
    layoutBounds: { x: number; y: number; width: number; height: number };
}

/**
 * Uses each group's visual bounding box, so it handles classic and fractal
 * shapes. Does not mutate the groups; the caller should zoom-to-fit the
 * returned `layoutBounds`.
 */
export function computeGatheredPositions(
    groups: ReadonlyArray<Readonly<PieceGroup>>,
    screenAspectRatio: number,
    piecesById: ReadonlyMap<number, Readonly<Piece>>,
): GatherResult {
    const emptyResult: GatherResult = {
        positions: new Map(),
        layoutBounds: { x: 0, y: 0, width: 0, height: 0 },
    };

    if (groups.length === 0) {
        return emptyResult;
    }

    const margin = GATHER_PADDING;

    interface GroupLayout {
        group: PieceGroup;
        bounds: ReturnType<typeof getGroupVisualBounds>;
    }

    const layouts: GroupLayout[] = groups.map(group => ({
        group,
        bounds: getGroupVisualBounds(group, piecesById),
    }));

    // Shuffle so grid position doesn't correlate with solved position
    for (let i = layouts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [layouts[i], layouts[j]] = [layouts[j], layouts[i]];
    }

    // Sort by height descending for better row packing
    layouts.sort((a, b) => b.bounds.height - a.bounds.height);

    const aspectRatio = Math.max(0.1, screenAspectRatio);

    let maxGroupWidth = 0;
    let totalGroupWidth = 0;
    for (const layout of layouts) {
        maxGroupWidth = Math.max(maxGroupWidth, layout.bounds.width);
        totalGroupWidth += layout.bounds.width + margin;
    }

    const minWidth = maxGroupWidth + margin;
    const maxWidth = totalGroupWidth + margin;

    function packHeight(tw: number): number {
        let height = 0;
        let rowWidth = 0;
        let rowHeight = 0;
        let rowCount = 0;
        for (const layout of layouts) {
            const w = layout.bounds.width + margin;
            if (rowCount > 0 && rowWidth + w > tw) {
                height += rowHeight + margin;
                rowWidth = 0;
                rowHeight = 0;
                rowCount = 0;
            }
            rowWidth += w;
            rowHeight = Math.max(rowHeight, layout.bounds.height);
            rowCount++;
        }
        if (rowCount > 0) height += rowHeight;
        return height;
    }

    // Binary search: ~10 iterations gives <0.1% precision
    let lo = minWidth;
    let hi = maxWidth;
    for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        const h = packHeight(mid);
        if (h === 0) break;
        const ratio = mid / h;
        if (ratio < aspectRatio) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    const targetWidth = (lo + hi) / 2;

    const rows: Array<{ items: GroupLayout[]; rowHeight: number }> = [];
    let currentRow: GroupLayout[] = [];
    let currentRowWidth = 0;
    let currentRowHeight = 0;

    for (const layout of layouts) {
        const itemWidth = layout.bounds.width + margin;

        if (currentRow.length > 0 && currentRowWidth + itemWidth > targetWidth) {
            rows.push({ items: currentRow, rowHeight: currentRowHeight });
            currentRow = [];
            currentRowWidth = 0;
            currentRowHeight = 0;
        }

        currentRow.push(layout);
        currentRowWidth += itemWidth;
        currentRowHeight = Math.max(currentRowHeight, layout.bounds.height);
    }

    if (currentRow.length > 0) {
        rows.push({ items: currentRow, rowHeight: currentRowHeight });
    }

    let totalHeight = 0;
    let maxRowWidth = 0;
    for (const row of rows) {
        let rowWidth = 0;
        for (const layout of row.items) {
            rowWidth += layout.bounds.width + margin;
        }
        rowWidth -= margin;
        maxRowWidth = Math.max(maxRowWidth, rowWidth);
        totalHeight += row.rowHeight + margin;
    }
    totalHeight -= margin;

    // Centered at origin; the caller handles viewport positioning.
    const startX = -maxRowWidth / 2;
    const startY = -totalHeight / 2;

    const result = new Map<number, Point>();
    let y = startY;

    for (const row of rows) {
        let rowWidth = 0;
        for (const layout of row.items) {
            rowWidth += layout.bounds.width + margin;
        }
        rowWidth -= margin;

        let x = -rowWidth / 2;

        for (const layout of row.items) {
            const { group, bounds } = layout;

            result.set(group.id, {
                x: x - bounds.minX,
                y: y - bounds.minY,
            });

            x += bounds.width + margin;
        }

        y += row.rowHeight + margin;
    }

    return {
        positions: result,
        layoutBounds: {
            x: startX - margin,
            y: startY - margin,
            width: maxRowWidth + margin * 2,
            height: totalHeight + margin * 2,
        },
    };
}

export function splitGatherGutter(imageSize: Size, pieceCount: number): number {
    if (pieceCount <= 0) return 0;
    return SPLIT_GATHER_GUTTER_PIECES * Math.sqrt((imageSize.width * imageSize.height) / pieceCount);
}

/**
 * Each block gets the screen's aspect ratio on its own, so together they can't
 * fill the screen. Intended (#708): the player zooms into one block and works it.
 */
export function computeSplitGatheredPositions(
    groups: ReadonlyArray<Readonly<PieceGroup>>,
    selectedGroupIds: ReadonlySet<number>,
    screenAspectRatio: number,
    piecesById: ReadonlyMap<number, Readonly<Piece>>,
    gutter: number,
): GatherResult {
    const selected = groups.filter(group => selectedGroupIds.has(group.id));
    if (selected.length === 0 || selected.length === groups.length) {
        return computeGatheredPositions(groups, screenAspectRatio, piecesById);
    }
    const rest = groups.filter(group => !selectedGroupIds.has(group.id));

    const left = computeGatheredPositions(selected, screenAspectRatio, piecesById);
    const right = computeGatheredPositions(rest, screenAspectRatio, piecesById);

    const margin = GATHER_PADDING;
    const leftWidth = left.layoutBounds.width - 2 * margin;
    const rightWidth = right.layoutBounds.width - 2 * margin;
    const totalWidth = leftWidth + gutter + rightWidth;

    const positions = new Map<number, Point>();
    const place = (block: GatherResult, shiftX: number): void => {
        for (const [id, pos] of block.positions) {
            positions.set(id, { x: pos.x + shiftX, y: pos.y });
        }
    };
    place(left, (leftWidth - totalWidth) / 2);
    place(right, (totalWidth - rightWidth) / 2);

    const height = Math.max(left.layoutBounds.height, right.layoutBounds.height);

    return {
        positions,
        layoutBounds: {
            x: -totalWidth / 2 - margin,
            y: -height / 2,
            width: totalWidth + 2 * margin,
            height,
        },
    };
}

/** Mutates the groups in place. */
export function applyGatheredPositions(
    groups: PieceGroup[],
    positions: Map<number, Point>,
): void {
    for (const group of groups) {
        const newPos = positions.get(group.id);
        if (newPos) {
            group.position = { ...newPos };
        }
    }
}
