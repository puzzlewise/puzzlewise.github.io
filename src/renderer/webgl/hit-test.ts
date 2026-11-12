import type { Point } from '../../model/types.js';
import { insideEvenOdd } from './piece-mesh.js';
import {
    TRANSFORM_COS,
    TRANSFORM_SIN,
    TRANSFORM_STRIDE,
    TRANSFORM_TX,
    TRANSFORM_TY,
    type Scene,
} from './scene.js';

/** Returns the id of the piece under `screen`, topmost group first. */
export function hitTest(
    scene: Scene,
    screen: Point,
    viewport: { scale: number; offsetX: number; offsetY: number },
): number | null {
    const worldX = (screen.x - viewport.offsetX) / viewport.scale;
    const worldY = (screen.y - viewport.offsetY) / viewport.scale;
    const transforms = scene.pieceTransforms();
    const order = scene.orderedGroupIds();
    for (let g = order.length - 1; g >= 0; g--) {
        const layout = scene.groupLayout(order[g]);
        for (let k = 0; k < layout.length; k++) {
            const pieceId = layout[k].id;
            const mesh = scene.meshFor(pieceId);
            const slot = scene.slotOfPiece(pieceId);
            if (!mesh || slot === undefined) continue;
            const base = slot * TRANSFORM_STRIDE;
            const dx = worldX - transforms[base + TRANSFORM_TX];
            const dy = worldY - transforms[base + TRANSFORM_TY];
            const cos = transforms[base + TRANSFORM_COS];
            const sin = transforms[base + TRANSFORM_SIN];
            const localX = cos * dx + sin * dy;
            const localY = -sin * dx + cos * dy;
            const { minX, minY, maxX, maxY } = mesh.bounds;
            if (localX < minX || localX > maxX || localY < minY || localY > maxY) continue;
            if (insideEvenOdd(mesh.loops, localX, localY)) return pieceId;
        }
    }
    return null;
}
