/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test } from 'vitest';
import type { PieceGroup } from '../../model/types.js';
import { makeGameState, makeRectPiece } from '../../test-helpers/fixtures.js';
import { createDebugOverlay } from './debug-overlay.js';
import { buildPieceFill } from './piece-mesh.js';
import { Scene } from './scene.js';

function sceneOf(groups: PieceGroup[], pieceCount: number): Scene {
    const pieces = Array.from({ length: pieceCount }, (_, id) => makeRectPiece({ id }));
    const state = makeGameState({ pieces, groups });
    return new Scene(pieces.map((piece) => buildPieceFill(piece, 0.05)), state);
}

function matrixOf(element: Element): number[] {
    const match = /^matrix\((.*)\)$/.exec((element as HTMLElement).style.transform);
    expect(match).not.toBeNull();
    return match![1].split(',').map(Number);
}

const IDENTITY = { scale: 1, offsetX: 0, offsetY: 0 };

describe('createDebugOverlay', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    test('overlay creates one label per piece showing its id', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        const scene = sceneOf([
            { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 100, y: 0 }]]), position: { x: 0, y: 0 }, rotation: 0 },
            { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]), position: { x: 300, y: 0 }, rotation: 0 },
        ], 3);

        overlay.update(scene, IDENTITY);

        const labels = [...container.querySelectorAll('[data-debug-label]')];
        expect(labels.map((label) => label.textContent).sort()).toEqual(['0', '1', '2']);
        expect(container.querySelectorAll('[data-debug-up]')).toHaveLength(3);
    });

    test('overlay transform combines viewport, group rotation and piece offset', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        const scene = sceneOf([
            { id: 0, pieces: new Map([[0, { x: 100, y: 0 }]]), position: { x: 300, y: 50 }, rotation: 90 },
        ], 1);

        overlay.update(scene, { scale: 2, offsetX: 10, offsetY: 20 });

        const root = container.firstElementChild as HTMLElement;
        expect(root.style.transformOrigin).toBe('0 0');
        expect(matrixOf(root)).toEqual([2, 0, 0, 2, 10, 20]);
        const piece = container.querySelector('[data-debug-label]')!.parentElement!;
        expect(piece.parentElement).toBe(root);
        const [a, b, c, d, e, f] = matrixOf(piece);
        expect(a).toBeCloseTo(0);
        expect(b).toBeCloseTo(1);
        expect(c).toBeCloseTo(-1);
        expect(d).toBeCloseTo(0);
        expect(e).toBeCloseTo(300);
        expect(f).toBeCloseTo(50 + 100);
    });

    test('a pan or zoom writes the overlay\'s transform, not the pieces\'', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        const scene = sceneOf([
            { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]), position: { x: 300, y: 50 }, rotation: 0 },
        ], 1);
        overlay.update(scene, IDENTITY);
        const root = container.firstElementChild as HTMLElement;
        const piece = container.querySelector('[data-debug-label]')!.parentElement!;
        piece.style.transform = 'none';

        overlay.update(scene, { scale: 3, offsetX: -40, offsetY: 5 });

        expect(matrixOf(root)).toEqual([3, 0, 0, 3, -40, 5]);
        expect(piece.style.transform).toBe('none');
    });

    test('labels sit at the center of the piece bounds and the up-triangle tip 4 units below the top', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        const scene = sceneOf([
            { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]), position: { x: 0, y: 0 }, rotation: 0 },
        ], 1);

        overlay.update(scene, IDENTITY);

        const label = container.querySelector('[data-debug-label]')!;
        expect([label.getAttribute('x'), label.getAttribute('y')]).toEqual(['50', '50']);
        expect(container.querySelector('[data-debug-up]')!.getAttribute('d')).toBe('M 50 4 L 45 11 L 55 11 Z');
    });

    test('a new scene replaces the previous scene\'s pieces', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        const one = { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]), position: { x: 0, y: 0 }, rotation: 0 };
        overlay.update(sceneOf([one, { ...one, id: 1, pieces: new Map([[1, { x: 0, y: 0 }]]) }], 2), IDENTITY);

        overlay.update(sceneOf([one], 1), IDENTITY);

        expect([...container.querySelectorAll('[data-debug-label]')].map((label) => label.textContent)).toEqual(['0']);
    });

    test('setVisible(false) hides the overlay', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        const root = container.firstElementChild as HTMLElement;
        expect(root.style.display).not.toBe('none');

        overlay.setVisible(false);
        expect(root.style.display).toBe('none');

        overlay.setVisible(true);
        expect(root.style.display).not.toBe('none');
    });

    test('a hidden overlay drops its pieces, and the next update rebuilds them', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        const scene = sceneOf([
            { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]), position: { x: 0, y: 0 }, rotation: 0 },
        ], 1);
        overlay.update(scene, IDENTITY);

        overlay.setVisible(false);
        expect(container.querySelectorAll('[data-debug-label]')).toHaveLength(0);

        overlay.update(scene, IDENTITY);
        overlay.setVisible(true);
        expect(container.querySelectorAll('[data-debug-label]')).toHaveLength(1);
    });

    test('the overlay lets pointer presses through to the table', () => {
        const container = document.createElement('div');
        createDebugOverlay(container);
        expect((container.firstElementChild as HTMLElement).style.pointerEvents).toBe('none');
    });

    test('destroy removes the overlay', () => {
        const container = document.createElement('div');
        const overlay = createDebugOverlay(container);
        overlay.destroy();
        expect(container.childElementCount).toBe(0);
    });
});
