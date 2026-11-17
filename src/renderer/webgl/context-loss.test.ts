import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CONTEXT_RESTORE_TIMEOUT_MS, ContextLossMonitor } from './context-loss.js';
import type { ContextEvent } from './context-loss.js';

function setup() {
    const report = vi.fn<(event: ContextEvent) => void>();
    return { report, monitor: new ContextLossMonitor(report, () => Date.now()) };
}

const LOST = { phase: 'lost' };
const GAVE_UP = { phase: 'gave-up' };

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

        expect(report.mock.calls).toEqual([[LOST]]);
        expect(monitor.isLost).toBe(true);
    });

    test("a restore within the timeout redraws, then reports 'restored'", () => {
        const { report, monitor } = setup();
        monitor.lost();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS - 1);
        const redraw = vi.fn(() => {
            expect(monitor.isLost).toBe(false);
            expect(report).toHaveBeenCalledTimes(1);
        });

        expect(monitor.canRestore).toBe(true);
        monitor.restored(redraw, Date.now());

        expect(redraw).toHaveBeenCalledTimes(1);
        const restored = { phase: 'restored', latencyMs: CONTEXT_RESTORE_TIMEOUT_MS - 1 };
        expect(report.mock.calls).toEqual([[LOST], [restored]]);
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
        expect(report.mock.calls).toEqual([[LOST], [restored]]);
    });

    test("without a restore it reports 'gave-up', and a late restore draws nothing", () => {
        const { report, monitor } = setup();
        monitor.lost();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);

        expect(report.mock.calls).toEqual([[LOST], [GAVE_UP]]);
        expect(monitor.canRestore).toBe(false);
        const redraw = vi.fn();
        monitor.restored(redraw, Date.now());
        monitor.lost();

        expect(redraw).not.toHaveBeenCalled();
        expect(monitor.isLost).toBe(true);
        expect(report.mock.calls).toEqual([[LOST], [GAVE_UP]]);
    });

    test("a restore after the give-up is reported once as 'restored-late', with its latency", () => {
        const { report, monitor } = setup();
        monitor.lost();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS + 2500);

        monitor.restoredLate();
        vi.advanceTimersByTime(1000);
        monitor.restoredLate();

        expect(report.mock.calls).toEqual([
            [LOST],
            [GAVE_UP],
            [{ phase: 'restored-late', latencyMs: CONTEXT_RESTORE_TIMEOUT_MS + 2500 }],
        ]);
        expect(monitor.isLost).toBe(true);
        expect(monitor.canRestore).toBe(false);
    });

    test('restoredLate reports nothing before the give-up or after a stop', () => {
        const { report, monitor } = setup();
        monitor.restoredLate();
        monitor.lost();
        monitor.restoredLate();
        monitor.stop();
        monitor.restoredLate();

        expect(report.mock.calls).toEqual([[LOST]]);
    });

    test("stop ends a loss without 'gave-up', and a late restore is ignored", () => {
        const { report, monitor } = setup();
        monitor.lost();

        monitor.stop();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
        const redraw = vi.fn();
        monitor.restored(redraw, Date.now());

        expect(report.mock.calls).toEqual([[LOST]]);
        expect(redraw).not.toHaveBeenCalled();
        expect(monitor.isLost).toBe(true);
        expect(monitor.canRestore).toBe(false);
    });

    test('dispose cancels the timeout and resets the state', () => {
        const { report, monitor } = setup();
        monitor.lost();

        monitor.dispose();
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);

        expect(report.mock.calls).toEqual([[LOST]]);
        expect(monitor.isLost).toBe(false);
        expect(monitor.canRestore).toBe(false);
    });
});
