/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../analytics/index.js', () => ({
    initAnalytics: vi.fn(),
    initErrorTracking: vi.fn(),
    installFirstInteractionTracking: vi.fn(),
    track: vi.fn(),
}));
vi.mock('../pwa/sw-error-bridge.js', () => ({ initSwErrorReporting: vi.fn() }));

import { initAnalytics, initErrorTracking, installFirstInteractionTracking } from '../analytics/index.js';
import { initSwErrorReporting } from '../pwa/sw-error-bridge.js';
import { installGlobalHandlers } from './global-handlers.js';
import { markPuzzleTable } from '../renderer/puzzle-table.js';

describe('installGlobalHandlers', () => {
    let container: HTMLElement;
    /** jsdom doesn't implement this method, so the "original" is `undefined`. */
    let originalSetResourceTimingBufferSize: Performance['setResourceTimingBufferSize'] | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        container = document.createElement('div');
        document.body.replaceChildren(container);
        originalSetResourceTimingBufferSize = performance.setResourceTimingBufferSize;
    });

    afterEach(() => {
        // Tests below overwrite/delete this on the shared `performance`
        // global; restore it so later tests (any shuffle order) don't inherit
        // a leftover spy or deleted method.
        if (originalSetResourceTimingBufferSize === undefined) {
            delete (performance as unknown as { setResourceTimingBufferSize?: unknown })
                .setResourceTimingBufferSize;
        } else {
            performance.setResourceTimingBufferSize = originalSetResourceTimingBufferSize;
        }
        vi.unstubAllEnvs();
    });

    it('initializes analytics before error tracking and the worker bridge', () => {
        // Error reporting must not run before the tracker it reports through.
        installGlobalHandlers(container);
        const order = [
            vi.mocked(initAnalytics).mock.invocationCallOrder[0],
            vi.mocked(initErrorTracking).mock.invocationCallOrder[0],
            vi.mocked(initSwErrorReporting).mock.invocationCallOrder[0],
        ];
        expect(order).toEqual([...order].sort((a, b) => a - b));
        // `sort` parks `undefined` last, so a dropped call wouldn't perturb
        // the order assertion — pin that all three actually ran.
        expect(initAnalytics).toHaveBeenCalledTimes(1);
        expect(initErrorTracking).toHaveBeenCalledTimes(1);
        expect(initSwErrorReporting).toHaveBeenCalledTimes(1);
    });

    it('installs first-interaction tracking', () => {
        installGlobalHandlers(container);
        expect(installFirstInteractionTracking).toHaveBeenCalledTimes(1);
    });

    it('enlarges the resource-timing buffer', () => {
        // Backs the traced-chunk cacheState dimension on long PWA sessions.
        const spy = vi.fn();
        performance.setResourceTimingBufferSize = spy;
        installGlobalHandlers(container);
        expect(spy).toHaveBeenCalledWith(500);
    });

    it('does not throw when setResourceTimingBufferSize is unavailable', () => {
        // Defensive against environments without the Resource Timing Level 2
        // API (the DOM types claim it's always present) — pins the `?.` in
        // global-handlers.ts.
        delete (performance as unknown as { setResourceTimingBufferSize?: unknown })
            .setResourceTimingBufferSize;
        expect(() => installGlobalHandlers(container)).not.toThrow();
    });

    it('suppresses the context menu on the puzzle table', () => {
        installGlobalHandlers(container);
        const table = document.createElement('div');
        markPuzzleTable(table);
        container.appendChild(table);

        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        table.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('leaves the context menu alone outside the table', () => {
        // Long-press copy of share links and repro params inside the info
        // modal has to keep working.
        installGlobalHandlers(container);
        const modal = document.createElement('div');
        container.appendChild(modal);

        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        modal.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });

    it('cancels touchstart inside the puzzle table', () => {
        installGlobalHandlers(container);
        const table = document.createElement('div');
        markPuzzleTable(table);
        const inner = document.createElement('span');
        table.appendChild(inner);
        container.appendChild(table);

        const event = new Event('touchstart', { bubbles: true, cancelable: true });
        inner.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('leaves touchstart alone outside the puzzle table', () => {
        installGlobalHandlers(container);
        const button = document.createElement('button');
        container.appendChild(button);

        const event = new Event('touchstart', { bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });

    it('shows the version badge when VITE_APP_VERSION is set', () => {
        vi.stubEnv('VITE_APP_VERSION', '1.2.3');
        installGlobalHandlers(container);
        expect(container.querySelector('.app-version')?.textContent).toBe('1.2.3');
    });

    it('omits the version badge when VITE_APP_VERSION is unset', () => {
        // Unset under Vitest by default; if the `if (appVersion)` guard were
        // dropped, an empty badge div would be appended instead of nothing.
        installGlobalHandlers(container);
        expect(container.querySelector('.app-version')).toBeNull();
    });
});
