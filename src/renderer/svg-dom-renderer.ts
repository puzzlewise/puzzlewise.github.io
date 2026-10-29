/**
 * Coordinate system: pieces define shapes in piece-local coords (origin at the
 * top-left, before tabs extend beyond); `piece.imageOffset` positions the image
 * behind the clip-path; groups place pieces in world space via
 * `group.position + piece.groupOffset`.
 */

import { getPieceBounds } from '../model/derive.js';
import type { GameState, Piece, PieceGroup, Point } from '../model/types.js';
import { VIEWPORT_TRANSITION_MS, type Renderer } from './types.js';

/** Accommodates tabs that extend beyond the base piece rectangle. */
const PIECE_PADDING = 30;

/**
 * Exported for `app/viewport-fit.ts`, which spins the completed group in
 * lockstep with the viewport zoom via direct DOM. Sharing this string keeps the
 * easing and duration identical.
 */
export const VIEWPORT_TRANSITION = `transform ${VIEWPORT_TRANSITION_MS / 1000}s ease-in-out`;

/**
 * Single source of truth for the `translate(...) rotate(...)` string, so
 * outside callers (e.g. the completion spin) stay in sync with normal
 * rendering. `origin` is the rotation pivot in group-local space (CSS
 * `transform-origin`), defaulting to the group origin `(0, 0)`; pass a local
 * point (e.g. the puzzle center) to pivot elsewhere.
 */
export function applyGroupTransform(
    el: HTMLElement,
    position: Point,
    rotation: number,
    origin: Point = { x: 0, y: 0 },
): void {
    el.style.transformOrigin = `${origin.x}px ${origin.y}px`;
    el.style.transform =
        `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg)`;
}

interface PhotoSettle {
    promise: Promise<'loaded' | 'failed'>;
    watch(image: SVGImageElement): void;
}

/** Every piece's `<image>` shares one URL, so the first one stands for all. */
function createPhotoSettle(): PhotoSettle {
    let resolve!: (outcome: 'loaded' | 'failed') => void;
    const promise = new Promise<'loaded' | 'failed'>((r) => { resolve = r; });
    let watching = false;
    return {
        promise,
        watch(image) {
            if (watching) return;
            watching = true;
            image.addEventListener('load', () => resolve('loaded'), { once: true });
            image.addEventListener('error', () => resolve('failed'), { once: true });
        },
    };
}

export class SvgDomRenderer implements Renderer {
    private tableEl: HTMLElement | null = null;
    private groupElements = new Map<number, HTMLElement>();
    private pieceElements = new Map<number, SVGSVGElement>();
    private imageSize = { width: 0, height: 0 };
    private pieceBaseWidth = 0;
    private pieceBaseHeight = 0;
    private currentImageUrl: string | null = '';
    private photoSettle = createPhotoSettle();
    private currentPieceCount = -1;
    private currentShapeFingerprint = '';

    init(container: HTMLElement): void {
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        table.style.position = 'relative';
        table.style.width = '100%';
        table.style.height = '100%';
        table.style.overflow = 'visible';
        table.style.touchAction = 'none';
        table.style.transformOrigin = '0 0';
        container.appendChild(table);

        this.tableEl = table;
    }

