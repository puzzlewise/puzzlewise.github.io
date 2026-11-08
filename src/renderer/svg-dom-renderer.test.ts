/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SvgDomRenderer, RELAYER_IDLE_MS, RING_NAMES } from './svg-dom-renderer.js';
import { VIEWPORT_TRANSITION_MS } from './types.js';
import type { GameState, PieceGroup } from '../model/types.js';
import { makeGameState, makeRectPiece } from '../test-helpers/fixtures.js';
import { computePieceBounds } from '../model/derive.js';

function makeGroup(id: number, pieceIds: number[], x = 0, y = 0): PieceGroup {
    return {
        id,
        pieces: new Map(pieceIds.map((pid, i) => [pid, { x: i * 100, y: 0 }])),
        position: { x, y },
        rotation: 0,
    };
}

function make2x2State(): GameState {
    const pw = 100;
    const ph = 100;

    return makeGameState({
        pieces: [
            makeRectPiece({ id: 0, width: pw, height: ph, col: 0, row: 0 }),
            makeRectPiece({ id: 1, width: pw, height: ph, col: 1, row: 0 }),
            makeRectPiece({ id: 2, width: pw, height: ph, col: 0, row: 1 }),
            makeRectPiece({ id: 3, width: pw, height: ph, col: 1, row: 1 }),
        ],
        groups: [
            makeGroup(0, [0], 50, 50),
            makeGroup(1, [1], 200, 50),
            makeGroup(2, [2], 50, 200),
            makeGroup(3, [3], 200, 200),
        ],
        imageUrl: 'test-puzzle.jpg',
        imageSize: { width: 200, height: 200 },
        gridSize: { cols: 2, rows: 2 },
    });
}

