/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import {
    attachDismissablePopover,
    createDismissableOverlay,
} from './dismissable-overlay.js';

function makePanel(className = 'test-popover'): HTMLDivElement {
    const panel = document.createElement('div');
    panel.className = className;
    return panel;
}

describe('createDismissableOverlay', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('appends an overlay with the given class to the container', () => {
        createDismissableOverlay({ container, className: 'test-overlay' });
        expect(container.querySelector('.test-overlay')).not.toBeNull();
    });

    it('returns the overlay element so callers can fill it', () => {
        const { overlay } = createDismissableOverlay({
            container,
            className: 'test-overlay',
        });
        const child = document.createElement('span');
        overlay.appendChild(child);
        expect(container.querySelector('.test-overlay > span')).toBe(child);
    });

    it('dismisses on backdrop click and fires onDismiss', () => {
        const onDismiss = vi.fn();
        const { overlay } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
        });
        overlay.click();

        expect(container.querySelector('.test-overlay')).toBeNull();
        expect(onDismiss).toHaveBeenCalledExactlyOnceWith('click');
    });

    it('does not dismiss when a child of the overlay is clicked', () => {
        const onDismiss = vi.fn();
        const { overlay } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
        });
        const child = document.createElement('div');
        overlay.appendChild(child);
        child.click();

        expect(container.querySelector('.test-overlay')).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('dismisses on Escape and fires onDismiss', () => {
        const onDismiss = vi.fn();
        createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
        });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(container.querySelector('.test-overlay')).toBeNull();
        expect(onDismiss).toHaveBeenCalledExactlyOnceWith('escape');
    });

    it('does not dismiss on Escape when dismissOnEscape is false', () => {
        const onDismiss = vi.fn();
        createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
            dismissOnEscape: false,
        });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(container.querySelector('.test-overlay')).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('dismissOn: any-click fires for clicks on overlay children too', () => {
        const onDismiss = vi.fn();
        const { overlay } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
            dismissOn: 'any-click',
        });
        const child = document.createElement('div');
        overlay.appendChild(child);
        child.click();

        expect(container.querySelector('.test-overlay')).toBeNull();
        expect(onDismiss).toHaveBeenCalledExactlyOnceWith('click');
    });

    it('dismissOn: any-click respects stopPropagation on inner buttons', () => {
        const onDismiss = vi.fn();
        const { overlay } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
            dismissOn: 'any-click',
        });
        const btn = document.createElement('button');
        btn.addEventListener('click', (e) => e.stopPropagation());
        overlay.appendChild(btn);
        btn.click();

        expect(container.querySelector('.test-overlay')).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('dismissOn: none ignores backdrop clicks', () => {
        const onDismiss = vi.fn();
        const { overlay } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
            dismissOn: 'none',
        });
        overlay.click();

        expect(container.querySelector('.test-overlay')).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('handle.dismiss() removes the overlay without firing onDismiss', () => {
        const onDismiss = vi.fn();
        const { dismiss } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
        });
        dismiss();

        expect(container.querySelector('.test-overlay')).toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('removes the document keydown listener on dismiss', () => {
        const onDismiss = vi.fn();
        const { dismiss } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
        });
        dismiss();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('dismiss() is idempotent and safe to call twice', () => {
        const onDismiss = vi.fn();
        const { dismiss } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
        });
        dismiss();
        dismiss();

        expect(container.querySelector('.test-overlay')).toBeNull();
    });

    it('does not fire onDismiss after a backdrop dismiss when Escape is pressed later', () => {
        const onDismiss = vi.fn();
        const { overlay } = createDismissableOverlay({
            container,
            className: 'test-overlay',
            onDismiss,
        });
        overlay.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(onDismiss).toHaveBeenCalledOnce();
    });

    describe('focus', () => {
        let opener: HTMLButtonElement;

        beforeEach(() => {
            opener = document.createElement('button');
            container.appendChild(opener);
            opener.focus();
        });

        it('takes focus from the control that opened it', () => {
            // #664: left on the opener, Space/Enter re-clicked it and stacked a
            // second copy of the dialog.
            const { overlay } = createDismissableOverlay({ container, className: 'test-overlay' });

            expect(document.activeElement).toBe(overlay);
        });

        it('gives focus back to the opener on Escape', () => {
            createDismissableOverlay({ container, className: 'test-overlay' });
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(document.activeElement).toBe(opener);
        });

        it('gives focus back to the opener when dismissed from a control inside it', () => {
            const { overlay, dismiss } = createDismissableOverlay({
                container,
                className: 'test-overlay',
            });
            const inner = document.createElement('button');
            overlay.appendChild(inner);
            inner.focus();
            dismiss();

            expect(document.activeElement).toBe(opener);
        });

        it('gives focus back to the opener when focus inside it was lost', () => {
            const { overlay, dismiss } = createDismissableOverlay({
                container,
                className: 'test-overlay',
            });
            const inner = document.createElement('button');
            overlay.appendChild(inner);
            inner.focus();
            inner.remove();
            dismiss();

            expect(document.activeElement).toBe(opener);
        });

        it('leaves focus alone when something outside it has taken focus', () => {
            const { dismiss } = createDismissableOverlay({ container, className: 'test-overlay' });
            const elsewhere = document.createElement('button');
            container.appendChild(elsewhere);
            elsewhere.focus();
            dismiss();

            expect(document.activeElement).toBe(elsewhere);
        });

        it('makes the rest of its container inert, and nothing outside the container', () => {
            const outsideContainer = document.createElement('button');
            document.body.appendChild(outsideContainer);
            onTestFinished(() => outsideContainer.remove());
            createDismissableOverlay({ container, className: 'test-overlay' });

            expect(opener.hasAttribute('inert')).toBe(true);
            expect(container.hasAttribute('inert')).toBe(false);
            expect(outsideContainer.hasAttribute('inert')).toBe(false);
        });

        it('lifts the inert it set on dismiss, before giving focus back', () => {
            const { dismiss } = createDismissableOverlay({ container, className: 'test-overlay' });
            let inertWhenFocused: boolean | undefined;
            vi.spyOn(opener, 'focus').mockImplementation(() => {
                inertWhenFocused = opener.hasAttribute('inert');
            });
            dismiss();

            expect(opener.hasAttribute('inert')).toBe(false);
            expect(inertWhenFocused).toBe(false);
        });

        it('leaves inert it did not set in place on dismiss', () => {
            const alreadyInert = document.createElement('div');
            alreadyInert.setAttribute('inert', '');
            container.appendChild(alreadyInert);
            const { dismiss } = createDismissableOverlay({ container, className: 'test-overlay' });
            dismiss();

            expect(alreadyInert.hasAttribute('inert')).toBe(true);
        });

        it('keeps the background inert while a stacked overlay closes', () => {
            const first = createDismissableOverlay({ container, className: 'first' });
            const second = createDismissableOverlay({ container, className: 'second' });

            expect(first.overlay.hasAttribute('inert')).toBe(true);
            second.dismiss();

            expect(first.overlay.hasAttribute('inert')).toBe(false);
            expect(opener.hasAttribute('inert')).toBe(true);
            first.dismiss();

            expect(opener.hasAttribute('inert')).toBe(false);
        });

        it('closes only the top overlay on Escape and gives focus back to the one below', () => {
            const firstDismissed = vi.fn();
            const first = createDismissableOverlay({
                container,
                className: 'first',
                onDismiss: firstDismissed,
            });
            createDismissableOverlay({ container, className: 'second' });
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(container.querySelector('.second')).toBeNull();
            expect(first.overlay.isConnected).toBe(true);
            expect(firstDismissed).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(first.overlay);
            first.dismiss();
        });

        it('ignores Escape while inside an inert ancestor', () => {
            // The loading overlay makes `#app` inert and handles Escape itself.
            const onDismiss = vi.fn();
            const { overlay, dismiss } = createDismissableOverlay({
                container,
                className: 'test-overlay',
                onDismiss,
            });
            container.setAttribute('inert', '');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(overlay.isConnected).toBe(true);
            expect(onDismiss).not.toHaveBeenCalled();
            container.removeAttribute('inert');
            dismiss();
        });
    });
});