    renderState(gameState: GameState): void {
        if (!this.tableEl) return;

        // Piece IDs restart at 0 each game, so a new game must invalidate all
        // cached SVG elements or stale ones get reused with wrong shapes.
        const pieceCount = gameState.pieces.length;
        const shapeFingerprint = gameState.pieces[0]?.shape ?? '';
        if (gameState.imageUrl !== this.currentImageUrl ||
            pieceCount !== this.currentPieceCount ||
            shapeFingerprint !== this.currentShapeFingerprint) {
            this.clearAllElements();
            this.photoSettle = createPhotoSettle();
            this.currentImageUrl = gameState.imageUrl;
            this.currentPieceCount = pieceCount;
            this.currentShapeFingerprint = shapeFingerprint;
        }

        this.imageSize = gameState.imageSize;
        this.pieceBaseWidth = this.imageSize.width / gameState.gridSize.cols;
        this.pieceBaseHeight = this.imageSize.height / gameState.gridSize.rows;

        const pieceLookup = new Map<number, Piece>();
        for (const piece of gameState.pieces) {
            pieceLookup.set(piece.id, piece);
        }

        const activeGroupIds = new Set<number>();

        for (const group of gameState.groups) {
            activeGroupIds.add(group.id);
            this.renderGroup(group, pieceLookup, gameState.imageUrl);
        }

        for (const [groupId, el] of this.groupElements) {
            if (!activeGroupIds.has(groupId)) {
                el.remove();
                this.groupElements.delete(groupId);
            }
        }

        const activePieceIds = new Set<number>();
        for (const group of gameState.groups) {
            for (const pieceId of group.pieces.keys()) {
                activePieceIds.add(pieceId);
            }
        }

        for (const [pieceId, el] of this.pieceElements) {
            if (!activePieceIds.has(pieceId)) {
                el.remove();
                this.pieceElements.delete(pieceId);
            }
        }
    }

    bringGroupToFront(groupId: number): void {
        const el = this.groupElements.get(groupId);
        if (el && this.tableEl) {
            this.tableEl.appendChild(el);
        }
    }

