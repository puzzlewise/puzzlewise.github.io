/**
 * PWA update controller — decides *when* a freshly-built service worker is
 * applied, without disrupting an in-progress puzzle. Every DOM / SW side
 * effect (flush autosave, activate the new SW, show the indicator) is injected,
 * keeping the decision logic unit-testable. `track` / `diagnostics` are
 * imported directly as fire-and-forget observability, not decision inputs.
 */

import { track, sanitizeErrorReason } from '../analytics/index.js';
import type { PwaUpdateAppliedData } from '../analytics/index.js';
import { diagnostics } from '../diagnostics.js';

/** Derived from the analytics payload — single source of truth, no new coupling. */
export type UpdateApplyTrigger = PwaUpdateAppliedData['trigger'];

export interface UpdatableRegistration {
    update(): Promise<unknown> | void;
}

export interface UpdateControllerDeps {
    /** Flush any pending autosave before the page reloads. */
    flush: () => void;
    /**
     * Render the persistent "update ready" indicator. The supplied callback
     * applies the update (reload) when the user taps it.
     */
    showIndicator: (onRefresh: () => void) => void;
    /** Defaults to a full-page reload. */
    reload?: () => void;
    /** Defaults to `globalThis.setTimeout`. */
    scheduleFallback?: (handler: () => void, ms: number) => void;
    /** Defaults to 3000 ms. */
    fallbackReloadMs?: number;
}

export interface UpdateController {
    /** A new service worker is waiting — remember it and surface the indicator. */
    onNeedRefresh(): void;
    /** Supply the `updateSW` function returned by `registerSW`. */
    setUpdateSW(updateSW: (reload?: boolean) => Promise<void>): void;
    requestReloadIfPending(): void;
    reloadNow(trigger?: UpdateApplyTrigger): void;
    /**
     * Another tab's update took over this page. Its worker is already active,
     * so there is nothing to activate or fall back from.
     */
    onControllerChange(): void;
    readonly pending: boolean;
}

export function createUpdateController(
    deps: UpdateControllerDeps,
): UpdateController {
    let pending = false;
    let updateSW: ((reload?: boolean) => Promise<void>) | null = null;
    let reloading = false;
    // Buffers a reload requested before `setUpdateSW` runs: `registerSW`
    // returns the `updateSW` handle only after it's called, so onNeedRefresh
    // (or a tap) can fire first — e.g. a worker already waiting on a warm
    // registration — and would otherwise silently no-op. The buffered value is
    // the original trigger, so the deferred apply reports how it was triggered.
    let bufferedTrigger: UpdateApplyTrigger | null = null;

    const reload = deps.reload ?? (() => location.reload());
    const scheduleFallback =
        deps.scheduleFallback ??
        ((handler: () => void, ms: number) => {
            globalThis.setTimeout(handler, ms);
        });
    const fallbackReloadMs = deps.fallbackReloadMs ?? DEFAULT_FALLBACK_RELOAD_MS;

    function apply(trigger: UpdateApplyTrigger): void {
        if (reloading) return;
        if (!updateSW) {
            bufferedTrigger = trigger;
            return;
        }
        // Latch on first call, never reset: once committed to reloading we stay
        // committed. The scheduled fallback covers an updateSW(true) rejection.
        reloading = true;
        track('pwa-update-applied', { trigger });
        deps.flush();
        // Surface a consistently-failing activation; the fallback still recovers.
        void Promise.resolve(updateSW(true)).catch((err: unknown) => {
            diagnostics.warn('[pwa] updateSW(true) rejected', err);
            track('pwa-update-apply-failed', {
                reason: sanitizeErrorReason(err),
            });
        });

        scheduleFallback(() => {
            track('pwa-update-fallback-reload', {});
            reload();
        }, fallbackReloadMs);
    }

    return {
        onNeedRefresh() {
            if (pending) return;
            pending = true;
            track('pwa-update-detected', {});
            deps.showIndicator(() => apply('manual'));
        },
        setUpdateSW(fn) {
            updateSW = fn;
            if (bufferedTrigger !== null) {
                const trigger = bufferedTrigger;
                bufferedTrigger = null;
                apply(trigger);
            }
        },
        requestReloadIfPending() {
            // Safe only because the save coordinator (app/save-coordinator.ts)
            // flushes the debounced save on visibilitychange→hidden / pagehide,
            // so progress is persisted before the app is backgrounded.
            if (pending) apply('focus-regain');
        },
        reloadNow(trigger = 'manual') {
            apply(trigger);
        },
        onControllerChange() {
            if (reloading) return;
            reloading = true;
            track('pwa-update-applied', { trigger: 'other-tab' });
            deps.flush();
            reload();
        },
        get pending() {
            return pending;
        },
    };
}

const DEFAULT_FALLBACK_RELOAD_MS = 3000;

export interface UpdateCheckDeps {
    addVisibilityListener?: (handler: () => void) => void;
    isVisible?: () => boolean;
}