describe('attachDismissablePopover', () => {
    let anchor: HTMLButtonElement;
    let originalRAF: typeof requestAnimationFrame;

    beforeEach(() => {
        anchor = document.createElement('button');
        document.body.appendChild(anchor);

        // Run the install RAF synchronously so tests needn't wait a frame to
        // dispatch outside-pointerdown.
        originalRAF = window.requestAnimationFrame;
        window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        }) as typeof requestAnimationFrame;
    });

    afterEach(() => {
        window.requestAnimationFrame = originalRAF;
        anchor.remove();
        document
            .querySelectorAll('.test-popover')
            .forEach((el) => el.remove());
    });

    it('dismisses on outside pointerdown and fires onDismiss', () => {
        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        attachDismissablePopover({ panel, anchor, onDismiss });

        const outside = document.createElement('div');
        document.body.appendChild(outside);
        outside.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }),
        );

        expect(document.querySelector('.test-popover')).toBeNull();
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('does not dismiss on pointerdown inside the panel', () => {
        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        attachDismissablePopover({ panel, anchor, onDismiss });

        const inner = document.createElement('button');
        panel.appendChild(inner);
        inner.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }),
        );

        expect(document.querySelector('.test-popover')).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('does not dismiss on pointerdown on the anchor', () => {
        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        attachDismissablePopover({ panel, anchor, onDismiss });

        anchor.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }),
        );

        expect(document.querySelector('.test-popover')).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('dismisses on Escape and fires onDismiss', () => {
        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        attachDismissablePopover({ panel, anchor, onDismiss });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(document.querySelector('.test-popover')).toBeNull();
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('does not dismiss on Escape when dismissOnEscape is false', () => {
        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        attachDismissablePopover({
            panel,
            anchor,
            onDismiss,
            dismissOnEscape: false,
        });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(document.querySelector('.test-popover')).not.toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('handle.dismiss() removes the panel without firing onDismiss', () => {
        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        const { dismiss } = attachDismissablePopover({
            panel,
            anchor,
            onDismiss,
        });

        dismiss();

        expect(document.querySelector('.test-popover')).toBeNull();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('removes document listeners on dismiss', () => {
        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        const { dismiss } = attachDismissablePopover({
            panel,
            anchor,
            onDismiss,
        });

        dismiss();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        outside.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }),
        );

        expect(onDismiss).not.toHaveBeenCalled();
    });

    describe('Escape with an overlay open', () => {
        let container: HTMLElement;

        beforeEach(() => {
            container = document.createElement('div');
            document.body.appendChild(container);
        });

        afterEach(() => {
            container.remove();
        });

        it('closes a popover inside the overlay and leaves the overlay open', () => {
            const overlayDismissed = vi.fn();
            const { overlay, dismiss } = createDismissableOverlay({
                container,
                className: 'test-overlay',
                onDismiss: overlayDismissed,
            });
            const panel = makePanel();
            overlay.appendChild(panel);
            const popoverDismissed = vi.fn();
            attachDismissablePopover({ panel, onDismiss: popoverDismissed });
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(panel.isConnected).toBe(false);
            expect(popoverDismissed).toHaveBeenCalledOnce();
            expect(overlay.isConnected).toBe(true);
            expect(overlayDismissed).not.toHaveBeenCalled();
            dismiss();
        });

        it('closes the overlay and leaves a popover behind it open', () => {
            const panel = makePanel();
            container.appendChild(panel);
            const popoverDismissed = vi.fn();
            const popover = attachDismissablePopover({ panel, onDismiss: popoverDismissed });
            const { overlay } = createDismissableOverlay({ container, className: 'test-overlay' });
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(overlay.isConnected).toBe(false);
            expect(panel.isConnected).toBe(true);
            expect(popoverDismissed).not.toHaveBeenCalled();
            popover.dismiss();
        });

        it('leaves Escape to the next overlay once the one holding the popover has closed', () => {
            const first = createDismissableOverlay({ container, className: 'first' });
            const panel = makePanel();
            first.overlay.appendChild(panel);
            attachDismissablePopover({ panel });
            first.dismiss();
            const secondDismissed = vi.fn();
            createDismissableOverlay({
                container,
                className: 'second',
                onDismiss: secondDismissed,
            });
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(secondDismissed).toHaveBeenCalledExactlyOnceWith('escape');
        });
    });

    it('skips listener install if dismiss runs before the deferred frame', () => {
        // Restore real RAF for this test so installation truly defers.
        window.requestAnimationFrame = originalRAF;

        const onDismiss = vi.fn();
        const panel = makePanel();
        anchor.after(panel);
        const { dismiss } = attachDismissablePopover({
            panel,
            anchor,
            onDismiss,
        });
        dismiss();

        // Force any queued RAF callback to flush.
        return new Promise<void>((resolve) => {
            originalRAF(() => {
                document.dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Escape' }),
                );
                expect(onDismiss).not.toHaveBeenCalled();
                resolve();
            });
        });
    });
});