describe('SvgDomRenderer', () => {
    let container: HTMLElement;
    let renderer: SvgDomRenderer;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        renderer = new SvgDomRenderer();
    });

    afterEach(() => {
        renderer.destroy();
        container.remove();
    });

    describe('prefetchPhoto', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("makes the same no-cors request as the pieces' <image>", () => {
            const prefetchSrc = vi.spyOn(HTMLImageElement.prototype, 'src', 'set');
            const prefetchCrossOrigin = vi.spyOn(HTMLImageElement.prototype, 'crossOrigin', 'set');
            const state = make2x2State();

            renderer.prefetchPhoto(state.imageUrl!);
            renderer.init(container);
            renderer.renderState(state);

            const image = container.querySelector('image')!;
            expect(prefetchSrc).toHaveBeenCalledWith(image.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
            expect(prefetchCrossOrigin).not.toHaveBeenCalled();
            expect(image.hasAttribute('crossorigin')).toBe(false);
        });
    });

    describe('photoSettled', () => {
        it("resolves 'loaded' when the puzzle's photo loads", async () => {
            renderer.init(container);
            renderer.renderState(make2x2State());
            const settled = renderer.photoSettled();

            container.querySelector('image')!.dispatchEvent(new Event('load'));

            await expect(settled).resolves.toBe('loaded');
        });

        it("resolves 'failed' when the photo errors", async () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            container.querySelector('image')!.dispatchEvent(new Event('error'));

            await expect(renderer.photoSettled()).resolves.toBe('failed');
        });

        it('keeps the settled result when the same puzzle is rendered again', async () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);
            container.querySelector('image')!.dispatchEvent(new Event('load'));
            await renderer.photoSettled();

            renderer.renderState(state);

            await expect(renderer.photoSettled()).resolves.toBe('loaded');
        });

        it('starts a new settle for a different puzzle', async () => {
            renderer.init(container);
            renderer.renderState(make2x2State());
            container.querySelector('image')!.dispatchEvent(new Event('load'));

            renderer.renderState({ ...make2x2State(), imageUrl: 'other.jpg' });
            const settled = renderer.photoSettled();
            container.querySelector('image')!.dispatchEvent(new Event('error'));

            await expect(settled).resolves.toBe('failed');
        });
    });

    describe('init', () => {
        it('creates a table div inside the container', () => {
            renderer.init(container);

            const table = container.querySelector('div');
            expect(table).not.toBeNull();
            expect(table!.style.position).toBe('relative');
            expect(table!.style.touchAction).toBe('none');
        });
    });

    describe('renderState', () => {
        it('creates a group div for each group', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            const groups = container.querySelectorAll('[data-group-id]');
            expect(groups).toHaveLength(4);
        });

        it('creates an SVG element for each piece', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            const svgs = container.querySelectorAll('svg[data-piece-id]');
            expect(svgs).toHaveLength(4);
        });

        it('places pieces inside their group containers', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            for (const group of state.groups) {
                const groupEl = container.querySelector(
                    `[data-group-id="${group.id}"]`,
                );
                expect(groupEl).not.toBeNull();

                for (const pieceId of group.pieces.keys()) {
                    const pieceEl = groupEl!.querySelector(
                        `[data-piece-id="${pieceId}"]`,
                    );
                    expect(
                        pieceEl,
                        `Piece ${pieceId} should be in group ${group.id}`,
                    ).not.toBeNull();
                }
            }
        });

        it('sets group position via CSS transform', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            const groupEl = container.querySelector(
                '[data-group-id="0"]',
            ) as HTMLElement;

            expect(groupEl.style.transform).toBe('translate(50px, 50px) rotate(0deg)');
        });

        it('renders a group at non-zero degree rotation', () => {
            renderer.init(container);
            const state = make2x2State();
            state.groups[0] = { ...state.groups[0], rotation: 90 };

            renderer.renderState(state);

            const groupEl = container.querySelector(
                '[data-group-id="0"]',
            ) as HTMLElement;
            expect(groupEl).not.toBeNull();
            expect(groupEl.style.transform).toContain('rotate(90deg)');
            expect(groupEl.style.transform).not.toContain('rotate(8100deg)');
        });

        it('each piece SVG has a clip-path in its defs', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            for (const piece of state.pieces) {
                const svg = container.querySelector(
                    `svg[data-piece-id="${piece.id}"]`,
                );
                expect(svg).not.toBeNull();

                const clipPath = svg!.querySelector(
                    `clipPath#clip-piece-${piece.id}`,
                );
                expect(
                    clipPath,
                    `Piece ${piece.id} should have a clip-path`,
                ).not.toBeNull();

                const path = clipPath!.querySelector('path');
                expect(path).not.toBeNull();
                expect(path!.getAttribute('d')).toBe(piece.shape);
            }
        });

        it('each piece SVG has an image element', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            for (const piece of state.pieces) {
                const svg = container.querySelector(
                    `svg[data-piece-id="${piece.id}"]`,
                );
                const image = svg!.querySelector('image');
                expect(image).not.toBeNull();
                expect(image!.getAttribute('clip-path')).toBe(
                    `url(#clip-piece-${piece.id})`,
                );
            }
        });

        it('removes groups that no longer exist', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);
            expect(
                container.querySelectorAll('[data-group-id]'),
            ).toHaveLength(4);

            const mergedGroup: PieceGroup = {
                id: 10,
                pieces: new Map([
                    [0, { x: 0, y: 0 }],
                    [1, { x: 100, y: 0 }],
                ]),
                position: { x: 50, y: 50 },
                rotation: 0,
            };

            const newState: GameState = {
                ...state,
                groups: [mergedGroup, state.groups[2], state.groups[3]],
            };

            renderer.renderState(newState);

            const groups = container.querySelectorAll('[data-group-id]');
            expect(groups).toHaveLength(3);

            expect(
                container.querySelector('[data-group-id="0"]'),
            ).toBeNull();
            expect(
                container.querySelector('[data-group-id="1"]'),
            ).toBeNull();

            const mergedEl = container.querySelector(
                '[data-group-id="10"]',
            );
            expect(mergedEl).not.toBeNull();
            expect(
                mergedEl!.querySelector('[data-piece-id="0"]'),
            ).not.toBeNull();
            expect(
                mergedEl!.querySelector('[data-piece-id="1"]'),
            ).not.toBeNull();
        });

        it('recreates piece SVGs when the image URL changes', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            const originalSvg = container.querySelector(
                'svg[data-piece-id="0"]',
            ) as SVGSVGElement;
            expect(originalSvg).not.toBeNull();

            const originalImage = originalSvg.querySelector('image')!;
            expect(originalImage.getAttributeNS(
                'http://www.w3.org/1999/xlink',
                'href',
            )).toBe('test-puzzle.jpg');

            const newState: GameState = {
                ...state,
                imageUrl: 'new-puzzle-image.jpg',
            };

            renderer.renderState(newState);

            const newSvg = container.querySelector(
                'svg[data-piece-id="0"]',
            ) as SVGSVGElement;
            expect(newSvg).not.toBeNull();
            expect(newSvg).not.toBe(originalSvg);

            const newImage = newSvg.querySelector('image')!;
            expect(newImage.getAttributeNS(
                'http://www.w3.org/1999/xlink',
                'href',
            )).toBe('new-puzzle-image.jpg');
        });

        it('keeps piece SVGs when re-rendering with the same image URL', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            const originalSvg = container.querySelector(
                'svg[data-piece-id="0"]',
            ) as SVGSVGElement;

            renderer.renderState(state);

            const sameSvg = container.querySelector(
                'svg[data-piece-id="0"]',
            ) as SVGSVGElement;

            expect(sameSvg).toBe(originalSvg);
        });

        it('cleans up old group elements when image URL changes', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);
            expect(
                container.querySelectorAll('[data-group-id]'),
            ).toHaveLength(4);

            const newState: GameState = {
                ...state,
                imageUrl: 'different.jpg',
                groups: [makeGroup(10, [0, 1], 0, 0)],
                pieces: [state.pieces[0], state.pieces[1]],
            };

            renderer.renderState(newState);

            expect(
                container.querySelectorAll('[data-group-id]'),
            ).toHaveLength(1);
            expect(
                container.querySelector('[data-group-id="10"]'),
            ).not.toBeNull();
        });

        it('updates group positions on re-render', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            state.groups[0] = {
                ...state.groups[0],
                position: { x: 300, y: 400 },
            };

            renderer.renderState(state);

            const groupEl = container.querySelector(
                '[data-group-id="0"]',
            ) as HTMLElement;
            expect(groupEl.style.transform).toBe('translate(300px, 400px) rotate(0deg)');
        });

        it('does nothing if init was not called', () => {
            const state = make2x2State();

            renderer.renderState(state);
        });
    });

    describe('fill-rule for pieces with holes', () => {
        it('sets fill-rule=evenodd on clip-path, hit-area, and debug fill for a piece with nested subpaths', () => {
            renderer.init(container);

            // A piece with a hole: outer square + inner triangle subpaths, evenodd = hole.
            const pieceWithHole = {
                id: 0,
                edges: [],
                shape: 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 40 40 L 60 40 L 50 60 Z',
                imageOffset: { x: 0, y: 0 },
                bounds: computePieceBounds({ edges: [] }),
            };

            const state = makeGameState({
                pieces: [pieceWithHole],
                groups: [makeGroup(0, [0], 0, 0)],
                imageUrl: 'test.jpg',
                imageSize: { width: 200, height: 200 },
                gridSize: { cols: 2, rows: 2 },
            });

            renderer.renderState(state);

            const svg = container.querySelector('svg[data-piece-id="0"]') as SVGSVGElement;
            expect(svg).not.toBeNull();

            const clipPath = svg.querySelector('clipPath#clip-piece-0') as SVGClipPathElement;
            expect(clipPath).not.toBeNull();
            const clipPathPath = clipPath.querySelector('path') as SVGPathElement;
            expect(clipPathPath.getAttribute('fill-rule')).toBe('evenodd');

            const hitArea = svg.querySelector('[data-hit-area="true"]') as SVGPathElement;
            expect(hitArea).not.toBeNull();
            expect(hitArea.getAttribute('fill-rule')).toBe('evenodd');

            const debugFill = svg.querySelector('[data-piece-fill="true"]') as SVGPathElement;
            expect(debugFill).not.toBeNull();
            expect(debugFill.getAttribute('fill-rule')).toBe('evenodd');
        });

        it('sets fill-rule=evenodd on hit-area for a simple rectangular piece too', () => {
            renderer.init(container);
            const state = make2x2State();

            renderer.renderState(state);

            const svg = container.querySelector('svg[data-piece-id="0"]') as SVGSVGElement;
            const hitArea = svg.querySelector('[data-hit-area="true"]') as SVGPathElement;
            expect(hitArea.getAttribute('fill-rule')).toBe('evenodd');
        });
    });

    describe('bringGroupToFront', () => {
        it('moves the group element to the end of its parent', () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);

            const table = container.querySelector('div')!;
            const firstChild = table.firstElementChild;
            expect(firstChild!.getAttribute('data-group-id')).toBe('0');

            renderer.bringGroupToFront(0);

            const lastChild = table.lastElementChild;
            expect(lastChild!.getAttribute('data-group-id')).toBe('0');
        });

        it('is a no-op for non-existent group ids', () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);

            renderer.bringGroupToFront(999);
        });
    });

    describe('setViewportTransform', () => {
        it('applies CSS transform to the table element', () => {
            renderer.init(container);

            renderer.setViewportTransform(2, 100, 50);

            const table = container.querySelector('div') as HTMLElement;
            expect(table.style.transform).toBe('translate(100px, 50px) scale(2)');
        });

        it('handles identity transform', () => {
            renderer.init(container);

            renderer.setViewportTransform(1, 0, 0);

            const table = container.querySelector('div') as HTMLElement;
            expect(table.style.transform).toBe('translate(0px, 0px) scale(1)');
        });

        it('does nothing if init was not called', () => {
            renderer.setViewportTransform(2, 100, 50);
        });
    });

    describe('setGroupDragging', () => {
        it('adds the dragging class when dragging is true', () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);

            renderer.setGroupDragging(0, true);

            const groupEl = container.querySelector('[data-group-id="0"]')!;
            expect(groupEl.classList.contains('dragging')).toBe(true);
        });

        it('removes the dragging class when dragging is false', () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);

            renderer.setGroupDragging(0, true);
            renderer.setGroupDragging(0, false);

            const groupEl = container.querySelector('[data-group-id="0"]')!;
            expect(groupEl.classList.contains('dragging')).toBe(false);
        });

        it('is a no-op for non-existent group ids', () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);

            renderer.setGroupDragging(999, true);
        });

        it('leaves will-change to the CSS, so the relayer rule can override it (#680)', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            const groupEl = container.querySelector<HTMLElement>('[data-group-id="0"]')!;
            expect(groupEl.style.willChange).toBe('');
        });
    });

    describe('relayer after zooming out', () => {
        let frames: FrameRequestCallback[];
        let table: HTMLElement;

        beforeEach(() => {
            vi.useFakeTimers();
            frames = [];
            vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
            renderer.init(container);
            table = container.querySelector<HTMLElement>('[data-puzzle-table]')!;
            renderer.setViewportTransform(2, 0, 0);
        });

        afterEach(() => {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        });

        function runFrame(): void {
            const pending = frames;
            frames = [];
            for (const cb of pending) cb(0);
        }

        it('drops the group layers for one frame once a zoom-out settles', () => {
            renderer.setViewportTransform(1, 0, 0);
            vi.advanceTimersByTime(RELAYER_IDLE_MS - 1);
            expect(table.classList.contains('relayer')).toBe(false);

            vi.advanceTimersByTime(1);
            expect(table.classList.contains('relayer')).toBe(true);

            runFrame();
            expect(table.classList.contains('relayer')).toBe(true);
            runFrame();
            expect(table.classList.contains('relayer')).toBe(false);
        });

        it('waits until the zoom has been still for the idle time', () => {
            renderer.setViewportTransform(1.5, 0, 0);
            vi.advanceTimersByTime(RELAYER_IDLE_MS - 1);
            renderer.setViewportTransform(1, 0, 0);
            vi.advanceTimersByTime(RELAYER_IDLE_MS - 1);
            expect(table.classList.contains('relayer')).toBe(false);

            vi.advanceTimersByTime(1);
            expect(table.classList.contains('relayer')).toBe(true);
        });

        it('compares against the highest zoom since the last relayer', () => {
            renderer.setViewportTransform(4, 0, 0);
            renderer.setViewportTransform(3, 0, 0);
            vi.advanceTimersByTime(RELAYER_IDLE_MS);

            expect(table.classList.contains('relayer')).toBe(true);
        });

        it('does not relayer after zooming in or panning', () => {
            renderer.setViewportTransform(3, 0, 0);
            renderer.setViewportTransform(3, 50, 20);
            vi.advanceTimersByTime(RELAYER_IDLE_MS);

            expect(table.classList.contains('relayer')).toBe(false);
        });

        it('does not relayer again until the zoom drops below the last relayer scale', () => {
            renderer.setViewportTransform(1, 0, 0);
            vi.advanceTimersByTime(RELAYER_IDLE_MS);
            runFrame();
            runFrame();

            renderer.setViewportTransform(1, 30, 0);
            vi.advanceTimersByTime(RELAYER_IDLE_MS);

            expect(table.classList.contains('relayer')).toBe(false);
        });

        it('defers a relayer during an animated viewport transition until it ends', () => {
            renderer.enableViewportTransition();
            renderer.setViewportTransform(1, 0, 0);
            vi.advanceTimersByTime(RELAYER_IDLE_MS);
            expect(table.classList.contains('relayer')).toBe(false);

            renderer.disableViewportTransition();
            expect(table.classList.contains('relayer')).toBe(true);
        });

        it('cancels a pending relayer on destroy', () => {
            renderer.setViewportTransform(1, 0, 0);
            renderer.destroy();

            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('pieceIdFromTarget', () => {
        it('returns the piece id when target is the SVG element itself', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            const svg = container.querySelector('svg[data-piece-id="0"]') as SVGSVGElement;
            expect(renderer.pieceIdFromTarget(svg)).toBe(0);
        });

        it('returns the piece id when target is a hit-area child of the SVG', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            const svg = container.querySelector('svg[data-piece-id="1"]') as SVGSVGElement;
            const hitArea = svg.querySelector('[data-hit-area="true"]') as SVGPathElement;
            expect(renderer.pieceIdFromTarget(hitArea)).toBe(1);
        });

        it('returns null for an unrelated DOM node', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            const unrelated = document.createElement('div');
            expect(renderer.pieceIdFromTarget(unrelated)).toBeNull();
        });

        it('returns null for a null target', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            expect(renderer.pieceIdFromTarget(null)).toBeNull();
        });
    });

    describe('pieceIdAtPoint', () => {
        it('returns null when layout hit-testing is unavailable (e.g. jsdom)', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            // jsdom does not implement elementFromPoint; the guard returns null.
            expect(typeof document.elementFromPoint).not.toBe('function');
            expect(renderer.pieceIdAtPoint({ x: 10, y: 10 })).toBeNull();
        });

        it('maps a screen point to the piece rendered there', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            const hitArea = container.querySelector(
                'svg[data-piece-id="1"] [data-hit-area="true"]',
            ) as SVGPathElement;

            const doc = document as unknown as {
                elementFromPoint?: (x: number, y: number) => Element | null;
            };
            const original = doc.elementFromPoint;
            doc.elementFromPoint = () => hitArea;
            try {
                expect(renderer.pieceIdAtPoint({ x: 5, y: 5 })).toBe(1);
            } finally {
                doc.elementFromPoint = original;
            }
        });
    });

    describe('viewport transition', () => {
        it('writes a CSS duration derived from VIEWPORT_TRANSITION_MS', () => {
            // `app/viewport-fit.ts` arms a fallback timer against this constant,
            // so a mismatched CSS duration silently truncates the completion
            // zoom. This pins the derivation's shape, not the link itself: at
            // 800 the expected string equals `'transform 0.8s ease-in-out'`, so
            // re-hardcoding that still passes; any other duration/unit/easing
            // fails. The real link is structural — `viewport-fit.ts` imports both.
            renderer.init(container);
            const table = container.querySelector<HTMLElement>('[data-puzzle-table]');

            renderer.enableViewportTransition();

            expect(table?.style.transition)
                .toBe(`transform ${VIEWPORT_TRANSITION_MS / 1000}s ease-in-out`);

            renderer.disableViewportTransition();
            expect(table?.style.transition).toBe('');
        });
    });

    describe('blank puzzles', () => {
        function makeBlankState(): GameState {
            const state = make2x2State();
            state.imageUrl = null;
            return state;
        }

        it('paints each piece with a white path instead of an image', () => {
            renderer.init(container);
            renderer.renderState(makeBlankState());

            const pieceEl = container.querySelector('[data-piece-id="0"]')!;
            expect(pieceEl.querySelector('image')).toBeNull();

            const fill = pieceEl.querySelector('[data-piece-blank]')!;
            expect(fill.tagName).toBe('path');
            expect(fill.getAttribute('fill-rule')).toBe('evenodd');
            // Color is CSS (`--piece-blank-fill`), asserted in style.test.ts; jsdom applies no stylesheet.
            expect(fill.hasAttribute('fill')).toBe(false);
        });

        it('fills the exact piece shape', () => {
            const state = makeBlankState();
            renderer.init(container);
            renderer.renderState(state);

            const fill = container.querySelector('[data-piece-blank]')!;
            expect(fill.getAttribute('d')).toBe(state.pieces[0].shape);
        });

        it('builds no clip path, which only the image arm needs', () => {
            renderer.init(container);
            renderer.renderState(makeBlankState());

            const pieceEl = container.querySelector('[data-piece-id="0"]')!;
            // An unreferenced clipPath would duplicate `piece.shape` per piece (~1.2 KB each on a large puzzle).
            expect(pieceEl.querySelector('defs')).toBeNull();
            expect(pieceEl.querySelector('clipPath')).toBeNull();
        });

        it('keeps the hit area and debug overlay', () => {
            renderer.init(container);
            renderer.renderState(makeBlankState());

            const pieceEl = container.querySelector('[data-piece-id="0"]')!;
            expect(pieceEl.querySelector('[data-hit-area]')).not.toBeNull();
            expect(pieceEl.querySelector('[data-piece-fill]')).not.toBeNull();
        });

        it('takes no pointer events, leaving them to the hit area', () => {
            renderer.init(container);
            renderer.renderState(makeBlankState());

            const fill = container.querySelector('[data-piece-blank]')!;
            expect(fill.getAttribute('pointer-events')).toBe('none');
        });

        it('still renders a clipped <image> when the puzzle has one', () => {
            const state = make2x2State();
            renderer.init(container);
            renderer.renderState(state);

            const pieceEl = container.querySelector('[data-piece-id="0"]')!;
            expect(pieceEl.querySelector('[data-piece-blank]')).toBeNull();

            const image = pieceEl.querySelector('image')!;
            expect(image.getAttribute('clip-path')).toBe('url(#clip-piece-0)');
            // Same `d` the blank arm fills, so the two silhouettes are identical.
            expect(
                pieceEl.querySelector('clipPath path')!.getAttribute('d'),
            ).toBe(state.pieces[0].shape);
        });
    });

    describe('seam fill', () => {
        function makeMergedState(imageUrl: string | null = 'test-puzzle.jpg'): GameState {
            const state = make2x2State();
            state.imageUrl = imageUrl;
            state.pieces[0].edges[1].matePieceId = 1;
            state.pieces[1].edges[3].matePieceId = 0;
            state.groups = [makeGroup(0, [0, 1], 50, 50), ...state.groups.slice(2)];
            return state;
        }

        function seamFillOf(groupId: number): SVGSVGElement | null {
            return container.querySelector<SVGSVGElement>(
                `[data-group-id="${groupId}"] > svg[data-seam-fill]`,
            );
        }

        it('adds none to a lone piece', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            expect(seamFillOf(0)).toBeNull();
        });

        it('sits under the outline underlay, which sits under the pieces', () => {
            renderer.init(container);
            renderer.renderState(makeMergedState());

            const seamFill = seamFillOf(0)!;
            expect(seamFill.previousElementSibling).toBeNull();
            const underlay = seamFill.nextElementSibling!;
            expect(underlay.hasAttribute('data-outline-underlay')).toBe(true);
            expect(underlay.nextElementSibling!.getAttribute('data-piece-id')).toBe('0');
        });

        it('keeps the layer order without moving anything on later renders', () => {
            renderer.init(container);
            renderer.renderState(makeMergedState());
            const groupEl = container.querySelector('[data-group-id="0"]')!;
            const before = Array.from(groupEl.children);
            const observer = new MutationObserver(() => {});
            observer.observe(groupEl, { childList: true });

            renderer.renderState(makeMergedState());

            expect(observer.takeRecords()).toEqual([]);
            expect(Array.from(groupEl.children)).toEqual(before);
            observer.disconnect();
        });

        function seamClipD(): string {
            return seamFillOf(0)!.querySelector('clipPath#seam-clip-0 > path')!.getAttribute('d')!;
        }

        it('clips to the group outline', () => {
            renderer.init(container);
            renderer.renderState(makeMergedState());

            expect(seamFillOf(0)!.querySelectorAll('clipPath > path')).toHaveLength(1);
            expect(seamClipD()).toBe('M 0 0 L 100 0 L 200 0 L 200 100 L 100 100 L 0 100 L 0 0 Z');
        });

        it('falls back to every piece shape when the outline does not close', () => {
            renderer.init(container);
            const state = makeMergedState();
            state.groups[0].pieces.set(1, { x: 130, y: 0 });
            renderer.renderState(state);

            expect(seamClipD()).toBe('M 0 0 L 100 0 L 100 100 L 0 100 Z M 130 0 L 230 0 L 230 100 L 130 100 Z');
        });

        it('skips a piece the state does not hold, like the rest of the group', () => {
            renderer.init(container);
            const state = makeMergedState();
            state.groups[0].pieces.set(99, { x: 200, y: 0 });

            expect(() => renderer.renderState(state)).not.toThrow();
            expect(seamClipD()).toBe('M 0 0 L 100 0 L 100 100 L 0 100 Z M 100 0 L 200 0 L 200 100 L 100 100 Z');
        });

        it('still fails the render for errors other than unparseable path data', () => {
            renderer.init(container);
            const state = makeMergedState();
            state.groups[0].pieces.set(1, { x: 130, y: 0 });
            state.pieces[1].shape = null as unknown as string;

            expect(() => renderer.renderState(state)).toThrow(TypeError);
        });

        it('renders a group none of whose pieces the state holds', () => {
            renderer.init(container);
            const state = makeMergedState();
            state.groups[0] = makeGroup(0, [98, 99], 50, 50);

            expect(() => renderer.renderState(state)).not.toThrow();
            expect(seamClipD()).toBe('');
        });

        it('draws no fill, rather than failing the render, for path data it cannot parse', () => {
            renderer.init(container);
            const state = makeMergedState();
            state.pieces[1].edges[0].path = 'L 200 0 ?';
            state.pieces[1].shape = 'M 0 0 ? Z';

            expect(() => renderer.renderState(state)).not.toThrow();
            expect(seamClipD()).toBe('');
        });

        function anchoredOnPiece1(pieceIds: number[]): PieceGroup {
            const solved = new Map([[0, { x: -100, y: 0 }], [1, { x: 0, y: 0 }], [2, { x: -100, y: 100 }]]);
            return {
                id: 0,
                pieces: new Map(pieceIds.map((id) => [id, solved.get(id)!])),
                position: { x: 50, y: 50 },
                rotation: 0,
            };
        }

        function photoXY(): [string | null, string | null] {
            const image = seamFillOf(0)!.querySelector('image')!;
            return [image.getAttribute('x'), image.getAttribute('y')];
        }

        it('draws the photo exactly where the pieces draw it', () => {
            renderer.init(container);
            const state = makeMergedState();
            state.groups[0] = anchoredOnPiece1([1, 0]);
            renderer.renderState(state);

            const image = seamFillOf(0)!.querySelector('image')!;
            const pieceImage = container.querySelector('[data-piece-id="1"] image')!;
            expect(image.getAttribute('clip-path')).toBe('url(#seam-clip-0)');
            expect(image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('test-puzzle.jpg');
            expect(photoXY()).toEqual(['-100', '0']);
            for (const attr of ['width', 'height', 'preserveAspectRatio']) {
                expect(image.getAttribute(attr), attr).toBe(pieceImage.getAttribute(attr));
            }
        });

        it('fills a blank puzzle with a rect over the group bounds', () => {
            renderer.init(container);
            renderer.renderState(makeMergedState(null));

            const seamFill = seamFillOf(0)!;
            expect(seamFill.querySelector('image')).toBeNull();
            const rect = seamFill.querySelector('rect')!;
            expect(rect.getAttribute('clip-path')).toBe('url(#seam-clip-0)');
            expect(['x', 'y', 'width', 'height'].map((a) => rect.getAttribute(a))).toEqual(['0', '0', '200', '100']);
        });

        it('appears when groups merge and survives later renders', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());
            renderer.renderState(makeMergedState());
            const seamFill = seamFillOf(0);
            expect(seamFill).not.toBeNull();

            renderer.renderState(makeMergedState());

            expect(seamFillOf(0)).toBe(seamFill);
            expect(container.querySelectorAll('[data-group-id="0"] svg[data-piece-id]')).toHaveLength(2);
        });

        it('updates the clip in place on a merge, so the photo is not reloaded', () => {
            renderer.init(container);
            const before = make2x2State();
            before.groups = [anchoredOnPiece1([1, 0]), ...before.groups.slice(2)];
            renderer.renderState(before);
            const image = seamFillOf(0)!.querySelector('image');
            const path = seamFillOf(0)!.querySelector('clipPath > path');
            const d = path!.getAttribute('d');

            const after = make2x2State();
            after.groups = [anchoredOnPiece1([1, 0, 2]), after.groups[3]];
            renderer.renderState(after);

            expect(seamFillOf(0)!.querySelector('image')).toBe(image);
            expect(seamFillOf(0)!.querySelector('clipPath > path')).toBe(path);
            expect(path!.getAttribute('d')).not.toBe(d);
            expect(photoXY()).toEqual(['-100', '0']);
        });

        it('follows a piece offset change without a membership change', () => {
            renderer.init(container);
            const state = makeMergedState();
            renderer.renderState(state);

            state.groups[0].pieces.set(0, { x: 10, y: 0 });
            state.groups[0].pieces.set(1, { x: 110, y: 0 });
            renderer.renderState(state);

            expect(seamClipD()).toBe('M 10 0 L 110 0 L 210 0 L 210 100 L 110 100 L 10 100 L 10 0 Z');
        });
    });

    describe('outline underlay', () => {
        function underlayOf(groupId: number): SVGSVGElement {
            return container.querySelector<SVGSVGElement>(
                `[data-group-id="${groupId}"] > [data-outline-underlay]`,
            )!;
        }

        function drawnEdgeCounts(groupId: number): number[] {
            return Array.from(underlayOf(groupId).querySelectorAll('path'))
                .map((p) => p.getAttribute('d')!.split('M').length - 1);
        }

        function makeMatedPairState(merged: boolean): GameState {
            const state = make2x2State();
            state.pieces[0].edges[1].matePieceId = 1;
            state.pieces[1].edges[3].matePieceId = 0;
            if (merged) {
                state.groups = [makeGroup(0, [0, 1], 50, 50), ...state.groups.slice(2)];
            }
            return state;
        }

        it('adds a ring for every ring name, before the outline, each referencing the group edges', () => {
            renderer.init(container);
            renderer.setRingsEnabled(true);
            renderer.renderState(make2x2State());

            const underlay = underlayOf(0);
            const children = Array.from(underlay.children);
            const rings = children.slice(0, RING_NAMES.length);
            expect(rings.map((el) => el.tagName.toLowerCase())).toEqual(RING_NAMES.map(() => 'use'));
            expect(rings.map((el) => el.getAttribute('data-ring'))).toEqual([...RING_NAMES]);
            expect(rings.map((el) => el.getAttribute('href'))).toEqual(RING_NAMES.map(() => '#group-edges-0'));

            const outline = children[children.length - 1];
            expect(children).toHaveLength(RING_NAMES.length + 1);
            expect(outline.hasAttribute('data-edge-outline')).toBe(true);
            expect(outline.contains(underlay.querySelector('#group-edges-0'))).toBe(true);
        });

        it('keeps ring references valid after a merge', () => {
            renderer.init(container);
            renderer.setRingsEnabled(true);
            renderer.renderState(makeMatedPairState(false));
            renderer.renderState(makeMatedPairState(true));

            const underlay = underlayOf(0);
            const rings = Array.from(underlay.querySelectorAll('use[data-ring]'));
            expect(rings).toHaveLength(RING_NAMES.length);
            for (const ring of rings) {
                const target = underlay.querySelector(ring.getAttribute('href')!);
                expect(target, ring.getAttribute('data-ring')!).not.toBeNull();
            }
            expect(drawnEdgeCounts(0)).toEqual([3, 3]);
        });

        it('leaves rings unreferenced until rings are enabled, so Full builds no clones', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            const rings = Array.from(underlayOf(0).querySelectorAll('use[data-ring]'));
            expect(rings).toHaveLength(RING_NAMES.length);
            expect(rings.filter((r) => r.hasAttribute('href'))).toEqual([]);
        });

        it('references or releases the edges on existing groups when rings are toggled', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());
            const hrefs = () => Array.from(underlayOf(0).querySelectorAll('use[data-ring]'))
                .map((r) => r.getAttribute('href'));

            renderer.setRingsEnabled(true);
            expect(hrefs()).toEqual(RING_NAMES.map(() => '#group-edges-0'));

            renderer.setRingsEnabled(false);
            expect(hrefs()).toEqual(RING_NAMES.map(() => null));
        });

        it('ignores the document-level effects attribute', async () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            document.documentElement.dataset.effects = 'simple';
            await Promise.resolve();
            delete document.documentElement.dataset.effects;

            expect(underlayOf(0).querySelectorAll('use[data-ring][href]')).toHaveLength(0);
        });

        it('draws every edge of a lone piece, under the piece', () => {
            renderer.init(container);
            renderer.renderState(make2x2State());

            expect(drawnEdgeCounts(0)).toEqual([4]);
            expect(underlayOf(0).nextElementSibling!.getAttribute('data-piece-id')).toBe('0');
        });

        it('places each piece outline at its offset within the group', () => {
            renderer.init(container);
            renderer.renderState(makeMatedPairState(true));

            const transforms = Array.from(underlayOf(0).querySelectorAll('path'))
                .map((p) => p.getAttribute('transform'));
            expect(transforms).toEqual(['translate(0 0)', 'translate(100 0)']);
        });

        it('leaves out the edges where pieces in the same group meet', () => {
            renderer.init(container);
            renderer.renderState(makeMatedPairState(true));

            expect(drawnEdgeCounts(0)).toEqual([3, 3]);
        });

        it('keeps edges whose mate is in another group', () => {
            renderer.init(container);
            renderer.renderState(makeMatedPairState(false));

            expect(drawnEdgeCounts(0)).toEqual([4]);
            expect(drawnEdgeCounts(1)).toEqual([4]);
        });

        it('redraws the outline when groups merge, keeping the pieces', () => {
            renderer.init(container);
            renderer.renderState(makeMatedPairState(false));
            renderer.renderState(makeMatedPairState(true));

            expect(drawnEdgeCounts(0)).toEqual([3, 3]);
            const groupEl = container.querySelector('[data-group-id="0"]')!;
            expect(groupEl.querySelectorAll('svg[data-piece-id]')).toHaveLength(2);
            expect(groupEl.querySelectorAll('[data-outline-underlay]')).toHaveLength(1);
        });

        it('reuses the outline across renders while the group is unchanged', () => {
            renderer.init(container);
            renderer.renderState(makeMatedPairState(true));
            const underlay = underlayOf(0);
            const path = underlay.querySelector('path');

            renderer.renderState(makeMatedPairState(true));

            expect(underlayOf(0)).toBe(underlay);
            expect(underlayOf(0).querySelector('path')).toBe(path);
        });

        it('moves the outline when a piece offset changes without a membership change', () => {
            renderer.init(container);
            const state = makeMatedPairState(true);
            renderer.renderState(state);

            state.groups[0].pieces.set(1, { x: 120, y: 0 });
            renderer.renderState(state);

            const transforms = Array.from(underlayOf(0).querySelectorAll('path'))
                .map((p) => p.getAttribute('transform'));
            expect(transforms).toEqual(['translate(0 0)', 'translate(120 0)']);
        });

        describe('zoom compensation', () => {
            beforeEach(() => {
                vi.useFakeTimers();
                vi.stubGlobal('requestAnimationFrame', () => 0);
            });

            afterEach(() => {
                vi.unstubAllGlobals();
                vi.useRealTimers();
            });

            it('sets the inverse scale on the table once a zoom has settled', () => {
                renderer.init(container);
                const table = container.querySelector<HTMLElement>('[data-puzzle-table]')!;

                renderer.setViewportTransform(0.25, 0, 0);
                vi.advanceTimersByTime(RELAYER_IDLE_MS - 1);
                expect(table.style.getPropertyValue('--outline-zoom-comp')).toBe('');

                vi.advanceTimersByTime(1);
                expect(table.style.getPropertyValue('--outline-zoom-comp')).toBe('4');
            });

            it('holds the value back until an animated zoom has finished', () => {
                renderer.init(container);
                const table = container.querySelector<HTMLElement>('[data-puzzle-table]')!;

                renderer.enableViewportTransition();
                renderer.setViewportTransform(0.5, 0, 0);
                vi.advanceTimersByTime(RELAYER_IDLE_MS);
                expect(table.style.getPropertyValue('--outline-zoom-comp')).toBe('');

                renderer.disableViewportTransition();
                expect(table.style.getPropertyValue('--outline-zoom-comp')).toBe('2');
            });
        });
    });

    describe('destroy', () => {
        it('removes the table element', () => {
            renderer.init(container);
            expect(container.children).toHaveLength(1);

            renderer.destroy();
            expect(container.children).toHaveLength(0);
        });

        it('can be called multiple times safely', () => {
            renderer.init(container);
            renderer.destroy();
            renderer.destroy();
        });
    });
});
