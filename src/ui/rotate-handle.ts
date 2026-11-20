import type { RotationFocus } from '../interaction/rotation-focus.js';
import iconSvgSource from './rotate-handle-icon.svg?raw';

const BUTTON_SIZE_PX = 44;
const BUTTON_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 12;
const IDLE_TIMEOUT_MS = 5000;
const QUICK_FADE_MS = 100;
const SLOW_FADE_MS = 750;

export interface RotateHandleOptions {
    container: HTMLElement;
    rotationFocus: RotationFocus;
    /** Emitted continuously during drag with an additive delta. */
    onRotate: (groupId: number, deltaDegrees: number) => void;
    /** Emitted on drag end, after the final `onRotate`; the host runs merge-detection here. */
    onCommit: (groupId: number) => void;
    /** Emitted at drag start (pointerdown), before the first onRotate. Returns the
     * world-space pivot, or null to decline — no drag starts and no onRotateEnd
     * follows. Fires exactly once per drag, so hosts may latch per-gesture state. */
    onRotateStart: (groupId: number) => { x: number; y: number } | null;
    /** Emitted when a drag ends — on commit AND cancel — after any final
     * onRotate/onCommit. Guarantees release of the latch onRotateStart acquires,
     * so it can't leak into the next drag. */
    onRotateEnd: (groupId: number) => void;
    getFocusedGroupScreenBounds: (groupId: number) =>
        | { left: number; right: number; top: number; bottom: number }
        | null;
    getViewportSize?: () => { width: number; height: number };
    /** Current rotation of the focused group, in degrees. */
    getGroupRotation: (groupId: number) => number | null;
    screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
}

export interface RotateHandleHandle {
    show: () => void;
    hide: () => void;
    destroy: () => void;
}

interface ActiveHandle {
    groupId: number;
    button: HTMLButtonElement;
    idleTimerId: ReturnType<typeof setTimeout> | null;
    removalTimerId: ReturnType<typeof setTimeout> | null;
    transitionEndListener: ((e: Event) => void) | null;
    state: 'visible' | 'fade-out-quick' | 'fade-out-slow';
    cancelDrag: () => void;
    isDragging: () => boolean;
}

let iconTemplate: SVGElement | null = null;

function makeBidirectionalRotateIcon(): SVGElement {
    if (!iconTemplate) {
        const doc = new DOMParser().parseFromString(iconSvgSource, 'image/svg+xml');
        iconTemplate = document.importNode(doc.documentElement, /* deep */ true) as unknown as SVGElement;
    }
    return iconTemplate.cloneNode(true) as SVGElement;
}

function makeButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'rotate-handle';
    button.type = 'button';
    button.setAttribute('aria-label', 'Rotate selection (drag)');
    button.appendChild(makeBidirectionalRotateIcon());
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