/**
 * No background timer: a check at registration and on every
 * `visibilitychange → visible` (which also applies any pending update) cover
 * every case. An interval would only help a tab left open and foregrounded for
 * hours.
 *
 * The registration check is needed although navigations check too: a repeat
 * `register()` of the same script never fetches it, and the navigation's check
 * can install and fail before `register()` runs after `load`, leaving nothing
 * for `watchInstalls` to see. It costs one `sw.js` request per load, usually a
 * 304.
 */
export function setupUpdateChecks(
    registration: UpdatableRegistration,
    controller: UpdateController,
    deps: UpdateCheckDeps = {},
): void {
    const isVisible =
        deps.isVisible ?? (() => document.visibilityState === 'visible');
    const addVisibilityListener =
        deps.addVisibilityListener ??
        ((handler: () => void) =>
            document.addEventListener('visibilitychange', handler));

    // A failed update *check* self-heals on the next visibility change, but is
    // still labeled `pwa-update-check-failed` so the funnel is complete rather
    // than surfacing as a generic unhandled-error. Checks fire on every
    // visibility regain, so guard against flooding: report each distinct reason
    // at most once per session, and cap the number of distinct reasons.
    const reportedReasons = new Set<string>();
    function reportCheckFailure(err: unknown): void {
        const reason = sanitizeErrorReason(err);
        if (reportedReasons.has(reason)) return;
        if (reportedReasons.size >= MAX_CHECK_FAILURE_REASONS) return;
        reportedReasons.add(reason);
        diagnostics.warn('[pwa] registration.update() rejected', err);
        track('pwa-update-check-failed', { reason });
    }

    // update() returns `Promise<unknown> | void`; Promise.resolve makes the
    // void case a no-op rather than a throw.
    function checkForUpdate(): void {
        void Promise.resolve(registration.update()).catch(reportCheckFailure);
    }

    addVisibilityListener(() => {
        if (!isVisible()) return;
        checkForUpdate();
        controller.requestReloadIfPending();
    });
    checkForUpdate();
}

const MAX_CHECK_FAILURE_REASONS = 5;

export interface WatchedWorker {
    readonly state: string;
    addEventListener(type: 'statechange', handler: () => void): void;
}

export interface InstallWatchable {
    readonly active: unknown;
    readonly installing: WatchedWorker | null;
    addEventListener(type: 'updatefound', handler: () => void): void;
}

export interface InstallWatchDeps {
    onWaiting: () => void;
    /** Defaults to `navigator.onLine`. */
    isOnline?: () => boolean;
}

/**
 * Watches the registration itself rather than relying on workbox-window, which
 * stops listening for `updatefound` after the first "external" one (any after
 * the first, or later than 60 s after registration; `Workbox.js`
 * `_onUpdateFound`). Without `onWaiting`, an update that installs after a
 * failed one in the same session would never be offered.
 */
export function watchInstalls(
    registration: InstallWatchable,
    deps: InstallWatchDeps,
): void {
    const isOnline = deps.isOnline ?? (() => navigator.onLine);
    let reported = false;

    function watch(worker: WatchedWorker | null): void {
        if (!worker) return;
        let previous = worker.state;
        worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && registration.active !== null) {
                deps.onWaiting();
            }
            // A waiting worker replaced by a newer one goes redundant from
            // `installed`; that is not a failure.
            if (worker.state === 'redundant' && previous === 'installing' && !reported) {
                reported = true;
                track('pwa-update-install-failed', {
                    isUpdate: registration.active !== null,
                    online: isOnline(),
                });
            }
            previous = worker.state;
        });
    }

    registration.addEventListener('updatefound', () => watch(registration.installing));
    watch(registration.installing);
}

/**
 * Reloads the tapped page once the worker it applied has activated, instead of
 * waiting for vite-plugin-pwa's reload. That one only comes from workbox-window's
 * `controlling` event with `isUpdate`, which is fixed at registration as "a
 * worker controlled this page", and its listener is armed only by the library's
 * own delayed `waiting` event. So it never fires on a page no worker controlled
 * at load, nor for an update only `watchInstalls` saw.
 */
export function reloadOnceActivated(
    updateSW: (reloadPage?: boolean) => Promise<void>,
    waiting: () => Promise<WatchedWorker | null>,
    reload: () => void,
): (reloadPage?: boolean) => Promise<void> {
    return async (reloadPage) => {
        const worker = await waiting();
        await updateSW(reloadPage);
        if (worker && worker.state !== 'activated') {
            await new Promise<void>((resolve) => {
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'activated') resolve();
                });
            });
        }
        reload();
    };
}

export interface ControllerChangeSource {
    readonly controller: unknown;
    addEventListener(type: 'controllerchange', handler: () => void): void;
}

/**
 * Reloads other tabs when one applies an update. Only on a page a worker
 * controlled at startup, where a controller change always means a new worker
 * took over.
 */
export function reloadOnControllerChange(
    container: ControllerChangeSource,
    reload: () => void,
): void {
    if (container.controller) container.addEventListener('controllerchange', reload);
}
