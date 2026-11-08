import { createDismissableOverlay, type OverlayDismissCause } from './dismissable-overlay.js';

export type ModalDismissCause = 'button' | 'backdrop' | 'escape';

export interface ModalViewStats {
    openMs: number;
    seenPercent: number;
    scrolled: boolean;
}

export interface ModalShellOptions<C extends string> {
    container: HTMLElement;
    title: string;
    buildContent: (close: (closedBy: 'button' | C) => void) => readonly HTMLElement[];
    onClosed: (closedBy: ModalDismissCause | C, stats: ModalViewStats) => void;
}

const CLOSED_BY_OVERLAY_CAUSE: Record<OverlayDismissCause, ModalDismissCause> = {
    click: 'backdrop',
    escape: 'escape',
};

export function createModalShell<C extends string = never>(options: ModalShellOptions<C>): void {
    const { container, title, buildContent, onClosed } = options;
    const openedAt = Date.now();
    let maxSeen = 0;
    let scrolled = false;

    const { overlay, dismiss: dismissOverlay } = createDismissableOverlay({
        container,
        className: 'info-modal-overlay',
        onDismiss: (cause) => reportClosed(CLOSED_BY_OVERLAY_CAUSE[cause]),
    });

    function close(closedBy: 'button' | C): void {
        dismissOverlay();
        reportClosed(closedBy);
    }

    function reportClosed(closedBy: ModalDismissCause | C): void {
        onClosed(closedBy, {
            openMs: Date.now() - openedAt,
            seenPercent: Math.round(maxSeen * 100),
            scrolled,
        });
    }

    const modal = document.createElement('div');
    modal.className = 'info-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', title);

    const header = document.createElement('div');
    header.className = 'info-modal-header';

    const heading = document.createElement('h2');
    heading.className = 'info-modal-title';
    heading.textContent = title;

    const closeButton = document.createElement('button');
    closeButton.className = 'info-modal-close';
    closeButton.textContent = '✕';
    closeButton.type = 'button';
    closeButton.title = 'Close';
    closeButton.addEventListener('click', () => close('button'));

    header.appendChild(heading);
    header.appendChild(closeButton);

    const content = document.createElement('div');
    content.className = 'info-modal-content';
    content.tabIndex = -1;
    content.append(...buildContent(close));

    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    content.focus({ preventScroll: true });

    function sampleSeen(): void {
        const { scrollTop, clientHeight, scrollHeight } = content;
        const seen = scrollHeight > clientHeight ? (scrollTop + clientHeight) / scrollHeight : 1;
        maxSeen = Math.max(maxSeen, Math.min(seen, 1));
    }

    content.addEventListener('scroll', () => {
        scrolled = true;
        sampleSeen();
    });
    sampleSeen();
}
