import { describe, it, expect, afterEach, vi } from 'vitest';
import { runInIdleChunks } from './idle-chunks.js';

type IdleCallback = (deadline: IdleDeadline) => void;

function stubIdleCallback(): { flush: (msRemaining: number) => void; pending: () => number } {
    let queue: IdleCallback[] = [];
    vi.stubGlobal('requestIdleCallback', vi.fn((cb: IdleCallback) => {
        queue.push(cb);
        return queue.length;
    }));
    vi.stubGlobal('cancelIdleCallback', vi.fn(() => {
        queue = [];
    }));
    return {
        flush(msRemaining) {
            const batch = queue;
            queue = [];
            let remaining = msRemaining;
            for (const cb of batch) {
                cb({ didTimeout: false, timeRemaining: () => Math.max(0, --remaining) });
            }
        },
        pending: () => queue.length,
    };
}

describe('runInIdleChunks', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does nothing synchronously', () => {
        stubIdleCallback();
        const work = vi.fn();

        runInIdleChunks([1, 2, 3], work);

        expect(work).not.toHaveBeenCalled();
    });

    it('stops a chunk when the idle deadline runs out and resumes in the next', () => {
        const idle = stubIdleCallback();
        const done: number[] = [];

        runInIdleChunks([1, 2, 3, 4, 5], (n) => done.push(n));
        idle.flush(2);

        expect(done).toEqual([1, 2]);
        expect(idle.pending()).toBe(1);

        idle.flush(100);

        expect(done).toEqual([1, 2, 3, 4, 5]);
        expect(idle.pending()).toBe(0);
    });

    it('processes at least one item per chunk even with no idle time left', () => {
        const idle = stubIdleCallback();
        const done: number[] = [];

        runInIdleChunks([1, 2], (n) => done.push(n));
        idle.flush(0);

        expect(done).toEqual([1]);
    });

    it('runs no further items once cancelled', () => {
        const idle = stubIdleCallback();
        const done: number[] = [];

        const cancel = runInIdleChunks([1, 2, 3], (n) => done.push(n));
        idle.flush(1);
        cancel();
        idle.flush(100);

        expect(done).toEqual([1]);
    });

    it('falls back to time-budgeted timeouts without requestIdleCallback', () => {
        vi.stubGlobal('requestIdleCallback', undefined);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const done: number[] = [];

        runInIdleChunks([1, 2, 3], (n) => {
            done.push(n);
            now += 5;
        });
        vi.advanceTimersToNextTimer();

        expect(done).toEqual([1, 2]);

        vi.runAllTimers();

        expect(done).toEqual([1, 2, 3]);
    });

    it('cancels a pending fallback timeout', () => {
        vi.stubGlobal('requestIdleCallback', undefined);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const work = vi.fn();

        const cancel = runInIdleChunks([1], work);
        cancel();
        vi.runAllTimers();

        expect(work).not.toHaveBeenCalled();
    });
});
