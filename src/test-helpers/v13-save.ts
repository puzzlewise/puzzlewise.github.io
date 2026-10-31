import type {
    SerializedEdge,
    SerializedProgress,
    SerializedStaticState,
} from '../persistence/serialization.js';
import type { Point } from '../model/types.js';

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
