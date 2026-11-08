/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSettingsButton } from './settings-button.js';

describe('createSettingsButton', () => {
    let container: HTMLElement;
    let onShowSettings: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
        container = document.createElement('div');
        onShowSettings = vi.fn<() => void>();
    });

    it('should add a button to the container', () => {
        createSettingsButton({ container, onShowSettings });

        const button = container.querySelector('button');
        expect(button).not.toBeNull();
    });

    it('should have the correct class name', () => {
        createSettingsButton({ container, onShowSettings });

        const button = container.querySelector('button');
        expect(button!.className).toBe('settings-button');
    });

    it('shows ⚙️ with the title Settings', () => {
        createSettingsButton({ container, onShowSettings });

        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('⚙️');
        expect(button.title).toBe('Settings');
    });

    it('should have type="button"', () => {
        createSettingsButton({ container, onShowSettings });

        const button = container.querySelector('button')!;
        expect(button.type).toBe('button');
    });

    it('should call onShowSettings when clicked', () => {
        createSettingsButton({ container, onShowSettings });

        const button = container.querySelector('button')!;
        button.click();

        expect(onShowSettings).toHaveBeenCalledOnce();
    });

    it('should call onShowSettings on each click', () => {
        createSettingsButton({ container, onShowSettings });

        const button = container.querySelector('button')!;
        button.click();
        button.click();
        button.click();

        expect(onShowSettings).toHaveBeenCalledTimes(3);
    });

    it('should remove button on cleanup', () => {
        const cleanup = createSettingsButton({ container, onShowSettings });

        expect(container.querySelector('button')).not.toBeNull();

        cleanup();

        expect(container.querySelector('button')).toBeNull();
    });

    it('should not respond to clicks after cleanup', () => {
        const cleanup = createSettingsButton({ container, onShowSettings });

        const button = container.querySelector('button')!;
        cleanup();

        button.click();

        expect(onShowSettings).not.toHaveBeenCalled();
    });
});
