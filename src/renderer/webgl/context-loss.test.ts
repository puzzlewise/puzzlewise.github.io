import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CONTEXT_RESTORE_TIMEOUT_MS, ContextLossMonitor } from './context-loss.js';
import type { ContextEventPhase } from './context-loss.js';

function setup() {
    const report = vi.fn<(phase: ContextEventPhase) => void>();
    return { report, monitor: new ContextLossMonitor(report) };
}

describe('ContextLossMonitor', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test("reports 'lost' at once, and only once per loss", () => {
        const { report, monitor } = setup();
        monitor.lost();
        monitor.lost();

        expect(report.mock.calls).toEqual([['lost']]);
        expect(monitor.isLost).toBe(true);
    });

    test("a restore within the timeout redraws, then reports 'restored'", () => {
        const { report, monitor } = setup();
        monitor.lost();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS - 1);
        const redraw = vi.fn(() => {
            expect(monitor.isLost).toBe(false);
            expect(report).not.toHaveBeenCalledWith('restored');
        });

        expect(monitor.canRestore).toBe(true);
        monitor.restored(redraw);

        expect(redraw).toHaveBeenCalledTimes(1);
        expect(report.mock.calls).toEqual([['lost'], ['restored']]);
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
        expect(report.mock.calls).toEqual([['lost'], ['restored']]);
    });

    test("without a restore it reports 'gave-up', and a late restore is ignored", () => {
        const { report, monitor } = setup();
        monitor.lost();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);

        expect(report.mock.calls).toEqual([['lost'], ['gave-up']]);
        expect(monitor.canRestore).toBe(false);
        const redraw = vi.fn();
        monitor.restored(redraw);
        monitor.lost();

        expect(redraw).not.toHaveBeenCalled();
        expect(monitor.isLost).toBe(true);
        expect(report.mock.calls).toEqual([['lost'], ['gave-up']]);
    });

    test("stop ends a loss without 'gave-up', and a late restore is ignored", () => {
        const { report, monitor } = setup();
        monitor.lost();

        monitor.stop();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
        const redraw = vi.fn();
        monitor.restored(redraw);

        expect(report.mock.calls).toEqual([['lost']]);
        expect(redraw).not.toHaveBeenCalled();
        expect(monitor.isLost).toBe(true);
        expect(monitor.canRestore).toBe(false);
    });

    test('dispose cancels the timeout and resets the state', () => {
        const { report, monitor } = setup();
        monitor.lost();

        monitor.dispose();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);

        expect(report.mock.calls).toEqual([['lost']]);
        expect(monitor.isLost).toBe(false);
        expect(monitor.canRestore).toBe(false);
    });
});
