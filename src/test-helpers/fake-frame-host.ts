import type { FrameHost } from '../renderer/webgl/frame-scheduler.js';

/** Mirrors the browser: rAF callbacks registered during a frame run next frame; microtasks drain after each callback. */
export class FakeFrameHost implements FrameHost {
    frame = 0;
    private callbacks = new Map<number, (now: number) => void>();
    private microtasks: (() => void)[] = [];
    private nextHandle = 1;

    requestAnimationFrame(callback: (now: number) => void): number {
        const handle = this.nextHandle++;
        this.callbacks.set(handle, callback);
        return handle;
    }

    cancelAnimationFrame(handle: number): void {
        this.callbacks.delete(handle);
    }

    queueMicrotask(callback: () => void): void {
        this.microtasks.push(callback);
    }

    runTask(task: () => void): void {
        task();
        this.drainMicrotasks();
    }

    runFrame(): void {
        this.frame++;
        const due = [...this.callbacks.values()];
        this.callbacks.clear();
        for (const callback of due) {
            callback(this.frame * 16);
            this.drainMicrotasks();
        }
    }

    pendingFrames(): number {
        return this.callbacks.size;
    }

    private drainMicrotasks(): void {
        while (this.microtasks.length > 0) this.microtasks.shift()!();
    }
}