export function createRotateHandle(
    options: RotateHandleOptions,
): RotateHandleHandle {
    const {
        container,
        rotationFocus,
        getFocusedGroupScreenBounds,
        getViewportSize = defaultViewportSize,
    } = options;

    let shown = false;
    let active: ActiveHandle | null = null;
    let unsubscribeFocus: (() => void) | null = null;

    function placeButton(button: HTMLButtonElement, leftPx: number, topPx: number): void {
        button.style.left = `${leftPx}px`;
        button.style.top = `${topPx}px`;
    }

    function spawn(groupId: number): void {
        const bounds = getFocusedGroupScreenBounds(groupId);
        if (!bounds) return;
        const viewport = getViewportSize();

        const button = makeButton();

        const naturalLeft = (bounds.left + bounds.right) / 2 - BUTTON_SIZE_PX / 2;
        const naturalTop = bounds.bottom + BUTTON_GAP_PX;

        const maxLeft = viewport.width - BUTTON_SIZE_PX - VIEWPORT_MARGIN_PX;
        const maxTop = viewport.height - BUTTON_SIZE_PX - VIEWPORT_MARGIN_PX;

        placeButton(
            button,
            clamp(naturalLeft, VIEWPORT_MARGIN_PX, maxLeft),
            clamp(naturalTop, VIEWPORT_MARGIN_PX, maxTop),
        );

        container.appendChild(button);

        let drag: {
            pivot: { x: number; y: number };
            initialRotation: number;
            initialAngleRad: number;
            pointerId: number;
            extraPointerListener: (e: PointerEvent) => void;
        } | null = null;

        function finalizeDrag(commit: boolean): void {
            if (!drag) return;
            if (button.hasPointerCapture(drag.pointerId)) {
                button.releasePointerCapture(drag.pointerId);
            }
            window.removeEventListener('pointerdown', drag.extraPointerListener, true);
            drag = null;
            // Use the spawn closure's groupId, not active?.groupId: a focus change
            // nulls `active` before cancelling the drag, and skipping onRotateEnd
            // would leak the host's per-gesture pivot latch into the next drag.
            if (commit) {
                options.onCommit(groupId);
            }
            options.onRotateEnd(groupId);
            startIdleTimer();
        }

        function cancelDrag(): void {
            finalizeDrag(/* commit */ false);
        }

        button.addEventListener('pointerdown', (event) => {
            if (drag !== null) return;
            const initialRotation = options.getGroupRotation(groupId);
            if (initialRotation === null) return;
            // Guard rotation first so a declined drag never leaves the host an
            // opened gesture to unwind.
            const pivot = options.onRotateStart(groupId);
            if (!pivot) return;

            const Q0 = options.screenToWorld(event.clientX, event.clientY);
            const initialAngleRad = Math.atan2(Q0.y - pivot.y, Q0.x - pivot.x);

            button.setPointerCapture(event.pointerId);

            // Multi-finger cancel: a second pointerdown anywhere ends the drag.
            const extraPointerListener = (e: PointerEvent): void => {
                if (e.pointerId === event.pointerId) return;
                cancelDrag();
            };
            window.addEventListener('pointerdown', extraPointerListener, true);

            drag = {
                pivot,
                initialRotation,
                initialAngleRad,
                pointerId: event.pointerId,
                extraPointerListener,
            };

            if (active && active.state !== 'visible') rescueActive();
            clearIdleTimer();
            event.preventDefault();
        });

        button.addEventListener('pointermove', (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            const Q = options.screenToWorld(event.clientX, event.clientY);
            const angleRad = Math.atan2(Q.y - drag.pivot.y, Q.x - drag.pivot.x);
            const deltaDeg = ((angleRad - drag.initialAngleRad) * 180) / Math.PI;
            const targetRotation = drag.initialRotation + deltaDeg;
            const currentRotation = options.getGroupRotation(groupId);
            if (currentRotation === null) return;
            options.onRotate(groupId, targetRotation - currentRotation);
        });

        button.addEventListener('pointerup', (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            finalizeDrag(/* commit */ true);
        });

        button.addEventListener('pointercancel', (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            finalizeDrag(/* commit */ false);
        });

        // Force a reflow so the browser registers the base-rule opacity:0
        // before the fade-in class lands (mirrors rotate-buttons.ts).
        void button.offsetHeight;
        button.classList.add('rotate-handle--fade-in');

        active = {
            groupId,
            button,
            idleTimerId: null,
            removalTimerId: null,
            transitionEndListener: null,
            state: 'visible',
            cancelDrag,
            isDragging: () => drag !== null,
        };
        startIdleTimer();
    }

    function rescueActive(): void {
        if (!active) return;
        cancelRemoval(active);
        if (active.idleTimerId !== null) {
            clearTimeout(active.idleTimerId);
            active.idleTimerId = null;
        }
        active.button.classList.remove(
            'rotate-handle--fade-out-slow',
            'rotate-handle--fade-out-quick',
        );
        active.button.classList.add('rotate-handle--fade-in');
        active.state = 'visible';
    }

    function startIdleTimer(): void {
        if (!active) return;
        if (active.idleTimerId !== null) clearTimeout(active.idleTimerId);
        active.idleTimerId = setTimeout(startSlowFadeOut, IDLE_TIMEOUT_MS);
    }

    function clearIdleTimer(): void {
        if (active && active.idleTimerId !== null) {
            clearTimeout(active.idleTimerId);
            active.idleTimerId = null;
        }
    }

    function startSlowFadeOut(): void {
        if (!active) return;
        // Unreachable today (idle timer cleared during drag); guards future
        // callers that might re-arm the timer mid-drag.
        if (active.isDragging()) return;
        clearIdleTimer();
        active.state = 'fade-out-slow';
        active.button.classList.remove('rotate-handle--fade-in');
        active.button.classList.add('rotate-handle--fade-out-slow');
        scheduleRemoval(active, SLOW_FADE_MS, /* clearFocusOnRemove */ true);
    }

    function startQuickFadeOut(handle: ActiveHandle): void {
        handle.cancelDrag();
        cancelRemoval(handle);
        if (handle.idleTimerId !== null) {
            clearTimeout(handle.idleTimerId);
            handle.idleTimerId = null;
        }
        handle.state = 'fade-out-quick';
        handle.button.classList.remove(
            'rotate-handle--fade-in',
            'rotate-handle--fade-out-slow',
        );
        handle.button.classList.add('rotate-handle--fade-out-quick');
        scheduleRemoval(handle, QUICK_FADE_MS, /* clearFocusOnRemove */ false);
    }

    function scheduleRemoval(
        handle: ActiveHandle,
        fallbackMs: number,
        clearFocusOnRemove: boolean,
    ): void {
        const onEnd = () => {
            if (handle.removalTimerId !== null) {
                clearTimeout(handle.removalTimerId);
                handle.removalTimerId = null;
            }
            handle.transitionEndListener = null;
            handle.button.removeEventListener('transitionend', onEnd);
            handle.button.remove();
            if (active === handle) active = null;
            if (clearFocusOnRemove) rotationFocus.clearFocus();
        };
        handle.transitionEndListener = onEnd;
        handle.button.addEventListener('transitionend', onEnd);
        handle.removalTimerId = setTimeout(onEnd, fallbackMs + 100);
    }

    function cancelRemoval(handle: ActiveHandle): void {
        if (handle.removalTimerId !== null) {
            clearTimeout(handle.removalTimerId);
            handle.removalTimerId = null;
        }
        if (handle.transitionEndListener !== null) {
            handle.button.removeEventListener('transitionend', handle.transitionEndListener);
            handle.transitionEndListener = null;
        }
    }

    function teardownActive(): void {
        if (!active) return;
        active.cancelDrag();
        if (active.idleTimerId !== null) clearTimeout(active.idleTimerId);
        if (active.removalTimerId !== null) clearTimeout(active.removalTimerId);
        if (active.transitionEndListener !== null) {
            active.button.removeEventListener('transitionend', active.transitionEndListener);
        }
        active.button.remove();
        active = null;
    }

    function handleFocusChange(focusedGroupId: number | null): void {
        if (!shown) return;
        if (focusedGroupId === null) {
            if (active) startQuickFadeOut(active);
            return;
        }
        if (active && active.groupId === focusedGroupId) {
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
        spawn(focusedGroupId);
    }

    return {
        show() {
            if (shown) return;
            shown = true;
            unsubscribeFocus = rotationFocus.onChange(handleFocusChange);
            if (rotationFocus.focusedGroupId !== null) {
                spawn(rotationFocus.focusedGroupId);
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