    setViewportTransform(scale: number, offsetX: number, offsetY: number): void {
        if (!this.tableEl) return;

        this.tableEl.style.transform =
            `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    }

    enableViewportTransition(): void {
        if (!this.tableEl) return;
        this.tableEl.style.transition = VIEWPORT_TRANSITION;
    }

    disableViewportTransition(): void {
        if (!this.tableEl) return;
        this.tableEl.style.transition = '';
    }

    setGroupDragging(groupId: number, dragging: boolean): void {
        const el = this.groupElements.get(groupId);
        if (!el) return;

        if (dragging) {
            el.classList.add('dragging');
        } else {
            el.classList.remove('dragging');
        }
    }

    setGroupSelected(groupId: number, selected: boolean): void {
        const el = this.groupElements.get(groupId);
        if (!el) return;

        if (selected) {
            el.classList.add('selected');
        } else {
            el.classList.remove('selected');
        }
    }

    flashMergePulse(groupId: number): void {
        const el = this.groupElements.get(groupId);
        if (!el) return;

        el.classList.remove('merge-pulse');
        // Force a reflow so re-adding the class restarts the animation.
        void el.offsetWidth;
        el.classList.add('merge-pulse');

        el.addEventListener(
            'animationend',
            () => el.classList.remove('merge-pulse'),
            { once: true },
        );
    }

    pieceIdFromTarget(target: EventTarget | null): number | null {
        if (!(target instanceof Element)) return null;
        const svg = target.closest('svg[data-piece-id]') as SVGElement | null;
        if (!svg) return null;
        const id = Number(svg.dataset.pieceId);
        return Number.isFinite(id) ? id : null;
    }

    pieceIdAtPoint(point: Point): number | null {
        // jsdom has no `elementFromPoint`; guard so hit-testing just finds
        // nothing there.
        if (typeof document.elementFromPoint !== 'function') return null;
        return this.pieceIdFromTarget(document.elementFromPoint(point.x, point.y));
    }

    photoSettled(): Promise<'loaded' | 'failed'> {
        return this.photoSettle.promise;
    }

    destroy(): void {
        if (this.tableEl) {
            this.tableEl.remove();
            this.tableEl = null;
        }

        this.groupElements.clear();
        this.pieceElements.clear();
    }

    private clearAllElements(): void {
        for (const el of this.groupElements.values()) {
            el.remove();
        }

        this.groupElements.clear();

        // Piece elements live inside the group containers, already removed above.
        this.pieceElements.clear();
    }

    private renderGroup(
        group: PieceGroup,
        pieceLookup: Map<number, Piece>,
        imageUrl: string | null,
    ): void {
        let groupEl = this.groupElements.get(group.id);

        if (!groupEl) {
            groupEl = document.createElement('div');
            groupEl.dataset.groupId = String(group.id);
            groupEl.style.position = 'absolute';
            groupEl.style.top = '0';
            groupEl.style.left = '0';
            groupEl.style.willChange = 'transform';
            this.tableEl!.appendChild(groupEl);
            this.groupElements.set(group.id, groupEl);
        }

        applyGroupTransform(groupEl, group.position, group.rotation);

        const expectedPieceIds = new Set(group.pieces.keys());

        for (const child of Array.from(groupEl.children)) {
            const pieceId = Number((child as HTMLElement).dataset.pieceId);

            if (!expectedPieceIds.has(pieceId)) {
                child.remove();
            }
        }

        for (const [pieceId, offset] of group.pieces) {
            const piece = pieceLookup.get(pieceId);
            if (!piece) continue;

            let svgEl = this.pieceElements.get(pieceId);

            if (!svgEl) {
                svgEl = this.createPieceSvg(piece, imageUrl);
                this.pieceElements.set(pieceId, svgEl);
            }

            if (svgEl.parentElement !== groupEl) {
                groupEl.appendChild(svgEl);
            }

            this.positionPiece(svgEl, offset);
        }
    }

    private createPieceSvg(piece: Piece, imageUrl: string | null): SVGSVGElement {
        const svgNS = 'http://www.w3.org/2000/svg';
        const xlinkNS = 'http://www.w3.org/1999/xlink';

        const svgWidth = this.pieceBaseWidth + PIECE_PADDING * 2;
        const svgHeight = this.pieceBaseHeight + PIECE_PADDING * 2;

        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', String(svgWidth));
        svg.setAttribute('height', String(svgHeight));
        svg.setAttribute(
            'viewBox',
            `${-PIECE_PADDING} ${-PIECE_PADDING} ${svgWidth} ${svgHeight}`,
        );
        svg.style.position = 'absolute';
        svg.style.overflow = 'visible';
        svg.dataset.pieceId = String(piece.id);

        if (imageUrl === null) {
            const fill = document.createElementNS(svgNS, 'path');
            fill.setAttribute('d', piece.shape);
            fill.setAttribute('fill-rule', 'evenodd');
            fill.setAttribute('pointer-events', 'none');
            fill.dataset.pieceBlank = 'true';
            svg.appendChild(fill);
        } else {
            // Clip only needed on the image arm — the blank arm fills the shape
            // directly, and an unused clip would duplicate `piece.shape` per piece.
            const defs = document.createElementNS(svgNS, 'defs');
            const clipPath = document.createElementNS(svgNS, 'clipPath');
            clipPath.setAttribute('id', `clip-piece-${piece.id}`);

            const path = document.createElementNS(svgNS, 'path');
            path.setAttribute('d', piece.shape);
            path.setAttribute('fill-rule', 'evenodd');
            clipPath.appendChild(path);
            defs.appendChild(clipPath);
            svg.appendChild(defs);

            // `slice` (preserveAspectRatio below) covers the puzzle rect and
            // crops excess, so a puzzle whose aspect ratio differs from the
            // image (fractal tile grid) is cropped uniformly, not stretched.
            const image = document.createElementNS(svgNS, 'image');
            image.setAttributeNS(xlinkNS, 'href', imageUrl);
            image.setAttribute('width', String(this.imageSize.width));
            image.setAttribute('height', String(this.imageSize.height));
            image.setAttribute('x', String(piece.imageOffset.x));
            image.setAttribute('y', String(piece.imageOffset.y));
            image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
            image.setAttribute('clip-path', `url(#clip-piece-${piece.id})`);
            image.setAttribute('draggable', 'false');
            image.setAttribute('pointer-events', 'none');
            this.photoSettle.watch(image);
            svg.appendChild(image);
        }

        // Transparent hit-area shaped to the outline, so pointer events fire
        // only inside the piece, not its SVG bounding box. Near-misses are
        // rescued by the screen-space probe (`interaction/hit-probe.ts`), so no
        // widened hit stroke is needed.
        const hitArea = document.createElementNS(svgNS, 'path');
        hitArea.setAttribute('d', piece.shape);
        hitArea.setAttribute('fill', 'rgba(0,0,0,0)');
        hitArea.setAttribute('stroke', 'none');
        hitArea.setAttribute('fill-rule', 'evenodd');
        hitArea.setAttribute('pointer-events', 'fill');
        hitArea.dataset.hitArea = 'true';
        svg.appendChild(hitArea);

        // Debug overlay: mateless edge strokes, toggled via .show-mateless-edges on <html>.
        for (const edge of piece.edges) {
            if (edge.mateEdgeId !== -1) continue;
            const edgePath = document.createElementNS(svgNS, 'path');
            edgePath.setAttribute(
                'd',
                `M ${edge.start.x} ${edge.start.y} ${edge.path}`,
            );
            edgePath.setAttribute('fill', 'none');
            edgePath.setAttribute('stroke', '#FF69B4');
            edgePath.setAttribute('stroke-width', '2');
            edgePath.setAttribute('pointer-events', 'none');
            edgePath.dataset.matelessEdge = 'true';
            svg.appendChild(edgePath);
        }

        // Hidden by default; toggled via .show-debug-pieces.
        this.appendDebugPieceOverlay(svg, piece);

        // Only the hit-area paths should respond to pointer events.
        svg.style.pointerEvents = 'none';

        return svg;
    }

