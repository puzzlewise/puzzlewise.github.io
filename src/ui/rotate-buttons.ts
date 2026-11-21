import type { RotationFocus } from '../interaction/rotation-focus.js';
import { createRotateIcon } from './tool-icons.js';

export type RotationDirection = 'cw' | 'ccw';

const BUTTON_SIZE_PX = 44;
const BUTTON_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 12;
const IDLE_TIMEOUT_MS = 5000;
const QUICK_FADE_MS = 100;
const SLOW_FADE_MS = 750;

export interface RotateButtonsOptions {
    container: HTMLElement;
    rotationFocus: RotationFocus;
    /** Rotate the given group by 90° in the given direction. */
    onRotate: (groupId: number, direction: RotationDirection) => void;
    /** Return `null` when the group cannot be located (e.g. just removed). */
    getFocusedGroupScreenBounds: (
        groupId: number,
    ) => { left: number; right: number; top: number; bottom: number } | null;
    /**
     * In CSS pixels. Defaults to `visualViewport`, falling back to
     * `window.innerWidth/Height`.
     */
    getViewportSize?: () => { width: number; height: number };
}

export interface RotateButtonsHandle {
    show: () => void;
    hide: () => void;
    destroy: () => void;
}

interface ActivePair {
    groupId: number;
    ccw: HTMLButtonElement;
    cw: HTMLButtonElement;
    idleTimerId: ReturnType<typeof setTimeout> | null;
    removalTimerId: ReturnType<typeof setTimeout> | null;
    /** Bound on the CCW button only (either button works). */
    transitionEndListener: ((e: Event) => void) | null;
    state: 'visible' | 'fade-out-quick' | 'fade-out-slow';
}

