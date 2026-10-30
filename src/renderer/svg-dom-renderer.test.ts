/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SvgDomRenderer, RELAYER_IDLE_MS } from './svg-dom-renderer.js';
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

    describe('flashMergePulse', () => {
        it('adds the merge-pulse class to the group element', () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);

            renderer.flashMergePulse(0);

            const groupEl = container.querySelector('[data-group-id="0"]')!;
            expect(groupEl.classList.contains('merge-pulse')).toBe(true);
        });

        it('is a no-op for non-existent group ids', () => {
            renderer.init(container);
            const state = make2x2State();
            renderer.renderState(state);

            renderer.flashMergePulse(999);
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
