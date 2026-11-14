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
    transform: string;
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
    label.dataset.pieceLabel = 'true';

    const tipY = bounds.minY + ARROW_TIP_INSET;
    const baseY = tipY + ARROW_HEIGHT;
    const arrow = document.createElementNS(SVG_NS, 'path');
    arrow.setAttribute(
        'd',
        `M ${centerX} ${tipY} L ${centerX - ARROW_HALF_WIDTH} ${baseY} L ${centerX + ARROW_HALF_WIDTH} ${baseY} Z`,
    );
    arrow.setAttribute('fill', 'black');
    arrow.dataset.pieceUp = 'true';

    svg.append(label, arrow);
    return svg;
}

export function createDebugOverlay(container: HTMLElement): DebugOverlay {
    const root = document.createElement('div');
    root.dataset.debugOverlay = 'true';
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    root.style.pointerEvents = 'none';
    container.appendChild(root);

    let current: Scene | null = null;
    let pieces: OverlayPiece[] = [];

    const rebuild = (scene: Scene): void => {
        pieces = [];
        for (const groupId of scene.orderedGroupIds()) {
            for (const { id } of scene.groupLayout(groupId)) {
                const mesh = scene.meshFor(id);
                const slot = scene.slotOfPiece(id);
                if (!mesh || slot === undefined) continue;
                pieces.push({ slot, element: createPiece(id, mesh.bounds), transform: '' });
            }
        }
        root.replaceChildren(...pieces.map((piece) => piece.element));
        current = scene;
    };

    return {
        update(scene, { scale, offsetX, offsetY }) {
            if (scene !== current) rebuild(scene);
            const transforms = scene.pieceTransforms();
            for (const piece of pieces) {
                const base = piece.slot * TRANSFORM_STRIDE;
                const cos = transforms[base + TRANSFORM_COS] * scale;
                const sin = transforms[base + TRANSFORM_SIN] * scale;
                const x = transforms[base + TRANSFORM_TX] * scale + offsetX;
                const y = transforms[base + TRANSFORM_TY] * scale + offsetY;
                const transform = `matrix(${cos}, ${sin}, ${-sin}, ${cos}, ${x}, ${y})`;
                if (transform === piece.transform) continue;
                piece.transform = transform;
                piece.element.style.transform = transform;
            }
        },
        setVisible(on) {
            root.style.display = on ? '' : 'none';
        },
        destroy() {
            root.remove();
            pieces = [];
            current = null;
        },
    };
}