    private positionPiece(svgEl: SVGSVGElement, offset: Point): void {
        svgEl.style.left = `${offset.x - PIECE_PADDING}px`;
        svgEl.style.top = `${offset.y - PIECE_PADDING}px`;
    }

    /**
     * Always in the DOM so the toggle can flip them instantly without
     * re-rendering. Defaults to hidden via CSS.
     */
    private appendDebugPieceOverlay(svg: SVGSVGElement, piece: Piece): void {
        const svgNS = 'http://www.w3.org/2000/svg';

        const fillPath = document.createElementNS(svgNS, 'path');
        fillPath.setAttribute('d', piece.shape);
        fillPath.setAttribute('fill', 'white');
        fillPath.setAttribute('fill-rule', 'evenodd');
        fillPath.setAttribute('stroke', 'black');
        fillPath.setAttribute('stroke-width', '1');
        fillPath.setAttribute('pointer-events', 'none');
        fillPath.dataset.pieceFill = 'true';
        svg.appendChild(fillPath);

        const { minX, minY, maxX, maxY } = getPieceBounds(piece);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const label = document.createElementNS(svgNS, 'text');
        label.setAttribute('x', String(centerX));
        label.setAttribute('y', String(centerY));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'middle');
        label.setAttribute('font-size', '14');
        label.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
        label.setAttribute('fill', 'black');
        label.setAttribute('pointer-events', 'none');
        label.textContent = String(piece.id);
        label.dataset.pieceLabel = 'true';
        svg.appendChild(label);

        // Piece-local space, so group rotation carries it — always points at original "up".
        const arrowHalf = 5;
        const arrowHeight = 7;
        const arrowTipY = minY + 4;
        const arrowBaseY = arrowTipY + arrowHeight;
        const arrow = document.createElementNS(svgNS, 'path');
        arrow.setAttribute(
            'd',
            `M ${centerX} ${arrowTipY}` +
                ` L ${centerX - arrowHalf} ${arrowBaseY}` +
                ` L ${centerX + arrowHalf} ${arrowBaseY} Z`,
        );
        arrow.setAttribute('fill', 'black');
        arrow.setAttribute('pointer-events', 'none');
        arrow.dataset.pieceUp = 'true';
        svg.appendChild(arrow);
    }
}
