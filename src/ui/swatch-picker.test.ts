/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createSwatch,
    createSwatchGrid,
    createSwatchPicker,
    type SwatchEntry,
} from './swatch-picker.js';

const SWATCHES: SwatchEntry[] = [
    { id: 'a', label: 'Alpha', color: '#ff0000' },
    { id: 'b', label: 'Beta', color: '#00ff00' },
    { id: 'c', label: 'Gamma', color: '#0000ff' },
];

describe('createSwatch', () => {
    it('creates a labelled button carrying the id and color', () => {
        const swatch = createSwatch(SWATCHES[0], false);
        expect(swatch.tagName).toBe('BUTTON');
        expect(swatch.dataset.swatchId).toBe('a');
        expect(swatch.getAttribute('aria-label')).toBe('Alpha');
        expect(swatch.style.backgroundColor).toBeTruthy();
    });

    it('marks the selected swatch', () => {
        const swatch = createSwatch(SWATCHES[0], true);
        expect(swatch.classList.contains('swatch--selected')).toBe(true);
        expect(swatch.getAttribute('aria-selected')).toBe('true');
    });
});

describe('createSwatchGrid', () => {
    it('renders one option per entry and sets the column count', () => {
        const grid = createSwatchGrid(SWATCHES, 'b', vi.fn(), vi.fn(), {
            ariaLabel: 'Test',
            columnCount: 3,
        });
        expect(grid.querySelectorAll('button').length).toBe(3);
        expect(grid.getAttribute('aria-label')).toBe('Test');
        expect(grid.style.getPropertyValue('--swatch-columns')).toBe('3');
        const selected = grid.querySelector('.swatch--selected');
        expect((selected as HTMLElement).dataset.swatchId).toBe('b');
    });

    it('calls onSelect with the id and dismisses on click', () => {
        const onSelect = vi.fn();
        const onDismiss = vi.fn();
        const grid = createSwatchGrid(SWATCHES, 'a', onSelect, onDismiss, {
            ariaLabel: 'Test',
            columnCount: 3,
        });
        (grid.querySelector('[data-swatch-id="c"]') as HTMLButtonElement).click();
        expect(onSelect).toHaveBeenCalledWith('c');
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('always carries the base swatch-grid class', () => {
        const grid = createSwatchGrid(SWATCHES, 'a', vi.fn(), vi.fn(), {
            ariaLabel: 'Test',
        });
        expect(grid.classList.contains('swatch-grid')).toBe(true);
    });

    it('adds the per-instance panel class for independent positioning', () => {
        const grid = createSwatchGrid(SWATCHES, 'a', vi.fn(), vi.fn(), {
            ariaLabel: 'Test',
            panelClassName: 'outline-color-panel',
        });
        expect(grid.classList.contains('swatch-grid')).toBe(true);
        expect(grid.classList.contains('outline-color-panel')).toBe(true);
    });
});

describe('createSwatchPicker', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    function open() {
        const onSelect = vi.fn();
        const picker = createSwatchPicker({
            container,
            button: { icon: '🎨', title: 'Colour', className: 'bg-color-button' },
            ariaLabel: 'Colour',
            swatches: SWATCHES,
            selectedId: 'a',
            onSelect,
            columnCount: 3,
        });
        const button = container.querySelector(
            'button.bg-color-button',
        ) as HTMLButtonElement;
        return { button, picker, onSelect };
    }

    it('appends a button and toggles the grid open/closed on click', () => {
        const { button, picker } = open();
        expect(button).toBeTruthy();
        expect(container.querySelector('.swatch-grid')).toBeNull();

        button.click();
        expect(container.querySelector('.swatch-grid')).toBeTruthy();

        button.click();
        expect(container.querySelector('.swatch-grid')).toBeNull();

        picker.dispose();
    });

    it('reports the selected id and dismisses on swatch click', () => {
        const { button, picker, onSelect } = open();
        button.click();
        (
            container.querySelector('[data-swatch-id="b"]') as HTMLButtonElement
        ).click();
        expect(onSelect).toHaveBeenCalledWith('b');
        expect(container.querySelector('.swatch-grid')).toBeNull();
        picker.dispose();
    });

    it('dispose removes the button, its anchor and any open grid', () => {
        const { button, picker } = open();
        button.click();
        expect(container.querySelector('.swatch-grid')).toBeTruthy();
        picker.dispose();
        expect(container.querySelector('button.bg-color-button')).toBeNull();
        expect(container.querySelector('.swatch-grid')).toBeNull();
        expect(container.children).toHaveLength(0);
    });

    it('opens the grid inside an anchor around its button', () => {
        const { button, picker } = open();

        button.click();

        expect([...container.children].map((el) => el.className)).toEqual(['swatch-anchor']);
        const anchor = container.firstElementChild!;
        expect(button.parentElement).toBe(anchor);
        expect(container.querySelector('.swatch-grid')!.parentElement).toBe(anchor);
        picker.dispose();
    });
});

describe('setSelected', () => {
    it('marks the externally-set swatch as selected on the next open', () => {
        const onSelect = vi.fn();
        const picker = createSwatchPicker({
            container: document.body,
            button: { icon: 'X', title: 'Pick', className: 'pick-btn' },
            ariaLabel: 'Pick',
            swatches: [
                { id: 'a', label: 'A', color: '#aaa' },
                { id: 'b', label: 'B', color: '#bbb' },
            ],
            selectedId: 'a',
            onSelect,
        });

        picker.setSelected('b');

        document.querySelector<HTMLButtonElement>('.pick-btn')!.click();
        const selected = document.querySelector('.swatch--selected');
        expect(selected?.getAttribute('data-swatch-id')).toBe('b');
        expect(onSelect).not.toHaveBeenCalled();
        picker.dispose();
    });

    it('dismisses an open panel so a stale highlight cannot linger', () => {
        const picker = createSwatchPicker({
            container: document.body,
            button: { icon: 'X', title: 'Pick', className: 'pick-btn' },
            ariaLabel: 'Pick',
            swatches: [{ id: 'a', label: 'A', color: '#aaa' }],
            selectedId: 'a',
            onSelect: () => {},
        });
        document.querySelector<HTMLButtonElement>('.pick-btn')!.click();
        picker.setSelected('b');
        expect(document.querySelector('.swatch-grid')).toBeNull();
        picker.dispose();
    });
});
