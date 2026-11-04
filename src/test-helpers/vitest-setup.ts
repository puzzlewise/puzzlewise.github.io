import { beforeEach, expect } from 'vitest';
import { startHangWatchdog, type HangWatchdog } from './hang-watchdog.js';

// `testTimeout` can't interrupt a synchronous loop, and a fork worker stuck in
// one never notices its parent exit: one orphan spun for three days.
const registry = globalThis as { __puzzleHangWatchdog?: HangWatchdog };
const watchdog = (registry.__puzzleHangWatchdog ??= startHangWatchdog({ maxBlockedMs: 180_000 }));

beforeEach(() => {
    const { testPath, currentTestName } = expect.getState();
    watchdog.beat(`${testPath} > ${currentTestName}`);
});
