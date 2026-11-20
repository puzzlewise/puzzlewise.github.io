/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { createBackgroundColorPicker } from './background-color-picker.js';
import { BACKGROUND_COLOR_PRESETS } from './background-color.js';
import { createBackgroundIcon } from './tool-icons.js';

describe('createBackgroundColorPicker', () => {
    it('adds the background button, with its icon, to the container', () => {
        const container = document.createElement('div');
        const picker = createBackgroundColorPicker({
            container,
            selectedId: BACKGROUND_COLOR_PRESETS[0].id,
            onSelect: vi.fn(),
        });
        const button = container.querySelector('button.bg-color-button');
        expect(button?.querySelector('svg')?.outerHTML).toBe(createBackgroundIcon().outerHTML);
        picker.dispose();
    });

    it('opens a grid with one swatch per preset and reports selections', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const onSelect = vi.fn();
        const picker = createBackgroundColorPicker({
            container,
            selectedId: 'indigo-darker',
            onSelect,
        });

        (container.querySelector('button.bg-color-button') as HTMLButtonElement).click();
        const swatches = container.querySelectorAll('.swatch-grid .swatch');
        expect(swatches.length).toBe(BACKGROUND_COLOR_PRESETS.length);
        // The adapter supplies its own panel-positioning class.
        expect(container.querySelector('.swatch-grid.bg-color-panel')).toBeTruthy();

        (container.querySelector('[data-swatch-id="blue-default"]') as HTMLButtonElement).click();
        expect(onSelect).toHaveBeenCalledWith('blue-default');

        picker.dispose();
        document.body.removeChild(container);
    });
});
