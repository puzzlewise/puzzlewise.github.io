/**
 * `onDismiss` fires only for helper-owned dismissal paths, not when the caller
 * invokes `dismiss()` directly — so a "closed without choosing" callback can be
 * wired through while button handlers dismiss without firing it.
 */

export type ModalDismissTrigger = 'backdrop' | 'any-click' | 'none';

export type OverlayDismissCause = 'escape' | 'click';

export interface DismissableOverlayOptions {
    container: HTMLElement;
    className: string;
    /** Not fired when the caller invokes `dismiss()` directly. */
    onDismiss?: (cause: OverlayDismissCause) => void;
    /** Default true. */
    dismissOnEscape?: boolean;
    /** Default 'backdrop'. */
    dismissOn?: ModalDismissTrigger;
}

export interface DismissableOverlayHandle {
    overlay: HTMLDivElement;
    /** Idempotent. */
    dismiss: () => void;
}

export function createDismissableOverlay(
    options: DismissableOverlayOptions,
): DismissableOverlayHandle {
    const {
        container,
        className,
        onDismiss,
        dismissOnEscape = true,
        dismissOn = 'backdrop',
    } = options;

    const overlay = document.createElement('div');
    overlay.className = className;
    overlay.tabIndex = -1;

    const focusBeforeOverlay = document.activeElement;
    let disposed = false;

    function dismiss(): void {
        if (disposed) return;
        disposed = true;
        const active = document.activeElement;
        const ownsFocus = active === null || active === document.body || overlay.contains(active);
        overlay.remove();
        if (dismissOnEscape) {
            document.removeEventListener('keydown', handleKeyDown);
        }
        if (ownsFocus && focusBeforeOverlay instanceof HTMLElement) {
            focusBeforeOverlay.focus({ preventScroll: true });
        }
    }

    function userDismiss(cause: OverlayDismissCause): void {
        if (disposed) return;
        dismiss();
        onDismiss?.(cause);
    }

    function handleKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            userDismiss('escape');
        }
    }

    if (dismissOn === 'backdrop') {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                userDismiss('click');
            }
        });
    } else if (dismissOn === 'any-click') {
        overlay.addEventListener('click', () => userDismiss('click'));
    }

    if (dismissOnEscape) {
        document.addEventListener('keydown', handleKeyDown);
    }

    container.appendChild(overlay);
    overlay.focus();

    return { overlay, dismiss };
}

export interface DismissablePopoverOptions {
    panel: HTMLElement;
    /**
     * Pointerdowns on this element (or its descendants) are ignored, so the
     * toggle's own click handler owns open/close.
     */
    anchor?: HTMLElement;
    /** Not fired when the caller invokes `dismiss()` directly. */
    onDismiss?: () => void;
    /** Default true. */
    dismissOnEscape?: boolean;
}

export interface DismissablePopoverHandle {
    /** Idempotent. */
    dismiss: () => void;
}

export function attachDismissablePopover(
    options: DismissablePopoverOptions,
): DismissablePopoverHandle {
    const { panel, anchor, onDismiss, dismissOnEscape = true } = options;

    let disposed = false;
    let pointerDownListener: ((e: PointerEvent) => void) | null = null;
    let keyListener: ((e: KeyboardEvent) => void) | null = null;

    function dismiss(): void {
        if (disposed) return;
        disposed = true;
        panel.remove();
        if (pointerDownListener) {
            document.removeEventListener(
                'pointerdown',
                pointerDownListener,
                true,
            );
            pointerDownListener = null;
        }
        if (keyListener) {
            document.removeEventListener('keydown', keyListener);
            keyListener = null;
        }
    }

    function userDismiss(): void {
        if (disposed) return;
        dismiss();
        onDismiss?.();
    }

    // Defer listener installation so the click that opened the popover
    // doesn't immediately close it again.
    requestAnimationFrame(() => {
        if (disposed) return;

        // Capture phase so the dismiss fires reliably even when other
        // listeners (drag handlers) capture pointer events at lower nodes.
        pointerDownListener = (e: PointerEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (panel.contains(target)) return;
            if (anchor?.contains(target)) return;
            userDismiss();
        };
        document.addEventListener('pointerdown', pointerDownListener, true);

        if (dismissOnEscape) {
            keyListener = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    userDismiss();
                }
            };
            document.addEventListener('keydown', keyListener);
        }
    });

    return { dismiss };
}
