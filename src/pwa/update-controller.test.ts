import { describe, it, expect, vi, beforeEach } from 'vitest';

// A plain vi.spyOn won't catch `track` called through update-controller's own
// import binding under Vite, so mock the module and keep the rest real.
// `vi.hoisted` because the `vi.mock` factory is hoisted above top-level code.
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics/index.js', async (importActual) => {
    const actual = await importActual<typeof import('../analytics/index.js')>();
    return { ...actual, track };
});

import {
    createUpdateController,
    reloadOnceActivated,
    reloadOnControllerChange,
    setupUpdateChecks,
    watchInstalls,
    type UpdateController,
} from './update-controller.js';

beforeEach(() => {
    track.mockClear();
});

describe('createUpdateController', () => {
    it('is not pending before any refresh is needed', () => {
        const controller = createUpdateController({
            flush: vi.fn(),
            showIndicator: vi.fn(),
        });
        expect(controller.pending).toBe(false);
    });

    it('marks pending and shows the indicator on onNeedRefresh', () => {
        const showIndicator = vi.fn();
        const controller = createUpdateController({ flush: vi.fn(), showIndicator });
        controller.onNeedRefresh();
        expect(controller.pending).toBe(true);
        expect(showIndicator).toHaveBeenCalledOnce();
    });

    it('ignores a repeat onNeedRefresh within the same page load', () => {
        const showIndicator = vi.fn();
        const controller = createUpdateController({ flush: vi.fn(), showIndicator });
        controller.onNeedRefresh();
        controller.onNeedRefresh();
        expect(showIndicator).toHaveBeenCalledOnce();
    });

    it('reloadNow flushes before calling updateSW(true)', () => {
        const flush = vi.fn();
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const controller = createUpdateController({ flush, showIndicator: vi.fn() });
        controller.setUpdateSW(updateSW);
        controller.reloadNow();
        expect(flush).toHaveBeenCalledOnce();
        expect(updateSW).toHaveBeenCalledWith(true);
        expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
            updateSW.mock.invocationCallOrder[0],
        );
    });

    it('reloadNow is a no-op when updateSW is not set yet', () => {
        const flush = vi.fn();
        const controller = createUpdateController({ flush, showIndicator: vi.fn() });
        controller.reloadNow();
        expect(flush).not.toHaveBeenCalled();
    });

    it('applies a reload requested before updateSW is set, once it is set', () => {
        const flush = vi.fn();
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const controller = createUpdateController({ flush, showIndicator: vi.fn() });
        controller.reloadNow();
        expect(flush).not.toHaveBeenCalled();
        controller.setUpdateSW(updateSW);
        expect(flush).toHaveBeenCalledOnce();
        expect(updateSW).toHaveBeenCalledWith(true);
    });

    it('does not re-fire a buffered reload on a later setUpdateSW call', () => {
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const controller = createUpdateController({ flush: vi.fn(), showIndicator: vi.fn() });
        controller.reloadNow();
        controller.setUpdateSW(updateSW);
        controller.setUpdateSW(updateSW);
        expect(updateSW).toHaveBeenCalledOnce();
    });

    it('setUpdateSW does not reload when no reload was requested', () => {
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const controller = createUpdateController({ flush: vi.fn(), showIndicator: vi.fn() });
        controller.setUpdateSW(updateSW);
        expect(updateSW).not.toHaveBeenCalled();
    });

    it('requestReloadIfPending reloads only when pending', () => {
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const controller = createUpdateController({ flush: vi.fn(), showIndicator: vi.fn() });
        controller.setUpdateSW(updateSW);

        controller.requestReloadIfPending();
        expect(updateSW).not.toHaveBeenCalled();

        controller.onNeedRefresh();
        controller.requestReloadIfPending();
        expect(updateSW).toHaveBeenCalledWith(true);
    });

    it('the indicator callback applies the update', () => {
        const updateSW = vi.fn().mockResolvedValue(undefined);
        let captured: (() => void) | null = null;
        const controller = createUpdateController({
            flush: vi.fn(),
            showIndicator: (onRefresh) => {
                captured = onRefresh;
            },
        });
        controller.setUpdateSW(updateSW);
        controller.onNeedRefresh();
        captured!();
        expect(updateSW).toHaveBeenCalledWith(true);
    });

    it('reloadNow schedules a fallback reload via the injected scheduler', () => {
        const flush = vi.fn();
        const reload = vi.fn();
        const scheduleFallback = vi.fn();
        const controller = createUpdateController({
            flush,
            showIndicator: vi.fn(),
            reload,
            scheduleFallback,
        });
        controller.setUpdateSW(vi.fn().mockResolvedValue(undefined));
        controller.reloadNow();
        expect(scheduleFallback).toHaveBeenCalledOnce();
        expect(scheduleFallback).toHaveBeenCalledWith(expect.any(Function), 3000);
        const handler = scheduleFallback.mock.calls[0][0] as () => void;
        handler();
        expect(reload).toHaveBeenCalledOnce();
    });

    it('reloadNow is idempotent (second call is a no-op)', () => {
        const flush = vi.fn();
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const reload = vi.fn();
        const scheduleFallback = vi.fn();
        const controller = createUpdateController({
            flush,
            showIndicator: vi.fn(),
            reload,
            scheduleFallback,
        });
        controller.setUpdateSW(updateSW);
        controller.reloadNow();
        controller.reloadNow();
        expect(flush).toHaveBeenCalledOnce();
        expect(updateSW).toHaveBeenCalledOnce();
        expect(scheduleFallback).toHaveBeenCalledOnce();
    });

    it('requestReloadIfPending after a reload has started does nothing more', () => {
        const flush = vi.fn();
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const reload = vi.fn();
        const scheduleFallback = vi.fn();
        const controller = createUpdateController({
            flush,
            showIndicator: vi.fn(),
            reload,
            scheduleFallback,
        });
        controller.setUpdateSW(updateSW);
        controller.onNeedRefresh();
        controller.reloadNow();
        controller.requestReloadIfPending();
        expect(updateSW).toHaveBeenCalledOnce();
    });
});

