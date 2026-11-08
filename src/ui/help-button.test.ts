/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHelpButton } from './help-button.js';

describe('createHelpButton', () => {
    let container: HTMLElement;
    let onShowHelp: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
        container = document.createElement('div');
        onShowHelp = vi.fn<() => void>();
    });

    it('should add a button to the container', () => {
        createHelpButton({ container, onShowHelp });

        const button = container.querySelector('button');
        expect(button).not.toBeNull();
    });

    it('should have the correct class name', () => {
        createHelpButton({ container, onShowHelp });

        const button = container.querySelector('button');
        expect(button!.className).toBe('help-button');
    });

    it('shows ❓ with the title Help', () => {
        createHelpButton({ container, onShowHelp });

        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('❓');
        expect(button.title).toBe('Help');
    });

    it('should have type="button"', () => {
        createHelpButton({ container, onShowHelp });

        const button = container.querySelector('button')!;
        expect(button.type).toBe('button');
    });

    it('should call onShowHelp when clicked', () => {
        createHelpButton({ container, onShowHelp });

        const button = container.querySelector('button')!;
        button.click();

        expect(onShowHelp).toHaveBeenCalledOnce();
    });

    it('should call onShowHelp on each click', () => {
        createHelpButton({ container, onShowHelp });

        const button = container.querySelector('button')!;
        button.click();
        button.click();
        button.click();

        expect(onShowHelp).toHaveBeenCalledTimes(3);
    });

    it('should remove button on cleanup', () => {
        const cleanup = createHelpButton({ container, onShowHelp });

        expect(container.querySelector('button')).not.toBeNull();

        cleanup();

        expect(container.querySelector('button')).toBeNull();
    });

    it('should not respond to clicks after cleanup', () => {
        const cleanup = createHelpButton({ container, onShowHelp });

        const button = container.querySelector('button')!;
        cleanup();

        button.click();

        expect(onShowHelp).not.toHaveBeenCalled();
    });
});
