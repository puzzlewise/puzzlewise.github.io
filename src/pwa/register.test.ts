/**
 * @vitest-environment jsdom
 *
 * The rescue-wiring tests drive `onRegisteredSW` with a truthy registration,
 * which runs the real `setupUpdateChecks` (`document`) and the update
 * controller's fallback path (`location`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';

// `register.ts` is otherwise untestable: it imports the build-time-only
// `virtual:pwa-register`.
const { registerSW, capturedOptions } = vi.hoisted(() => {
    const captured: { current: RegisterSWOptions | undefined } = {
        current: undefined,
    };
    const registerSWMock = vi.fn((options?: RegisterSWOptions) => {
        captured.current = options;
        return vi.fn();
    });
    return { registerSW: registerSWMock, capturedOptions: captured };
});
vi.mock('virtual:pwa-register', () => ({ registerSW }));

// Avoid pulling the DOM-dependent UI barrel in; the indicator is only built
// via `showIndicator`, which this test never triggers.
vi.mock('../ui/index.js', () => ({ createUpdateAvailableIndicator: vi.fn() }));

// A plain vi.spyOn won't catch `track` called through register.ts's own import
// binding under Vite, so mock the module and pass the rest through.
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics/index.js', async (importActual) => {
    const actual = await importActual<typeof import('../analytics/index.js')>();
    return { ...actual, track };
});

import { initPwaUpdates } from './register.js';

beforeEach(() => {
    track.mockClear();
    registerSW.mockClear();
    capturedOptions.current = undefined;
    // jsdom has no matchMedia; the pwa-register-failed payload reads it.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
    // Safety net: restores real timers even if the fake-timers test throws
    // before its own cleanup.
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('initPwaUpdates onRegisterError', () => {
    it('tracks pwa-register-failed with the described failure when registration fails', () => {
        initPwaUpdates(() => {});

        capturedOptions.current?.onRegisterError?.('Rejected');

        expect(track).toHaveBeenCalledWith('pwa-register-failed', expect.objectContaining({
            reason: 'Rejected',
            valueType: 'string',
        }));
        // onRegisterError fires at most once per load, so one failure = one event.
        expect(track).toHaveBeenCalledTimes(1);
    });

    it('sanitizes the rejection message before reporting it', () => {
        initPwaUpdates(() => {});

        capturedOptions.current?.onRegisterError?.(
            new Error('failed to fetch https://example.com/sw.js?v=abc123'),
        );

        expect(track).toHaveBeenCalledWith('pwa-register-failed', expect.objectContaining({
            reason: 'failed to fetch <url>',
        }));
    });

    it('does not report a registration failure when none occurs', () => {
        initPwaUpdates(() => {});

        expect(track).not.toHaveBeenCalledWith(
            'pwa-register-failed',
            expect.anything(),
        );
    });
});

describe('initPwaUpdates share-link rescue wiring', () => {
    it('resolves no-update when the registered SW checks clean', async () => {
        const pwa = initPwaUpdates(() => {});
        const registration = {
            update: vi.fn(() => Promise.resolve()),
            active: {},
            installing: null,
            waiting: null,
            addEventListener: vi.fn(),
        };
        capturedOptions.current?.onRegisteredSW?.(
            'sw.js',
            registration as unknown as ServiceWorkerRegistration,
        );

        await expect(pwa.attemptShareLinkRescue()).resolves.toBe('no-update');
        expect(registration.update).toHaveBeenCalled();
    });

    it('resolves unavailable when registration failed', async () => {
        const pwa = initPwaUpdates(() => {});
        capturedOptions.current?.onRegisterError?.(new Error('boom'));

        await expect(pwa.attemptShareLinkRescue()).resolves.toBe('unavailable');
    });

    it('applies and resolves updated when the check surfaces a waiting worker', async () => {
        // Applying the update schedules a 3s fallback reload on the real
        // setTimeout, which would hit jsdom's unimplemented location.reload as
        // an async uncaught error. Fake timers keep it pending but unfired; the
        // assertions depend only on the microtask onNeedRefresh resolution.
        vi.useFakeTimers();
        const updateSW = vi.fn(() => Promise.resolve());
        registerSW.mockImplementationOnce((options?: RegisterSWOptions) => {
            capturedOptions.current = options;
            return updateSW;
        });
        const flush = vi.fn();
        const pwa = initPwaUpdates(flush);
        const registration = {
            update: vi.fn(() => {
                // The real update() kicks off an install that ends in
                // onNeedRefresh; simulate that resolution order.
                queueMicrotask(() => capturedOptions.current?.onNeedRefresh?.());
                return Promise.resolve();
            }),
            active: {},
            installing: { state: 'installing', addEventListener: vi.fn() },
            waiting: { state: 'installed', addEventListener: vi.fn() },
            addEventListener: vi.fn(),
        };
        capturedOptions.current?.onRegisteredSW?.(
            'sw.js',
            registration as unknown as ServiceWorkerRegistration,
        );

        await expect(pwa.attemptShareLinkRescue()).resolves.toBe('updated');
        expect(flush).toHaveBeenCalled();
        expect(updateSW).toHaveBeenCalledWith(true);
        expect(track).toHaveBeenCalledWith('pwa-update-applied', {
            trigger: 'share-link-rescue',
        });
    });

    it('waits for activation when a rescue applies before onRegisteredSW, as Workbox orders it', async () => {
        vi.useFakeTimers();
        const updateSW = vi.fn(() => Promise.resolve());
        registerSW.mockImplementationOnce((options?: RegisterSWOptions) => {
            capturedOptions.current = options;
            return updateSW;
        });
        const reload = vi.fn();
        const pwa = initPwaUpdates(() => {}, reload);
        const workerHandlers: Array<() => void> = [];
        const worker = {
            state: 'installed',
            addEventListener: (_type: string, handler: () => void) => {
                workerHandlers.push(handler);
            },
        };
        const registration = {
            update: vi.fn(() => Promise.resolve()),
            active: {},
            installing: null,
            waiting: worker,
            addEventListener: vi.fn(),
        };
        const rescue = pwa.attemptShareLinkRescue();

        capturedOptions.current?.onNeedRefresh?.();
        capturedOptions.current?.onRegisteredSW?.(
            'sw.js',
            registration as unknown as ServiceWorkerRegistration,
        );
        await expect(rescue).resolves.toBe('updated');
        for (let n = 0; n < 10; n++) await Promise.resolve();
        expect(updateSW).toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();

        worker.state = 'activated';
        for (const handler of workerHandlers) handler();
        for (let n = 0; n < 10; n++) await Promise.resolve();
        expect(reload).toHaveBeenCalledOnce();
    });

    it('applies an update that only the install watcher saw', async () => {
        vi.useFakeTimers();
        const workerHandlers: Array<() => void> = [];
        const worker = {
            state: 'installing',
            addEventListener: (_type: string, handler: () => void) => {
                workerHandlers.push(handler);
            },
        };
        const updateFoundHandlers: Array<() => void> = [];
        const registration = {
            active: {},
            installing: null as unknown,
            waiting: null as unknown,
            addEventListener: (_type: string, handler: () => void) => {
                updateFoundHandlers.push(handler);
            },
            update: vi.fn(() => {
                if (!registration.installing && !registration.waiting) {
                    registration.installing = worker;
                    for (const handler of updateFoundHandlers) handler();
                }
                return Promise.resolve();
            }),
        };
        const pwa = initPwaUpdates(() => {});
        capturedOptions.current?.onRegisteredSW?.(
            'sw.js',
            registration as unknown as ServiceWorkerRegistration,
        );
        let outcome: string | undefined;
        void pwa.attemptShareLinkRescue().then((o) => {
            outcome = o;
        });
        for (let n = 0; n < 10; n++) await Promise.resolve();

        registration.installing = null;
        registration.waiting = worker;
        worker.state = 'installed';
        for (const handler of workerHandlers) handler();
        for (let n = 0; n < 10; n++) await Promise.resolve();

        expect(outcome).toBe('updated');
        expect(track).toHaveBeenCalledWith('pwa-update-applied', {
            trigger: 'share-link-rescue',
        });
    });
});

describe('initPwaUpdates controller change', () => {
    let controllerChangeHandlers: Array<() => void> = [];

    beforeEach(() => {
        controllerChangeHandlers = [];
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {
                controller: {},
                addEventListener: (_type: string, handler: () => void) => {
                    controllerChangeHandlers.push(handler);
                },
            },
        });
    });

    afterEach(() => {
        Reflect.deleteProperty(navigator, 'serviceWorker');
    });

    function register(flush: () => void, reload: () => void) {
        const pwa = initPwaUpdates(flush, reload);
        const registration = {
            update: vi.fn(() => Promise.resolve()),
            active: {},
            installing: null,
            waiting: null,
            addEventListener: vi.fn(),
        };
        capturedOptions.current?.onRegisteredSW?.(
            'sw.js',
            registration as unknown as ServiceWorkerRegistration,
        );
        return pwa;
    }

    it('reports and reloads when another tab applied the update, even before registration', async () => {
        vi.useFakeTimers();
        const flush = vi.fn();
        const reload = vi.fn();
        initPwaUpdates(flush, reload);

        for (const handler of controllerChangeHandlers) handler();
        for (let n = 0; n < 10; n++) await Promise.resolve();

        expect(track).toHaveBeenCalledWith('pwa-update-applied', { trigger: 'other-tab' });
        expect(flush).toHaveBeenCalled();
        expect(reload).toHaveBeenCalled();
        expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
            reload.mock.invocationCallOrder[0],
        );
    });

    it('reports only the tap on the tab that applied the update', async () => {
        vi.useFakeTimers();
        register(vi.fn(), vi.fn());
        capturedOptions.current?.onNeedRefresh?.();
        const { createUpdateAvailableIndicator } = await import('../ui/index.js');
        const { onRefresh } = vi.mocked(createUpdateAvailableIndicator).mock.calls.at(-1)![0];
        onRefresh();

        for (const handler of controllerChangeHandlers) handler();
        for (let n = 0; n < 10; n++) await Promise.resolve();

        const applied = track.mock.calls.filter(([name]) => name === 'pwa-update-applied');
        expect(applied).toEqual([['pwa-update-applied', { trigger: 'manual' }]]);
    });
});
