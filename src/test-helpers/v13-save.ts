import type {
    SerializedEdge,
    SerializedProgress,
    SerializedStaticState,
} from '../persistence/serialization.js';
import { buildShape } from '../model/build-shape.js';
import type { Edge, Point } from '../model/types.js';

function edge(id: number, path: string, start: Point, end: Point, mate: [number, number] = [-1, -1]): SerializedEdge {
    return { id, mateEdgeId: mate[0], matePieceId: mate[1], path, start, end };
}

/** Mate paths a v13 writer stored as-is: neither is the byte-exact reverse of its partner. */
export function v13StaticBlob(): SerializedStaticState {
    return {
        version: 13,
        imageUrl: 'img',
        imageSize: { width: 20, height: 10 },
        gridSize: { cols: 2, rows: 1 },
        pieces: [
            {
                id: 0,
                imageOffset: { x: 0, y: 0 },
                bounds: { minX: 0, minY: 0, maxX: 12, maxY: 10 },
                edges: [
                    edge(0, 'L 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
                    edge(1, 'C 12 3, 12 7, 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }, [5, 1]),
                    edge(2, 'L 0 10', { x: 10, y: 10 }, { x: 0, y: 10 }),
                    edge(3, 'L 0 0', { x: 0, y: 10 }, { x: 0, y: 0 }),
                ],
            },
            {
                id: 1,
                imageOffset: { x: -10, y: 0 },
                bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
                edges: [
                    edge(4, 'L 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
                    edge(6, 'L 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }),
                    edge(7, 'L 0 10', { x: 10, y: 10 }, { x: 0, y: 10 }),
                    edge(5, 'C 2.01 7 2 3 0 0.004', { x: 0, y: 10 }, { x: 0, y: 0 }, [1, 0]),
                ],
            },
        ],
    };
}

export function v13Progress(): SerializedProgress {
    return {
        version: 13,
        groups: [{ id: 0, pieces: [[0, { x: 0, y: 0 }], [1, { x: 10, y: 0 }]], position: { x: 0, y: 0 } }],
        completed: false,
    };
}

/**
 * 2×2 grid as a v13 writer left it: the vertical cuts' mates are 0.01 px
 * apart mid-cut, piece 0's path stops 0.5 px short of the center vertex,
 * pieces 1 and 3 hold that vertex 0.01 px lower than pieces 0 and 2, and
 * piece 0's unmated top edge stops short of the rim corner it shares with
 * its mated right edge, as the rim of a borderless puzzle did.
 */
export function v13GridBlob(): SerializedStaticState {
    return {
        version: 13,
        imageUrl: 'img',
        imageSize: { width: 20, height: 20 },
        gridSize: { cols: 2, rows: 2 },
        pieces: [
            {
                id: 0,
                imageOffset: { x: 0, y: 0 },
                bounds: { minX: 0, minY: 0, maxX: 11, maxY: 10 },
                edges: [
                    edge(0, 'L 9.7 0.3', { x: 0, y: 0 }, { x: 10, y: 0 }),
                    edge(1, 'L 11 5 L 9.5 10', { x: 10, y: 0 }, { x: 10, y: 10 }, [5, 1]),
                    edge(2, 'L 0 10', { x: 10, y: 10 }, { x: 0, y: 10 }, [9, 2]),
                    edge(3, 'L 0 0', { x: 0, y: 10 }, { x: 0, y: 0 }),
                ],
            },
            {
                id: 1,
                imageOffset: { x: -10, y: 0 },
                bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10.01 },
                edges: [
                    edge(4, 'L 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
                    edge(6, 'L 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }),
                    edge(7, 'L 0 10.01', { x: 10, y: 10 }, { x: 0, y: 10.01 }, [13, 3]),
                    edge(5, 'L 1.01 5 L 0 0', { x: 0, y: 10.01 }, { x: 0, y: 0 }, [1, 0]),
                ],
            },
            {
                id: 2,
                imageOffset: { x: 0, y: -10 },
                bounds: { minX: 0, minY: 0, maxX: 11, maxY: 10 },
                edges: [
                    edge(9, 'L 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }, [2, 0]),
                    edge(10, 'L 11 5 L 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }, [14, 3]),
                    edge(11, 'L 0 10', { x: 10, y: 10 }, { x: 0, y: 10 }),
                    edge(12, 'L 0 0', { x: 0, y: 10 }, { x: 0, y: 0 }),
                ],
            },
            {
                id: 3,
                imageOffset: { x: -10, y: -10 },
                bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
                edges: [
                    edge(13, 'L 10 0', { x: 0, y: 0.01 }, { x: 10, y: 0 }, [7, 1]),
                    edge(15, 'L 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }),
                    edge(16, 'L 0 10', { x: 10, y: 10 }, { x: 0, y: 10 }),
                    edge(14, 'L 1.01 5 L 0 0.01', { x: 0, y: 10 }, { x: 0, y: 0.01 }, [10, 2]),
                ],
            },
        ],
    };
}

export function v13GridProgress(): SerializedProgress {
    return {
        version: 14,
        groups: [{
            id: 0,
            pieces: [[0, { x: 0, y: 0 }], [1, { x: 10, y: 0 }], [2, { x: 0, y: 10 }], [3, { x: 10, y: 10 }]],
            position: { x: 0, y: 0 },
        }],
        completed: false,
    };
}

const UNROUNDED_GRID: Array<{ id: number; offset: Point; edges: Array<[number, Point[], [number, number]?]> }> = [
    { id: 0, offset: { x: 0.00314, y: 0.00271 }, edges: [
        [0, [{ x: 0, y: 0 }, { x: 10, y: 0 }]],
        [1, [{ x: 10, y: 0 }, { x: 11.004, y: 5.003 }, { x: 10, y: 10 }], [5, 1]],
        [2, [{ x: 10, y: 10 }, { x: 0, y: 10 }], [9, 2]],
        [3, [{ x: 0, y: 10 }, { x: 0, y: 0 }]],
    ] },
    { id: 1, offset: { x: -10.00418, y: 0.00123 }, edges: [
        [4, [{ x: 10, y: 0 }, { x: 20, y: 0 }]],
        [6, [{ x: 20, y: 0 }, { x: 20, y: 10 }]],
        [7, [{ x: 20, y: 10 }, { x: 10, y: 10 }], [13, 3]],
        [5, [{ x: 10, y: 10 }, { x: 11.004, y: 5.003 }, { x: 10, y: 0 }], [1, 0]],
    ] },
    { id: 2, offset: { x: -0.0001, y: -10.00351 }, edges: [
        [9, [{ x: 0, y: 10 }, { x: 10, y: 10 }], [2, 0]],
        [10, [{ x: 10, y: 10 }, { x: 11.005, y: 15.003 }, { x: 10, y: 20 }], [14, 3]],
        [11, [{ x: 10, y: 20 }, { x: 0, y: 20 }]],
        [12, [{ x: 0, y: 20 }, { x: 0, y: 10 }]],
    ] },
    { id: 3, offset: { x: -9.9949, y: -9.99558 }, edges: [
        [13, [{ x: 10, y: 10 }, { x: 20, y: 10 }], [7, 1]],
        [15, [{ x: 20, y: 10 }, { x: 20, y: 20 }]],
        [16, [{ x: 20, y: 20 }, { x: 10, y: 20 }]],
        [14, [{ x: 10, y: 20 }, { x: 11.005, y: 15.003 }, { x: 10, y: 10 }], [10, 2]],
    ] },
];

/**
 * 2×2 grid as a writer before geometry quantization (2026-07-25) left it:
 * `imageOffset` and `start`/`end` unrounded, each path rounded to 2 decimals
 * in its own piece's frame.
 */
export function v11UnroundedGridBlob(): SerializedStaticState {
    const local = (p: Point, offset: Point): Point => ({ x: p.x + offset.x, y: p.y + offset.y });
    return {
        version: 11,
        imageUrl: 'img',
        imageSize: { width: 20, height: 20 },
        gridSize: { cols: 2, rows: 2 },
        pieces: UNROUNDED_GRID.map(({ id, offset, edges }) => {
            const serialized = edges.map(([edgeId, points, mate]) => {
                const path = points.slice(1)
                    .map((p) => local(p, offset))
                    .map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
                    .join(' ');
                return edge(edgeId, path, local(points[0], offset), local(points.at(-1)!, offset), mate);
            });
            return { id, imageOffset: offset, edges: serialized, shape: buildShape(serialized as Edge[]) };
        }),
    };
}

/** One group, laid out the way merges on the unrounded geometry left it. */
export function v11UnroundedGridProgress(): SerializedProgress {
    return {
        version: 14,
        groups: [{
            id: 0,
            pieces: UNROUNDED_GRID.map(({ id, offset }) => [id, { x: -offset.x, y: -offset.y }]),
            position: { x: 0, y: 0 },
        }],
        completed: false,
    };
}