describe('createUpdateController analytics', () => {
    it('tracks pwa-update-detected when a refresh is needed', () => {
        const controller = createUpdateController({ flush: vi.fn(), showIndicator: vi.fn() });
        controller.onNeedRefresh();
        expect(track).toHaveBeenCalledWith('pwa-update-detected', {});
    });

    it('tracks pwa-update-detected once per page load when onNeedRefresh repeats', () => {
        const controller = createUpdateController({ flush: vi.fn(), showIndicator: vi.fn() });
        controller.onNeedRefresh();
        controller.onNeedRefresh();
        const detected = track.mock.calls.filter(
            ([name]) => name === 'pwa-update-detected',
        );
        expect(detected).toHaveLength(1);
    });

    it('tracks pwa-update-applied with the manual trigger on a tap', () => {
        const controller = createUpdateController({ flush: vi.fn(), showIndicator: vi.fn() });
        controller.setUpdateSW(vi.fn().mockResolvedValue(undefined));
        controller.reloadNow();
        expect(track).toHaveBeenCalledWith('pwa-update-applied', { trigger: 'manual' });
    });

    it('tracks pwa-update-applied with the focus-regain trigger', () => {
        const controller = createUpdateController({ flush: vi.fn(), showIndicator: vi.fn() });
        controller.setUpdateSW(vi.fn().mockResolvedValue(undefined));
        controller.onNeedRefresh();
        controller.requestReloadIfPending();
        expect(track).toHaveBeenCalledWith('pwa-update-applied', { trigger: 'focus-regain' });
    });

    it('tracks pwa-update-fallback-reload when the fallback timer fires', () => {
        const reload = vi.fn();
        const scheduleFallback = vi.fn();
        const controller = createUpdateController({
            flush: vi.fn(),
            showIndicator: vi.fn(),
            reload,
            scheduleFallback,
        });
        controller.setUpdateSW(vi.fn().mockResolvedValue(undefined));
        controller.reloadNow();
        expect(track).not.toHaveBeenCalledWith('pwa-update-fallback-reload', {});
        (scheduleFallback.mock.calls[0][0] as () => void)();
        expect(track).toHaveBeenCalledWith('pwa-update-fallback-reload', {});
        expect(reload).toHaveBeenCalledOnce();
    });

    it('tracks pwa-update-apply-failed when updateSW(true) rejects', async () => {
        const controller = createUpdateController({
            flush: vi.fn(),
            showIndicator: vi.fn(),
            scheduleFallback: vi.fn(),
        });
        controller.setUpdateSW(vi.fn().mockRejectedValue(new Error('boom')));
        controller.reloadNow();
        // Let the rejection microtask settle.
        await Promise.resolve();
        await Promise.resolve();
        expect(track).toHaveBeenCalledWith('pwa-update-apply-failed', { reason: 'boom' });
    });

    it('onControllerChange reports other-tab, flushes and reloads without activating or a fallback', () => {
        const flush = vi.fn();
        const reload = vi.fn();
        const scheduleFallback = vi.fn();
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const controller = createUpdateController({
            flush,
            showIndicator: vi.fn(),
            reload,
            scheduleFallback,
        });
        controller.setUpdateSW(updateSW);

        controller.onControllerChange();

        expect(track).toHaveBeenCalledWith('pwa-update-applied', { trigger: 'other-tab' });
        expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
            reload.mock.invocationCallOrder[0],
        );
        expect(updateSW).not.toHaveBeenCalled();
        expect(scheduleFallback).not.toHaveBeenCalled();
    });

    it('onControllerChange does nothing on the page that is applying the update', () => {
        const reload = vi.fn();
        const controller = createUpdateController({
            flush: vi.fn(),
            showIndicator: vi.fn(),
            reload,
            scheduleFallback: vi.fn(),
        });
        controller.setUpdateSW(vi.fn().mockResolvedValue(undefined));
        controller.reloadNow();

        controller.onControllerChange();

        expect(reload).not.toHaveBeenCalled();
        const applied = track.mock.calls.filter(([name]) => name === 'pwa-update-applied');
        expect(applied).toEqual([['pwa-update-applied', { trigger: 'manual' }]]);
    });

    it('reloadNow reports a supplied trigger on the applied event', () => {
        const controller = createUpdateController({
            flush: vi.fn(),
            showIndicator: vi.fn(),
            scheduleFallback: vi.fn(),
        });
        controller.setUpdateSW(vi.fn(() => Promise.resolve()));

        controller.reloadNow('share-link-rescue');

        expect(track).toHaveBeenCalledWith('pwa-update-applied', {
            trigger: 'share-link-rescue',
        });
    });
});

