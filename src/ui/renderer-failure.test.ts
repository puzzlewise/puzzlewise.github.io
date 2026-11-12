/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showRendererFailure } from './renderer-failure.js';

describe('showRendererFailure', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.replaceChildren(container);
    });

    it('showRendererFailure unsupported renders the exact copy', () => {
        showRendererFailure(container, 'unsupported');

        expect(container.querySelector('.renderer-failure-body')?.textContent)
            .toBe("Puzzlewise needs WebGL 2, which this browser doesn't support.");
        expect(container.querySelectorAll('button')).toHaveLength(0);
    });

    it('showRendererFailure lost renders a Reload button', () => {
        const reload = vi.fn();
        showRendererFailure(container, 'lost', reload);

        expect(container.querySelector('.renderer-failure-body')?.textContent).toBe('Graphics stopped working.');
        const buttons = container.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Reload');
        expect(reload).not.toHaveBeenCalled();
        buttons[0].click();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it.each(['unsupported', 'lost'] as const)('is a named alertdialog described by its message (%s)', (kind) => {
        showRendererFailure(container, kind, vi.fn());

        const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.getAttribute('aria-label')).toBeTruthy();
        const describedBy = dialog!.getAttribute('aria-describedby');
        expect(describedBy).toBeTruthy();
        expect(document.getElementById(describedBy!)).toBe(container.querySelector('.renderer-failure-body'));
    });

    it('focuses Reload when the context is lost', () => {
        showRendererFailure(container, 'lost', vi.fn());

        expect(document.activeElement).toBe(container.querySelector('button'));
    });

    it('makes what was already in the container inert', () => {
        const toolbar = document.createElement('div');
        container.appendChild(toolbar);

        showRendererFailure(container, 'lost', vi.fn());

        expect(toolbar.hasAttribute('inert')).toBe(true);
    });

    it('cannot be dismissed', () => {
        showRendererFailure(container, 'unsupported');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        container.querySelector<HTMLElement>('.renderer-failure-overlay')!.click();

        expect(container.querySelector('.renderer-failure-body')).not.toBeNull();
    });
});
