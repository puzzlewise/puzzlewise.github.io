/**
 * Puzzle generation can take a second or two on older devices; without this,
 * shared-link recipients in particular see a dead page with no feedback.
 */

const OVERLAY_CLASS = 'loading-overlay';
const TEXT_CLASS = 'loading-overlay__text';
const SPINNER_CLASS = 'loading-overlay__spinner';
const CANCEL_CLASS = 'loading-overlay__cancel';

export interface ShowLoadingOverlayOptions {
    /** Called on Cancel-button click or Escape while the overlay is up. */
    onCancel?: () => void;
}

const APP_ROOT_SELECTOR = '#app';

let cancelHandler: (() => void) | null = null;

/** Where focus was before the overlay took or destroyed it; put back by
 * {@link hideLoadingOverlay}. */
let focusBeforeOverlay: HTMLElement | null = null;

function restorableFocusTarget(active: Element | null): HTMLElement | null {
    return active instanceof HTMLElement && active !== document.body ? active : null;
}

function onOverlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') cancelHandler?.();
}

function onCancelClick(): void {
    cancelHandler?.();
}

/**
 * The overlay is modal to the pointer but has no focus trap, so Shift+Tab off
 * Cancel would otherwise reach the toolbar behind it and start a second flow.
 * `inert` makes the keyboard agree with the pointer.
 */
function setAppInert(inert: boolean): void {
    const app = document.querySelector<HTMLElement>(APP_ROOT_SELECTOR);
    if (!app) return;
    if (inert) app.setAttribute('inert', '');
    else app.removeAttribute('inert');
}

export function showLoadingOverlay(
    text: string = 'Building puzzle…',
    options: ShowLoadingOverlayOptions = {},
): void {
    let overlay = document.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`);
    const overlayWasUp = overlay !== null;
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = OVERLAY_CLASS;

        const spinner = document.createElement('div');
        spinner.className = SPINNER_CLASS;
        overlay.appendChild(spinner);

        // The live region is the text, not the overlay: a role="status" wrapper
        // would make the Cancel button (a sibling) part of a status announcement.
        // index.html's pre-rendered overlay marks it up the same way.
        const label = document.createElement('div');
        label.className = TEXT_CLASS;
        label.setAttribute('role', 'status');
        label.setAttribute('aria-live', 'polite');
        label.textContent = text;
        overlay.appendChild(label);

        document.body.appendChild(overlay);
    } else {
        const label = overlay.querySelector<HTMLElement>(`.${TEXT_CLASS}`);
        if (label) label.textContent = text;
    }

    // Both next statements destroy focus (`inert` blurs the app root, Cancel
    // takes it), so the save precedes both. A re-show skips it: focus is by then
    // the overlay's own Cancel button, and re-capturing would lose the original.
    if (!overlayWasUp) focusBeforeOverlay = restorableFocusTarget(document.activeElement);
    setAppInert(true);
    syncCancelButton(overlay, options.onCancel);
}

function syncCancelButton(
    overlay: HTMLElement,
    onCancel: (() => void) | undefined,
): void {
    cancelHandler = onCancel ?? null;
    let button = overlay.querySelector<HTMLButtonElement>(`.${CANCEL_CLASS}`);

    if (!onCancel) {
        button?.remove();
        document.removeEventListener('keydown', onOverlayKeydown);
        return;
    }

    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = CANCEL_CLASS;
        button.textContent = 'Cancel';
        overlay.appendChild(button);
        // Focus on creation only: without it, discovering Cancel without sight
        // means guessing Escape works (focus also enables Enter/Space). Not
        // hoisted to the listener below — a re-show must leave focus put.
        button.focus();
    }
    // Both listeners register unconditionally: stable module-level callbacks make
    // a duplicate addEventListener a spec no-op. Wiring click in the creation
    // branch would leave the button inert if index.html ever pre-renders it.
    button.addEventListener('click', onCancelClick);
    document.addEventListener('keydown', onOverlayKeydown);
}

export function hideLoadingOverlay(): void {
    cancelHandler = null;
    document.removeEventListener('keydown', onOverlayKeydown);
    document.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`)?.remove();
    setAppInert(false);
    // After the un-inert, which would otherwise reject the focus call.
    if (focusBeforeOverlay?.isConnected) focusBeforeOverlay.focus();
    focusBeforeOverlay = null;
}

/**
 * Call after `showLoadingOverlay` and before a synchronous heavy-work burst so
 * the overlay actually paints.
 */
export function yieldForPaint(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            setTimeout(resolve, 0);
        });
    });
}
