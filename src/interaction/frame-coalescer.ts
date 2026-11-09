export interface FrameCoalescer {
    schedule(): void;
    flush(): void;
    cancel(): void;
}

export function createFrameCoalescer(run: () => void): FrameCoalescer {
    let frame: number | null = null;

    const cancel = (): void => {
        if (frame === null) return;
        cancelAnimationFrame(frame);
        frame = null;
    };

    return {
        schedule() {
            frame ??= requestAnimationFrame(() => {
                frame = null;
                run();
            });
        },
        flush() {
            if (frame === null) return;
            cancel();
            run();
        },
        cancel,
    };
}
