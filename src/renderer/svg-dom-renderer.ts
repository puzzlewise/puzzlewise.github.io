/**
 * Coordinate system: pieces define shapes in piece-local coords (origin at the
 * top-left, before tabs extend beyond); `piece.imageOffset` positions the image
 * behind the clip-path; groups place pieces in world space via
 * `group.position + piece.groupOffset`.
 */

import { edgePathD } from '../model/build-shape.js';
import { getPieceBounds } from '../model/derive.js';
import type { GameState, Piece, PieceGroup, Point } from '../model/types.js';
import { groupOutlinePath } from './group-outline.js';
import { PathDataError, translatePath } from './translate-path.js';
import { VIEWPORT_TRANSITION_MS, type Renderer } from './types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

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

/**
 * On phones, `will-change: transform` group layers kept their zoomed-in scale
 * after zooming out, ran out of GPU memory and stopped rendering (#680).
 * Dropping the hint for one frame once a zoom-out has been still this long
 * rebuilds them at the current scale.
 */
export const RELAYER_IDLE_MS = 200;

/** Paint order, bottom to top: selection rings must cover lift rings. */
export const RING_NAMES = [
    'edge-1', 'edge-2', 'edge-3',
    'lift-1', 'lift-2', 'lift-3',
    'completion-shadow', 'completion-1', 'completion-2',
    'glow-1', 'glow-2', 'glow-3',
] as const;

/**
 * Full never shows the rings, and a `<use>` with an `href` builds its clone
 * tree even while hidden, so rings reference the edges only under Simple.
 */
function syncRingReferences(groupEl: HTMLElement, groupId: number, enabled: boolean): void {
    for (const ring of groupEl.querySelectorAll(':scope > svg[data-outline-underlay] > use[data-ring]')) {
        if (enabled) ring.setAttribute('href', `#group-edges-${groupId}`);
        else ring.removeAttribute('href');
    }
}

function groupClipPathD(group: PieceGroup, pieceLookup: Map<number, Piece>): string {
    try {
        return groupOutlinePath(group.pieces, pieceLookup) ?? [...group.pieces]
            .flatMap(([pieceId, offset]) => {
                const piece = pieceLookup.get(pieceId);
                return piece ? [translatePath(piece.shape, offset.x, offset.y)] : [];
            })
            .join(' ');
    } catch (error) {
        if (!(error instanceof PathDataError)) throw error;
        return '';
    }
}

