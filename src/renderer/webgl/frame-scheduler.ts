export interface FrameHost {
    requestAnimationFrame(callback: (now: number) => void): number;
    cancelAnimationFrame(handle: number): void;
    queueMicrotask(callback: () => void): void;
}

export interface FrameWork {
    /** Must be a no-op when nothing is dirty: both paths can fire for one change. */
    draw(): void;
    /** Returns whether an animation is still running. */
    tick(now: number): boolean;
}

/**
 * Input-driven changes (pan, pinch, wheel) can arrive several times per frame,
 * so they draw on the next frame. The app already batches drag updates in its
 * own rAF callback, where a nested rAF would fire a frame late; those draw
 * after the current task instead.
 */
export class FrameScheduler {
    private readonly host: FrameHost;
    private readonly work: FrameWork;
    private drawQueued = false;
    private frameHandle: number | null = null;

    constructor(host: FrameHost, work: FrameWork) {
        this.host = host;
        this.work = work;
    }

    drawAfterTask(): void {
        if (this.drawQueued) return;
        this.drawQueued = true;
        this.host.queueMicrotask(() => {
            this.drawQueued = false;
            this.work.draw();
        });
    }

    drawNextFrame(): void {
        if (this.frameHandle !== null) return;
        this.frameHandle = this.host.requestAnimationFrame(this.onFrame);
    }

    cancel(): void {
        if (this.frameHandle !== null) this.host.cancelAnimationFrame(this.frameHandle);
        this.frameHandle = null;
    }

    private readonly onFrame = (now: number): void => {
        this.frameHandle = null;
        const animating = this.work.tick(now);
        this.work.draw();
        if (animating) this.drawNextFrame();
    };
}
