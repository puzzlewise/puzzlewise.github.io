import type { ViewportValue } from './animation.js';
import { TRANSFORM_COS, TRANSFORM_SIN, TRANSFORM_STRIDE, TRANSFORM_TX, TRANSFORM_TY, type Scene } from './scene.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_HALF_WIDTH = 5;
const ARROW_HEIGHT = 7;
const ARROW_TIP_INSET = 4;

export interface DebugOverlay {
    update(scene: Scene, viewport: ViewportValue): void;
    setVisible(on: boolean): void;
    destroy(): void;
}

interface OverlayPiece {
    slot: number;
    element: SVGSVGElement;
    cos: number;
    sin: number;
    x: number;
    y: number;
}

function createPiece(pieceId: number, bounds: { minX: number; minY: number; maxX: number; maxY: number }): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '1');
    svg.setAttribute('height', '1');
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.overflow = 'visible';
    svg.style.transformOrigin = '0 0';

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(centerX));
    label.setAttribute('y', String(centerY));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'middle');
    label.setAttribute('font-size', '14');
    label.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
    label.setAttribute('fill', 'black');
    label.textContent = String(pieceId);
    label.dataset.debugLabel = 'true';

    const tipY = bounds.minY + ARROW_TIP_INSET;
    const baseY = tipY + ARROW_HEIGHT;
    const arrow = document.createElementNS(SVG_NS, 'path');
    arrow.setAttribute(
        'd',
        `M ${centerX} ${tipY} L ${centerX - ARROW_HALF_WIDTH} ${baseY} L ${centerX + ARROW_HALF_WIDTH} ${baseY} Z`,
    );
    arrow.setAttribute('fill', 'black');
    arrow.dataset.debugUp = 'true';

    svg.append(label, arrow);
    return svg;
}

export function createDebugOverlay(container: HTMLElement): DebugOverlay {
    const root = document.createElement('div');
    root.dataset.debugOverlay = 'true';
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    root.style.transformOrigin = '0 0';
    root.style.pointerEvents = 'none';
    container.appendChild(root);

    let current: Scene | null = null;
    let shown: ViewportValue | null = null;
    let visible = true;
    let pieces: OverlayPiece[] = [];

    const rebuild = (scene: Scene): void => {
        pieces = [];
        for (const groupId of scene.orderedGroupIds()) {
            for (const { id } of scene.groupLayout(groupId)) {
                const mesh = scene.meshFor(id);
                const slot = scene.slotOfPiece(id);
                if (!mesh || slot === undefined) continue;
                pieces.push({ slot, element: createPiece(id, mesh.bounds), cos: NaN, sin: NaN, x: NaN, y: NaN });
            }
        }
        root.replaceChildren(...pieces.map((piece) => piece.element));
        current = scene;
    };

    const clear = (): void => {
        root.replaceChildren();
        pieces = [];
        current = null;
    };

    return {
        update(scene, { scale, offsetX, offsetY }) {
            if (scene !== current) rebuild(scene);
            if (shown?.scale !== scale || shown.offsetX !== offsetX || shown.offsetY !== offsetY) {
                shown = { scale, offsetX, offsetY };
                root.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${offsetX}, ${offsetY})`;
            }
            const transforms = scene.pieceTransforms();
            for (const piece of pieces) {
                const base = piece.slot * TRANSFORM_STRIDE;
                const cos = transforms[base + TRANSFORM_COS];
                const sin = transforms[base + TRANSFORM_SIN];
                const x = transforms[base + TRANSFORM_TX];
                const y = transforms[base + TRANSFORM_TY];
                if (cos === piece.cos && sin === piece.sin && x === piece.x && y === piece.y) continue;
                piece.cos = cos;
                piece.sin = sin;
                piece.x = x;
                piece.y = y;
                piece.element.style.transform = `matrix(${cos}, ${sin}, ${-sin}, ${cos}, ${x}, ${y})`;
            }
        },
        setVisible(on) {
            if (on === visible) return;
            visible = on;
            root.style.display = on ? '' : 'none';
            if (!on) clear();
        },
        destroy() {
            root.remove();
            clear();
        },
    };
}
