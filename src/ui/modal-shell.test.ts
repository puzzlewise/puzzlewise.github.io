/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createModalShell, type ModalDismissCause, type ModalViewStats } from './modal-shell.js';

describe('createModalShell', () => {
    let container: HTMLElement;
    let onClosed: Mock<(closedBy: ModalDismissCause | 'solve', stats: ModalViewStats) => void>;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        onClosed = vi.fn();
    });

    afterEach(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        container.remove();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    function open(buildContent: (close: (closedBy: 'button' | 'solve') => void) => readonly HTMLElement[] = () => []): void {
        createModalShell<'solve'>({ container, title: 'Help', buildContent, onClosed });
    }

    function stubContentGeometry(scrollHeight: number, clientHeight: number): void {
        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
    }

    function scrollContentTo(top: number): void {
        const content = container.querySelector<HTMLElement>('.info-modal-content')!;
        content.scrollTop = top;
        content.dispatchEvent(new Event('scroll'));
    }

    function clickClose(): void {
        container.querySelector<HTMLButtonElement>('.info-modal-close')!.click();
    }

    function closedStats(): ModalViewStats {
        expect(onClosed).toHaveBeenCalledOnce();
        return onClosed.mock.calls[0][1];
    }

    it('renders a dialog labelled by its title', () => {
        open();

        const dialog = container.querySelector('[role="dialog"]')!;
        expect(dialog.getAttribute('aria-label')).toBe('Help');
        expect(dialog.querySelector('.info-modal-title')!.textContent).toBe('Help');
    });

    it('appends the built content and focuses it', () => {
        const first = document.createElement('section');
        const second = document.createElement('section');
        open(() => [first, second]);

        const content = container.querySelector('.info-modal-content')!;
        expect([...content.children]).toEqual([first, second]);
        expect(document.activeElement).toBe(content);
    });

    it.each<[ModalDismissCause, () => void]>([
        ['button', () => clickClose()],
        ['backdrop', () => container.querySelector<HTMLElement>('.info-modal-overlay')!.click()],
        ['escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    ])('reports closedBy %s', (closedBy, close) => {
        open();

        close();

        expect(onClosed).toHaveBeenCalledExactlyOnceWith(closedBy, expect.any(Object));
        expect(container.querySelector('.info-modal-overlay')).toBeNull();
    });

    it('passes a caller close cause through', () => {
        let close!: (closedBy: 'button' | 'solve') => void;
        open((c) => {
            close = c;
            return [];
        });

        close('solve');

        expect(onClosed).toHaveBeenCalledExactlyOnceWith('solve', expect.any(Object));
        expect(container.querySelector('.info-modal-overlay')).toBeNull();
    });

    it('reports how long the modal was open', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        open();

        vi.setSystemTime(1_004_200);
        clickClose();

        expect(closedStats()).toMatchObject({ openMs: 4200 });
    });

    it('reports everything seen and no scroll when the content fits', () => {
        stubContentGeometry(400, 400);
        open();

        clickClose();

        expect(closedStats()).toMatchObject({ seenPercent: 100, scrolled: false });
    });

    it('reports the share visible on open when the content is never scrolled', () => {
        stubContentGeometry(1000, 400);
        open();

        clickClose();

        expect(closedStats()).toMatchObject({ seenPercent: 40, scrolled: false });
    });

    it('reports the furthest point reached, even after scrolling back up', () => {
        stubContentGeometry(1000, 400);
        open();

        scrollContentTo(300);
        scrollContentTo(0);
        clickClose();

        expect(closedStats()).toMatchObject({ seenPercent: 70, scrolled: true });
    });

    it('caps seenPercent at 100 when an overscroll reports a scrollTop past the end', () => {
        stubContentGeometry(1000, 400);
        open();

        scrollContentTo(700);
        clickClose();

        expect(closedStats()).toMatchObject({ seenPercent: 100 });
    });
});