function createInnerOutline(groupId: number): SVGSVGElement {
    const clipId = `inner-outline-clip-${groupId}`;
    const clipPath = document.createElementNS(SVG_NS, 'clipPath');
    clipPath.id = clipId;
    clipPath.appendChild(document.createElementNS(SVG_NS, 'path'));
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.appendChild(clipPath);

    const edges = document.createElementNS(SVG_NS, 'use');
    edges.setAttribute('href', `#group-edges-${groupId}`);
    edges.setAttribute('clip-path', `url(#${clipId})`);

    const overlay = document.createElementNS(SVG_NS, 'svg');
    overlay.setAttribute('data-inner-outline', '');
    overlay.setAttribute('width', '1');
    overlay.setAttribute('height', '1');
    overlay.append(defs, edges);
    return overlay;
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
    private viewportScale: number | null = null;
    private maxScaleSinceRelayer = 0;
    private relayerTimer: ReturnType<typeof setTimeout> | null = null;
    private transitionActive = false;
    private settleAfterTransition = false;
    private ringsEnabled = false;
    private innerOutlineEnabled = false;

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

        this.tableEl.toggleAttribute('data-outline-inside', this.innerOutlineEnabled);
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

        if (scale === this.viewportScale) return;
        this.viewportScale = scale;
        this.maxScaleSinceRelayer = Math.max(this.maxScaleSinceRelayer, scale);
        if (this.relayerTimer !== null) clearTimeout(this.relayerTimer);
        this.relayerTimer = setTimeout(() => {
            this.relayerTimer = null;
            if (this.transitionActive) this.settleAfterTransition = true;
            else this.settleZoom();
        }, RELAYER_IDLE_MS);
    }

    enableViewportTransition(): void {
        if (!this.tableEl) return;
        this.tableEl.style.transition = VIEWPORT_TRANSITION;
        this.transitionActive = true;
    }

    disableViewportTransition(): void {
        if (!this.tableEl) return;
        this.tableEl.style.transition = '';
        this.transitionActive = false;
        if (this.settleAfterTransition) {
            this.settleAfterTransition = false;
            this.settleZoom();
        }
    }

    /** Once per settled zoom, not per frame: the width change restyles every outline path. */
    private settleZoom(): void {
        if (this.viewportScale !== null) {
            this.tableEl?.style.setProperty('--outline-zoom-comp', String(1 / this.viewportScale));
        }
        this.relayerIfZoomedOut();
    }

    private relayerIfZoomedOut(): void {
        const table = this.tableEl;
        const scale = this.viewportScale;
        if (!table || scale === null || scale >= this.maxScaleSinceRelayer) return;
        this.maxScaleSinceRelayer = scale;
        table.classList.add('relayer');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => table.classList.remove('relayer'));
        });
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

    prefetchPhoto(url: string): void {
        new Image().src = url;
    }

    setRingsEnabled(enabled: boolean): void {
        this.ringsEnabled = enabled;
        for (const [groupId, groupEl] of this.groupElements) {
            syncRingReferences(groupEl, groupId, enabled);
        }
    }

    setInnerOutlineEnabled(enabled: boolean): void {
        this.innerOutlineEnabled = enabled;
    }

    destroy(): void {
        if (this.relayerTimer !== null) clearTimeout(this.relayerTimer);
        this.relayerTimer = null;
        this.settleAfterTransition = false;

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
            this.tableEl!.appendChild(groupEl);
            this.groupElements.set(group.id, groupEl);
        }

        applyGroupTransform(groupEl, group.position, group.rotation);

        const expectedPieceIds = new Set(group.pieces.keys());

        for (const child of Array.from(groupEl.children)) {
            if (!child.hasAttribute('data-piece-id')) continue;
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

        const layoutKey = [...group.pieces]
            .map(([pieceId, offset]) => `${pieceId}:${offset.x},${offset.y}`)
            .sort()
            .join(' ');
        const underlay = this.syncOutlineUnderlay(groupEl, group, pieceLookup, layoutKey);
        let outlineD: string | undefined;
        const outline = (): string => (outlineD ??= groupClipPathD(group, pieceLookup));
        this.syncSeamFill(groupEl, underlay, group, pieceLookup, imageUrl, layoutKey, outline);
        this.syncInnerOutline(groupEl, group.id, layoutKey, outline);
    }

    /**
     * SVG strokes can't be aligned inside a path, so the inner outline is the
     * underlay's centered stroke drawn above the pieces and clipped to the
     * group, keeping only its inner half (#722).
     */
    private syncInnerOutline(
        groupEl: HTMLElement,
        groupId: number,
        layoutKey: string,
        outline: () => string,
    ): void {
        let overlay = groupEl.querySelector<SVGSVGElement>(':scope > svg[data-inner-outline]');
        if (!this.innerOutlineEnabled) {
            overlay?.remove();
            return;
        }
        overlay ??= createInnerOutline(groupId);
        if (groupEl.lastElementChild !== overlay) groupEl.appendChild(overlay);

        if (overlay.dataset.pieces === layoutKey) return;
        overlay.dataset.pieces = layoutKey;
        overlay.querySelector('clipPath > path')!.setAttribute('d', outline());
    }

    /** Edges between pieces of the same group are left out so joins stay seamless. */
    private syncOutlineUnderlay(
        groupEl: HTMLElement,
        group: PieceGroup,
        pieceLookup: Map<number, Piece>,
        layoutKey: string,
    ): SVGSVGElement {
        const edgesId = `group-edges-${group.id}`;
        let underlay = groupEl.querySelector<SVGSVGElement>(':scope > svg[data-outline-underlay]');
        const created = underlay === null;
        if (!underlay) {
            underlay = document.createElementNS(SVG_NS, 'svg');
            underlay.setAttribute('data-outline-underlay', '');
            underlay.setAttribute('width', '1');
            underlay.setAttribute('height', '1');
            for (const name of RING_NAMES) {
                const ring = document.createElementNS(SVG_NS, 'use');
                ring.setAttribute('data-ring', name);
                underlay.appendChild(ring);
            }
            const outline = document.createElementNS(SVG_NS, 'g');
            outline.setAttribute('data-edge-outline', '');
            const edges = document.createElementNS(SVG_NS, 'g');
            edges.id = edgesId;
            outline.appendChild(edges);
            underlay.appendChild(outline);
        }
        const firstPiece = groupEl.querySelector(':scope > svg[data-piece-id]');
        if (underlay.parentNode !== groupEl || underlay.nextElementSibling !== firstPiece) {
            groupEl.insertBefore(underlay, firstPiece);
        }
        if (created) syncRingReferences(groupEl, group.id, this.ringsEnabled);

        if (underlay.dataset.pieces === layoutKey) return underlay;
        underlay.dataset.pieces = layoutKey;

        const paths: SVGPathElement[] = [];
        for (const [pieceId, offset] of group.pieces) {
            const piece = pieceLookup.get(pieceId);
            if (!piece) continue;
            const d = piece.edges
                .filter((edge) => !group.pieces.has(edge.matePieceId))
                .map(edgePathD)
                .join(' ');
            if (!d) continue;
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('transform', `translate(${offset.x} ${offset.y})`);
            paths.push(path);
        }
        underlay.querySelector(`#${edgesId}`)!.replaceChildren(...paths);
        return underlay;
    }

    /**
     * Separately clipped pieces each cover a shared edge's pixels only
     * partially, so the table shows through as a hairline (#711). One fill
     * clipped to the group's outline covers those pixels from below.
     * Sits under the outline underlay, whose stroke hides the fill's
     * anti-aliased fringe so outer edges look as they do on a lone piece.
     */
    private syncSeamFill(
        groupEl: HTMLElement,
        underlay: SVGSVGElement,
        group: PieceGroup,
        pieceLookup: Map<number, Piece>,
        imageUrl: string | null,
        layoutKey: string,
        outline: () => string,
    ): void {
        let seamFill = groupEl.querySelector<SVGSVGElement>(':scope > svg[data-seam-fill]');
        if (group.pieces.size < 2) {
            seamFill?.remove();
            return;
        }
        seamFill ??= this.createSeamFill(group.id, imageUrl);
        if (seamFill.nextElementSibling !== underlay) groupEl.insertBefore(seamFill, underlay);

        if (seamFill.dataset.pieces === layoutKey) return;
        seamFill.dataset.pieces = layoutKey;

        let photoOrigin: Point | null = null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [pieceId, offset] of group.pieces) {
            const piece = pieceLookup.get(pieceId);
            if (!piece) continue;
            photoOrigin ??= { x: offset.x + piece.imageOffset.x, y: offset.y + piece.imageOffset.y };
            minX = Math.min(minX, offset.x + piece.bounds.minX);
            minY = Math.min(minY, offset.y + piece.bounds.minY);
            maxX = Math.max(maxX, offset.x + piece.bounds.maxX);
            maxY = Math.max(maxY, offset.y + piece.bounds.maxY);
        }

        const clip = seamFill.querySelector('clipPath > path')!;
        if (!photoOrigin) {
            clip.setAttribute('d', '');
            return;
        }
        clip.setAttribute('d', outline());

        const fill = seamFill.lastElementChild!;
        if (imageUrl === null) {
            fill.setAttribute('x', String(minX));
            fill.setAttribute('y', String(minY));
            fill.setAttribute('width', String(maxX - minX));
            fill.setAttribute('height', String(maxY - minY));
        } else {
            fill.setAttribute('x', String(photoOrigin.x));
            fill.setAttribute('y', String(photoOrigin.y));
        }
    }

    /**
     * The clip is one path, not one child per piece: WebKit clips to several
     * children through a mask that blends their shared edges just as the
     * pieces do. It holds only the group outline, keeping each repaint
     * proportional to the perimeter: the pieces' full shapes doubled a
     * 768-piece group's merge frame on an iPad 6th gen. Built once per group
     * and updated in place, so a merge doesn't reload the photo.
     */
    private createSeamFill(groupId: number, imageUrl: string | null): SVGSVGElement {
        const clipId = `seam-clip-${groupId}`;
        const clipPath = document.createElementNS(SVG_NS, 'clipPath');
        clipPath.id = clipId;
        clipPath.appendChild(document.createElementNS(SVG_NS, 'path'));
        const defs = document.createElementNS(SVG_NS, 'defs');
        defs.appendChild(clipPath);

        const fill = imageUrl === null
            ? document.createElementNS(SVG_NS, 'rect')
            : this.createPhotoImage(imageUrl, { x: 0, y: 0 });
        fill.setAttribute('clip-path', `url(#${clipId})`);

        const seamFill = document.createElementNS(SVG_NS, 'svg');
        seamFill.setAttribute('data-seam-fill', '');
        seamFill.setAttribute('width', '1');
        seamFill.setAttribute('height', '1');
        seamFill.append(defs, fill);
        return seamFill;
    }

    /**
     * `slice` covers the puzzle rect and crops excess, so a puzzle whose aspect
     * ratio differs from the image (fractal tile grid) is cropped uniformly,
     * not stretched.
     */
    private createPhotoImage(imageUrl: string, origin: Point): SVGImageElement {
        const image = document.createElementNS(SVG_NS, 'image');
        image.setAttributeNS(XLINK_NS, 'href', imageUrl);
        image.setAttribute('width', String(this.imageSize.width));
        image.setAttribute('height', String(this.imageSize.height));
        image.setAttribute('x', String(origin.x));
        image.setAttribute('y', String(origin.y));
        image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        image.setAttribute('draggable', 'false');
        image.setAttribute('pointer-events', 'none');
        return image;
    }

    private createPieceSvg(piece: Piece, imageUrl: string | null): SVGSVGElement {
        const svgWidth = this.pieceBaseWidth + PIECE_PADDING * 2;
        const svgHeight = this.pieceBaseHeight + PIECE_PADDING * 2;

        const svg = document.createElementNS(SVG_NS, 'svg');
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
            const fill = document.createElementNS(SVG_NS, 'path');
            fill.setAttribute('d', piece.shape);
            fill.setAttribute('fill-rule', 'evenodd');
            fill.setAttribute('pointer-events', 'none');
            fill.dataset.pieceBlank = 'true';
            svg.appendChild(fill);
        } else {
            // Clip only needed on the image arm — the blank arm fills the shape
            // directly, and an unused clip would duplicate `piece.shape` per piece.
            const defs = document.createElementNS(SVG_NS, 'defs');
            const clipPath = document.createElementNS(SVG_NS, 'clipPath');
            clipPath.setAttribute('id', `clip-piece-${piece.id}`);

            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', piece.shape);
            path.setAttribute('fill-rule', 'evenodd');
            clipPath.appendChild(path);
            defs.appendChild(clipPath);
            svg.appendChild(defs);

            const image = this.createPhotoImage(imageUrl, piece.imageOffset);
            image.setAttribute('clip-path', `url(#clip-piece-${piece.id})`);
            this.photoSettle.watch(image);
            svg.appendChild(image);
        }

        // Transparent hit-area shaped to the outline, so pointer events fire
        // only inside the piece, not its SVG bounding box. Near-misses are
        // rescued by the screen-space probe (`interaction/hit-probe.ts`), so no
        // widened hit stroke is needed.
        const hitArea = document.createElementNS(SVG_NS, 'path');
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
            const edgePath = document.createElementNS(SVG_NS, 'path');
            edgePath.setAttribute('d', edgePathD(edge));
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
        const fillPath = document.createElementNS(SVG_NS, 'path');
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

        const label = document.createElementNS(SVG_NS, 'text');
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
        const arrow = document.createElementNS(SVG_NS, 'path');
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
