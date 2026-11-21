/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGatherPiecesButton } from './gather-pieces-button.js';
import { createGatherPiecesIcon } from './tool-icons.js';

describe('createGatherPiecesButton', () => {
    let container: HTMLElement;
    let onGatherPieces: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
        container = document.createElement('div');
        onGatherPieces = vi.fn<() => void>();
    });

    it('should add a button to the container', () => {
        createGatherPiecesButton({ container, onGatherPieces });

        const button = container.querySelector('button');
        expect(button).not.toBeNull();
        expect(button!.querySelector('svg')!.outerHTML).toBe(createGatherPiecesIcon().outerHTML);
        expect(button!.getAttribute('aria-label')).toBe('Gather Pieces');
        expect(button!.title).toBe('Gather Pieces');
    });

    it('should have the correct class name', () => {
        createGatherPiecesButton({ container, onGatherPieces });

        const button = container.querySelector('button');
        expect(button!.className).toBe('gather-pieces-button');
    });

    it('should have type="button"', () => {
        createGatherPiecesButton({ container, onGatherPieces });

        const button = container.querySelector('button')!;
        expect(button.type).toBe('button');
    });

    it('should call onGatherPieces when clicked', () => {
        createGatherPiecesButton({ container, onGatherPieces });

        const button = container.querySelector('button')!;
        button.click();

        expect(onGatherPieces).toHaveBeenCalledOnce();
    });

    it('should call onGatherPieces on each click', () => {
        createGatherPiecesButton({ container, onGatherPieces });

        const button = container.querySelector('button')!;
        button.click();
        button.click();
        button.click();

        expect(onGatherPieces).toHaveBeenCalledTimes(3);
    });

    it('should remove button on cleanup', () => {
        const cleanup = createGatherPiecesButton({ container, onGatherPieces });

        expect(container.querySelector('button')).not.toBeNull();

        cleanup();

        expect(container.querySelector('button')).toBeNull();
    });

    it('should not respond to clicks after cleanup', () => {
        const cleanup = createGatherPiecesButton({ container, onGatherPieces });

        const button = container.querySelector('button')!;
        cleanup();

        button.click();

        expect(onGatherPieces).not.toHaveBeenCalled();
    });
});
