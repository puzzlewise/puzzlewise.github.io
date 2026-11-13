import { describe, expect, test } from 'vitest';
import { FakeFrameHost } from '../../test-helpers/fake-frame-host.js';
import { FrameScheduler } from './frame-scheduler.js';

function setup(animateFor = 0) {
    const host = new FakeFrameHost();
    const draws: number[] = [];
    let ticks = 0;
    const scheduler = new FrameScheduler(host, {
        draw: () => draws.push(host.frame),
        tick: () => ++ticks < animateFor,
    });
    return { host, draws, scheduler };
}

describe('FrameScheduler', () => {
    test('a draw after the task, requested inside another rAF callback, is drawn in that same frame', () => {
        const { host, draws, scheduler } = setup();
        host.requestAnimationFrame(() => scheduler.drawAfterTask());

        host.runFrame();

        expect(draws).toEqual([1]);
        expect(host.pendingFrames()).toBe(0);
    });

    test('several draws after the task in one task draw once, without requesting a frame', () => {
        const { host, draws, scheduler } = setup();
        host.runTask(() => {
            scheduler.drawAfterTask();
            scheduler.drawAfterTask();
        });

        expect(draws).toEqual([0]);
        expect(host.pendingFrames()).toBe(0);
    });

    test('several next-frame draws in one task draw once, on the next frame', () => {
        const { host, draws, scheduler } = setup();
        host.runTask(() => {
            scheduler.drawNextFrame();
            scheduler.drawNextFrame();
        });
        expect(draws).toEqual([]);

        host.runFrame();
        host.runFrame();

        expect(draws).toEqual([1]);
    });

    test('next-frame draws from several tasks within one frame draw once', () => {
        const { host, draws, scheduler } = setup();
        host.runTask(() => scheduler.drawNextFrame());
        host.runTask(() => scheduler.drawNextFrame());

        host.runFrame();

        expect(draws).toEqual([1]);
    });

    test('an animation ticks and draws each frame until it reports done', () => {
        const { host, draws, scheduler } = setup(3);
        host.runTask(() => scheduler.drawNextFrame());
        for (let i = 0; i < 5; i++) host.runFrame();

        expect(draws).toEqual([1, 2, 3]);
        expect(host.pendingFrames()).toBe(0);
    });

    test('only a draw from an animation frame is told it is in a frame', () => {
        const host = new FakeFrameHost();
        const draws: boolean[] = [];
        const scheduler = new FrameScheduler(host, { draw: (inFrame) => draws.push(inFrame), tick: () => false });
        host.runTask(() => scheduler.drawAfterTask());
        host.runTask(() => scheduler.drawNextFrame());
        host.runFrame();
        host.requestAnimationFrame(() => scheduler.drawAfterTask());
        host.runFrame();

        expect(draws).toEqual([false, true, false]);
    });

    test('cancel stops a running animation', () => {
        const { host, draws, scheduler } = setup(10);
        host.runTask(() => scheduler.drawNextFrame());
        host.runFrame();
        scheduler.cancel();
        host.runFrame();

        expect(draws).toEqual([1]);
    });
});
