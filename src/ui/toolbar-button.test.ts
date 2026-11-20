/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createToolbarButton } from './toolbar-button.js';

function makeIcon(): SVGElement {
    return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
}

describe('createToolbarButton', () => {
    let container: HTMLElement;
    let onClick: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
        container = document.createElement('div');
        onClick = vi.fn<() => void>();
    });

    it('should append a button to the container', () => {
        createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo',
            icon: makeIcon(),
            onClick,
        });

        const button = container.querySelector('button');
        expect(button).not.toBeNull();
    });

    it('should set the className', () => {
        createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo',
            icon: makeIcon(),
            onClick,
        });

        const button = container.querySelector('button')!;
        expect(button.className).toBe('demo-button');
    });

    it('shows the icon and names the button with the label', () => {
        const icon = makeIcon();
        createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo Label',
            icon,
            onClick,
        });

        const button = container.querySelector('button')!;
        expect([...button.childNodes]).toEqual([icon]);
        expect(button.getAttribute('aria-label')).toBe('Demo Label');
        expect(button.title).toBe('Demo Label');
    });

    it('should set type="button"', () => {
        createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo',
            icon: makeIcon(),
            onClick,
        });

        const button = container.querySelector('button')!;
        expect(button.type).toBe('button');
    });

    it('should call onClick when clicked', () => {
        createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo',
            icon: makeIcon(),
            onClick,
        });

        const button = container.querySelector('button')!;
        button.click();

        expect(onClick).toHaveBeenCalledOnce();
    });

    it('should call onClick on each click', () => {
        createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo',
            icon: makeIcon(),
            onClick,
        });

        const button = container.querySelector('button')!;
        button.click();
        button.click();
        button.click();

        expect(onClick).toHaveBeenCalledTimes(3);
    });

    it('should remove button on cleanup', () => {
        const cleanup = createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo',
            icon: makeIcon(),
            onClick,
        });

        expect(container.querySelector('button')).not.toBeNull();

        cleanup();

        expect(container.querySelector('button')).toBeNull();
    });

    it('should not respond to clicks after cleanup', () => {
        const cleanup = createToolbarButton({
            container,
            className: 'demo-button',
            label: 'Demo',
            icon: makeIcon(),
            onClick,
        });

        const button = container.querySelector('button')!;
        cleanup();

        // Button is detached but click would still fire if listener remained
        button.click();

        expect(onClick).not.toHaveBeenCalled();
    });
});