function makeButton(modifier: 'ccw' | 'cw', label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `rotate-button rotate-button--${modifier}`;
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.appendChild(createRotateIcon(modifier));
    return button;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function defaultViewportSize(): { width: number; height: number } {
    return {
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
    };
}

export function createRotateButtons(
    options: RotateButtonsOptions,
): RotateButtonsHandle {
    const {
        container,
        rotationFocus,
        onRotate,
        getFocusedGroupScreenBounds,
        getViewportSize = defaultViewportSize,
    } = options;

    let shown = false;
    let active: ActivePair | null = null;
    let unsubscribeFocus: (() => void) | null = null;

    function placeButton(button: HTMLButtonElement, leftPx: number, topPx: number): void {
        button.style.left = `${leftPx}px`;
        button.style.top = `${topPx}px`;
    }

    function spawnPair(groupId: number): void {
        const bounds = getFocusedGroupScreenBounds(groupId);
        if (!bounds) return;
        const viewport = getViewportSize();

        const ccw = makeButton('ccw', 'Rotate selection 90° counter-clockwise');
        const cw = makeButton('cw', 'Rotate selection 90° clockwise');

        const midY = (bounds.top + bounds.bottom) / 2;
        const naturalCcwLeft = bounds.left - BUTTON_GAP_PX - BUTTON_SIZE_PX;
        const naturalCwLeft = bounds.right + BUTTON_GAP_PX;
        const naturalTop = midY - BUTTON_SIZE_PX / 2;

        const maxLeft = viewport.width - BUTTON_SIZE_PX - VIEWPORT_MARGIN_PX;
        const maxTop = viewport.height - BUTTON_SIZE_PX - VIEWPORT_MARGIN_PX;

        const ccwLeft = clamp(naturalCcwLeft, VIEWPORT_MARGIN_PX, maxLeft);
        const cwLeft = clamp(naturalCwLeft, VIEWPORT_MARGIN_PX, maxLeft);
        const topPx = clamp(naturalTop, VIEWPORT_MARGIN_PX, maxTop);

        placeButton(ccw, ccwLeft, topPx);
        placeButton(cw, cwLeft, topPx);

        ccw.addEventListener('click', () => handleRotateClick('ccw'));
        cw.addEventListener('click', () => handleRotateClick('cw'));

        container.appendChild(ccw);
        container.appendChild(cw);

        // Force a layout pass so the browser paints opacity:0 before --fade-in
        // lands; otherwise it sees both classes at once and skips the transition.
        void ccw.offsetHeight;

        ccw.classList.add('rotate-button--fade-in');
        cw.classList.add('rotate-button--fade-in');

        active = {
            groupId,
            ccw,
            cw,
            idleTimerId: null,
            removalTimerId: null,
            transitionEndListener: null,
            state: 'visible',
        };
        startIdleTimer();
    }

    function rescueActive(): void {
        if (!active) return;
        cancelPairRemoval(active);
        if (active.idleTimerId !== null) {
            clearTimeout(active.idleTimerId);
            active.idleTimerId = null;
        }
        active.ccw.classList.remove('rotate-button--fade-out-slow', 'rotate-button--fade-out-quick');
        active.cw.classList.remove('rotate-button--fade-out-slow', 'rotate-button--fade-out-quick');
        active.ccw.classList.add('rotate-button--fade-in');
        active.cw.classList.add('rotate-button--fade-in');
        active.state = 'visible';
    }

    function handleRotateClick(direction: RotationDirection): void {
        if (!active) return;
        const groupId = active.groupId;
        // pointer-events:none on quick-fade means clicks can only land on
        // visible or slowly-fading pairs.
        if (active.state !== 'visible') rescueActive();
        startIdleTimer();
        onRotate(groupId, direction);
    }

    function startIdleTimer(): void {
        if (!active) return;
        if (active.idleTimerId !== null) clearTimeout(active.idleTimerId);
        active.idleTimerId = setTimeout(() => {
            startSlowFadeOut();
        }, IDLE_TIMEOUT_MS);
    }

    function clearIdleTimer(): void {
        if (active && active.idleTimerId !== null) {
            clearTimeout(active.idleTimerId);
            active.idleTimerId = null;
        }
    }

    function startSlowFadeOut(): void {
        if (!active) return;
        clearIdleTimer();
        active.state = 'fade-out-slow';
        active.ccw.classList.remove('rotate-button--fade-in');
        active.cw.classList.remove('rotate-button--fade-in');
        active.ccw.classList.add('rotate-button--fade-out-slow');
        active.cw.classList.add('rotate-button--fade-out-slow');
        schedulePairRemoval(active, SLOW_FADE_MS, /* clearFocusOnRemove */ true);
    }

    function startQuickFadeOut(pair: ActivePair): void {
        // The pair may be mid slow-fade, upgraded to quick because focus moved away.
        cancelPairRemoval(pair);
        if (pair.idleTimerId !== null) {
            clearTimeout(pair.idleTimerId);
            pair.idleTimerId = null;
        }
        pair.state = 'fade-out-quick';
        pair.ccw.classList.remove('rotate-button--fade-in', 'rotate-button--fade-out-slow');
        pair.cw.classList.remove('rotate-button--fade-in', 'rotate-button--fade-out-slow');
        pair.ccw.classList.add('rotate-button--fade-out-quick');
        pair.cw.classList.add('rotate-button--fade-out-quick');
        schedulePairRemoval(pair, QUICK_FADE_MS, /* clearFocusOnRemove */ false);
    }

    function schedulePairRemoval(
        pair: ActivePair,
        fallbackMs: number,
        clearFocusOnRemove: boolean,
    ): void {
        const onEnd = () => {
            if (pair.removalTimerId !== null) {
                clearTimeout(pair.removalTimerId);
                pair.removalTimerId = null;
            }
            pair.transitionEndListener = null;
            pair.ccw.removeEventListener('transitionend', onEnd);
            pair.ccw.remove();
            pair.cw.remove();
            if (active === pair) active = null;
            if (clearFocusOnRemove) rotationFocus.clearFocus();
        };
        pair.transitionEndListener = onEnd;
        pair.ccw.addEventListener('transitionend', onEnd);
        // Fallback in case transitionend never fires (element removed before the
        // transition, or display:none). +100 outlasts a normal transition rather
        // than racing it.
        pair.removalTimerId = setTimeout(onEnd, fallbackMs + 100);
    }

    function cancelPairRemoval(pair: ActivePair): void {
        if (pair.removalTimerId !== null) {
            clearTimeout(pair.removalTimerId);
            pair.removalTimerId = null;
        }
        if (pair.transitionEndListener !== null) {
            pair.ccw.removeEventListener('transitionend', pair.transitionEndListener);
            pair.transitionEndListener = null;
        }
    }

    function teardownActive(): void {
        if (!active) return;
        if (active.idleTimerId !== null) clearTimeout(active.idleTimerId);
        if (active.removalTimerId !== null) clearTimeout(active.removalTimerId);
        if (active.transitionEndListener !== null) {
            active.ccw.removeEventListener('transitionend', active.transitionEndListener);
        }
        active.ccw.remove();
        active.cw.remove();
        active = null;
    }

    function handleFocusChange(focusedGroupId: number | null): void {
        if (!shown) return;
        if (focusedGroupId === null) {
            if (active) startQuickFadeOut(active);
            return;
        }
        if (active && active.groupId === focusedGroupId) {
            // RotationFocus fires only on change, so reaching here means focus was
            // cleared and re-set on the same piece within the quick-fade window.
            if (active.state !== 'visible') {
                rescueActive();
                startIdleTimer();
            }
            return;
        }
        if (active) {
            const old = active;
            active = null;
            startQuickFadeOut(old);
        }
        spawnPair(focusedGroupId);
    }

    return {
        show() {
            if (shown) return;
            shown = true;
            unsubscribeFocus = rotationFocus.onChange(handleFocusChange);
            if (rotationFocus.focusedGroupId !== null) {
                spawnPair(rotationFocus.focusedGroupId);
            }
        },
        hide() {
            if (!shown) return;
            shown = false;
            if (unsubscribeFocus) {
                unsubscribeFocus();
                unsubscribeFocus = null;
            }
            teardownActive();
        },
        destroy() {
            if (unsubscribeFocus) {
                unsubscribeFocus();
                unsubscribeFocus = null;
            }
            shown = false;
            teardownActive();
        },
    };
}
