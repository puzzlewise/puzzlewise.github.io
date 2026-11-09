import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFrameCoalescer } from './frame-coalescer.js';

describe('createFrameCoalescer', () => {
    let frames: Map<number, FrameRequestCallback>;

    function runFrame(): void {
        const due = [...frames.values()];
        frames.clear();
        for (const cb of due) cb(0);
    }

    beforeEach(() => {
        frames = new Map();
        let nextId = 1;
        vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
            frames.set(nextId, cb);
            return nextId++;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('runs once on the next frame however often it was scheduled', () => {
        const run = vi.fn();
        const frame = createFrameCoalescer(run);

        frame.schedule();
        frame.schedule();
        frame.schedule();

        expect(run).not.toHaveBeenCalled();
        runFrame();
        expect(run).toHaveBeenCalledOnce();
        runFrame();
        expect(run).toHaveBeenCalledOnce();
    });

    it('schedules again after a frame has run', () => {
        const run = vi.fn();
        const frame = createFrameCoalescer(run);

        frame.schedule();
        runFrame();
        frame.schedule();
        runFrame();

        expect(run).toHaveBeenCalledTimes(2);
    });

    it('flush runs a pending call now instead of on the frame', () => {
        const run = vi.fn();
        const frame = createFrameCoalescer(run);

        frame.schedule();
        frame.flush();
        expect(run).toHaveBeenCalledOnce();

        runFrame();
        expect(run).toHaveBeenCalledOnce();
    });

    it('flush does nothing when nothing is pending', () => {
        const run = vi.fn();

        createFrameCoalescer(run).flush();

        expect(run).not.toHaveBeenCalled();
    });

    it('cancel drops a pending call', () => {
        const run = vi.fn();
        const frame = createFrameCoalescer(run);

        frame.schedule();
        frame.cancel();
        runFrame();
        frame.flush();

        expect(run).not.toHaveBeenCalled();
    });
});