function fakeController(): UpdateController {
    return {
        onNeedRefresh: vi.fn(),
        setUpdateSW: vi.fn(),
        requestReloadIfPending: vi.fn(),
        reloadNow: vi.fn(),
        pending: false,
    } as unknown as UpdateController;
}

describe('setupUpdateChecks', () => {
    it('checks for an update once at setup', () => {
        const registration = { update: vi.fn() };
        setupUpdateChecks(registration, fakeController(), {
            addVisibilityListener: () => {},
            isVisible: () => true,
        });
        expect(registration.update).toHaveBeenCalledOnce();
    });

    it('on visible: checks for an update and requests reload-if-pending', () => {
        const registration = { update: vi.fn() };
        const controller = fakeController();
        let visHandler: (() => void) | null = null;
        setupUpdateChecks(registration, controller, {
            addVisibilityListener: (fn) => {
                visHandler = fn;
            },
            isVisible: () => true,
        });
        registration.update.mockClear();
        visHandler!();
        expect(registration.update).toHaveBeenCalledOnce();
        expect(controller.requestReloadIfPending).toHaveBeenCalledOnce();
    });

    it('ignores visibility changes when not visible', () => {
        const registration = { update: vi.fn() };
        const controller = fakeController();
        let visHandler: (() => void) | null = null;
        setupUpdateChecks(registration, controller, {
            addVisibilityListener: (fn) => {
                visHandler = fn;
            },
            isVisible: () => false,
        });
        registration.update.mockClear();
        visHandler!();
        expect(registration.update).not.toHaveBeenCalled();
        expect(controller.requestReloadIfPending).not.toHaveBeenCalled();
    });

    it('does not track a check failure when the check resolves', async () => {
        const registration = { update: vi.fn().mockResolvedValue(undefined) };
        let visHandler: (() => void) | null = null;
        setupUpdateChecks(registration, fakeController(), {
            addVisibilityListener: (fn) => {
                visHandler = fn;
            },
            isVisible: () => true,
        });
        visHandler!();
        await Promise.resolve();
        await Promise.resolve();
        expect(track).not.toHaveBeenCalledWith(
            'pwa-update-check-failed',
            expect.anything(),
        );
    });

    it('tracks pwa-update-check-failed when the setup check rejects', async () => {
        const registration = {
            update: vi.fn().mockRejectedValue(new Error('offline')),
        };
        setupUpdateChecks(registration, fakeController(), {
            addVisibilityListener: () => {},
            isVisible: () => true,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(track).toHaveBeenCalledWith('pwa-update-check-failed', {
            reason: 'offline',
        });
    });

    it('tracks pwa-update-check-failed when the visibility-path check rejects', async () => {
        const registration = {
            update: vi
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValue(new Error('offline')),
        };
        let visHandler: (() => void) | null = null;
        setupUpdateChecks(registration, fakeController(), {
            addVisibilityListener: (fn) => {
                visHandler = fn;
            },
            isVisible: () => true,
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(track).not.toHaveBeenCalled();
        visHandler!();
        await Promise.resolve();
        await Promise.resolve();
        expect(track).toHaveBeenCalledWith('pwa-update-check-failed', {
            reason: 'offline',
        });
    });

    it('reports each distinct reason only once across repeated rejecting checks', async () => {
        const registration = {
            update: vi.fn().mockRejectedValue(new Error('offline')),
        };
        let visHandler: (() => void) | null = null;
        setupUpdateChecks(registration, fakeController(), {
            addVisibilityListener: (fn) => {
                visHandler = fn;
            },
            isVisible: () => true,
        });
        for (let i = 0; i < 4; i++) {
            visHandler!();
            await Promise.resolve();
            await Promise.resolve();
        }
        const checkFailures = track.mock.calls.filter(
            ([name]) => name === 'pwa-update-check-failed',
        );
        expect(checkFailures).toHaveLength(1);
    });

    it('caps the number of distinct reasons reported per session', async () => {
        const errors = [
            'reason-a',
            'reason-b',
            'reason-c',
            'reason-d',
            'reason-e',
            'reason-f',
        ];
        let i = 0;
        const registration = {
            update: vi.fn(() => Promise.reject(new Error(errors[i++]))),
        };
        let visHandler: (() => void) | null = null;
        setupUpdateChecks(registration, fakeController(), {
            addVisibilityListener: (fn) => {
                visHandler = fn;
            },
            isVisible: () => true,
        });
        for (let n = 1; n < errors.length; n++) {
            visHandler!();
            await Promise.resolve();
            await Promise.resolve();
        }
        const checkFailures = track.mock.calls.filter(
            ([name]) => name === 'pwa-update-check-failed',
        );
        // Five distinct reasons get through; the sixth is dropped as a
        // cardinality guard.
        expect(checkFailures).toHaveLength(5);
        expect(checkFailures.map(([, data]) => data.reason)).not.toContain(
            'reason-f',
        );
    });
});

interface FakeWorker {
    state: string;
    addEventListener(type: 'statechange', handler: () => void): void;
    moveTo(state: string): void;
}

function fakeWorker(state: string): FakeWorker {
    const handlers: Array<() => void> = [];
    return {
        state,
        addEventListener: (_type, handler) => {
            handlers.push(handler);
        },
        moveTo(next) {
            this.state = next;
            for (const handler of handlers) handler();
        },
    };
}

function fakeInstallRegistration(active: unknown) {
    const handlers: Array<() => void> = [];
    return {
        active,
        installing: null as FakeWorker | null,
        addEventListener: (_type: 'updatefound', handler: () => void) => {
            handlers.push(handler);
        },
        findUpdate(worker: FakeWorker) {
            this.installing = worker;
            for (const handler of handlers) handler();
        },
    };
}

function installFailures() {
    return track.mock.calls.filter(([name]) => name === 'pwa-update-install-failed');
}

describe('watchInstalls', () => {
    it('reports a new worker that goes redundant while installing', () => {
        const registration = fakeInstallRegistration({});
        watchInstalls(registration, { onWaiting: vi.fn(), isOnline: () => true });
        const worker = fakeWorker('installing');
        registration.findUpdate(worker);

        worker.moveTo('redundant');

        expect(track).toHaveBeenCalledWith('pwa-update-install-failed', {
            isUpdate: true,
            online: true,
        });
    });

    it('tells a first install and an offline player apart', () => {
        const registration = fakeInstallRegistration(null);
        watchInstalls(registration, { onWaiting: vi.fn(), isOnline: () => false });
        const worker = fakeWorker('installing');
        registration.findUpdate(worker);

        worker.moveTo('redundant');

        expect(track).toHaveBeenCalledWith('pwa-update-install-failed', {
            isUpdate: false,
            online: false,
        });
    });

    it('does not report a waiting worker that a newer one replaced', () => {
        const registration = fakeInstallRegistration({});
        watchInstalls(registration, { onWaiting: vi.fn(), isOnline: () => true });
        const worker = fakeWorker('installing');
        registration.findUpdate(worker);

        worker.moveTo('installed');
        worker.moveTo('redundant');

        expect(installFailures()).toHaveLength(0);
    });

    it('reports at most one failed install per session', () => {
        const registration = fakeInstallRegistration({});
        watchInstalls(registration, { onWaiting: vi.fn(), isOnline: () => true });
        for (let n = 0; n < 2; n++) {
            const worker = fakeWorker('installing');
            registration.findUpdate(worker);
            worker.moveTo('redundant');
        }

        expect(installFailures()).toHaveLength(1);
    });

    it('follows a worker that was already installing at setup', () => {
        const registration = fakeInstallRegistration({});
        const worker = fakeWorker('installing');
        registration.installing = worker;
        watchInstalls(registration, { onWaiting: vi.fn(), isOnline: () => true });

        worker.moveTo('redundant');

        expect(installFailures()).toHaveLength(1);
    });

    it('offers a worker that installs while another is active', () => {
        const registration = fakeInstallRegistration({});
        const onWaiting = vi.fn();
        watchInstalls(registration, { onWaiting, isOnline: () => true });
        const worker = fakeWorker('installing');
        registration.findUpdate(worker);

        worker.moveTo('installed');

        expect(onWaiting).toHaveBeenCalledOnce();
    });

    it('does not offer the first worker of a first visit', () => {
        const registration = fakeInstallRegistration(null);
        const onWaiting = vi.fn();
        watchInstalls(registration, { onWaiting, isOnline: () => true });
        const worker = fakeWorker('installing');
        registration.findUpdate(worker);

        worker.moveTo('installed');

        expect(onWaiting).not.toHaveBeenCalled();
    });

    it('offers a later update after a failed install', () => {
        const registration = fakeInstallRegistration({});
        const onWaiting = vi.fn();
        watchInstalls(registration, { onWaiting, isOnline: () => true });
        const failed = fakeWorker('installing');
        registration.findUpdate(failed);
        failed.moveTo('redundant');
        const retried = fakeWorker('installing');
        registration.findUpdate(retried);

        retried.moveTo('installed');

        expect(onWaiting).toHaveBeenCalledOnce();
    });
});

describe('reloadOnceActivated', () => {
    it('reloads once the applied worker has activated', async () => {
        const worker = fakeWorker('installed');
        const reload = vi.fn();
        const apply = reloadOnceActivated(
            vi.fn().mockResolvedValue(undefined),
            async () => worker,
            reload,
        );

        const applied = apply(true);
        for (let n = 0; n < 5; n++) await Promise.resolve();
        worker.moveTo('activating');
        for (let n = 0; n < 5; n++) await Promise.resolve();
        expect(reload).not.toHaveBeenCalled();
        worker.moveTo('activated');
        await applied;

        expect(reload).toHaveBeenCalledOnce();
    });

    it('reloads when the worker activated before updateSW resolved', async () => {
        const worker = fakeWorker('installed');
        const reload = vi.fn();
        const apply = reloadOnceActivated(
            vi.fn(() => {
                worker.state = 'activated';
                return Promise.resolve();
            }),
            async () => worker,
            reload,
        );

        await apply(true);

        expect(reload).toHaveBeenCalledOnce();
    });

    it('reads the waiting worker before applying it', async () => {
        const worker = fakeWorker('installed');
        let waiting: FakeWorker | null = worker;
        const reload = vi.fn();
        const apply = reloadOnceActivated(
            vi.fn(() => {
                waiting = null;
                worker.moveTo('activating');
                return Promise.resolve();
            }),
            async () => waiting,
            reload,
        );

        const applied = apply(true);
        for (let n = 0; n < 5; n++) await Promise.resolve();
        expect(reload).not.toHaveBeenCalled();
        worker.moveTo('activated');
        await applied;

        expect(reload).toHaveBeenCalledOnce();
    });

    it('reloads at once when no worker is waiting any more', async () => {
        const reload = vi.fn();
        const apply = reloadOnceActivated(
            vi.fn().mockResolvedValue(undefined),
            async () => null,
            reload,
        );

        await apply(true);

        expect(reload).toHaveBeenCalledOnce();
    });

    it('leaves a worker that never activates to the fallback', async () => {
        const worker = fakeWorker('installed');
        const reload = vi.fn();
        const apply = reloadOnceActivated(
            vi.fn().mockResolvedValue(undefined),
            async () => worker,
            reload,
        );

        void apply(true);
        for (let n = 0; n < 5; n++) await Promise.resolve();
        worker.moveTo('redundant');
        for (let n = 0; n < 5; n++) await Promise.resolve();

        expect(reload).not.toHaveBeenCalled();
    });

    it('rejects without reloading when updateSW rejects', async () => {
        const reload = vi.fn();
        const apply = reloadOnceActivated(
            vi.fn().mockRejectedValue(new Error('boom')),
            async () => fakeWorker('installed'),
            reload,
        );

        await expect(apply(true)).rejects.toThrow('boom');

        expect(reload).not.toHaveBeenCalled();
    });

    it('passes the reload flag through to updateSW', async () => {
        const updateSW = vi.fn().mockResolvedValue(undefined);
        const apply = reloadOnceActivated(updateSW, async () => null, vi.fn());

        await apply(true);

        expect(updateSW).toHaveBeenCalledWith(true);
    });
});

function fakeContainer(controller: unknown) {
    const handlers: Array<() => void> = [];
    return {
        controller,
        addEventListener: (_type: 'controllerchange', handler: () => void) => {
            handlers.push(handler);
        },
        changeController() {
            for (const handler of handlers) handler();
        },
    };
}

describe('reloadOnControllerChange', () => {
    it('reloads a page that was controlled at startup when a new worker takes over', () => {
        const container = fakeContainer({});
        const reload = vi.fn();
        reloadOnControllerChange(container, reload);

        container.changeController();

        expect(reload).toHaveBeenCalledOnce();
    });

    it('does not reload a page no worker controlled at startup', () => {
        const container = fakeContainer(null);
        const reload = vi.fn();
        reloadOnControllerChange(container, reload);

        container.changeController();

        expect(reload).not.toHaveBeenCalled();
    });
});
