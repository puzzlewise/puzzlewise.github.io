/** `latencyMs` runs from the loss to the browser's restore event. */
export type ContextEvent =
    | { phase: 'lost' }
    | { phase: 'gave-up' }
    | { phase: 'restored'; latencyMs: number }
    | { phase: 'restored-late'; latencyMs: number };

export const CONTEXT_RESTORE_TIMEOUT_MS = 5000;

/**
 * One report per phase, so the caller's message and analytics can't disagree.
 * After 'gave-up' the caller shows a failure message, so a late restore is
 * reported but never resumes drawing behind it.
 */
export class ContextLossMonitor {
    private readonly report: (event: ContextEvent) => void;
    private readonly now: () => number;
    private state: 'ok' | 'lost' | 'gave-up' | 'stopped' = 'ok';
    private lostAt = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(report: (event: ContextEvent) => void, now: () => number) {
        this.report = report;
        this.now = now;
    }

    get isLost(): boolean {
        return this.state !== 'ok';
    }

    get canRestore(): boolean {
        return this.state === 'lost';
    }

    lost(): void {
        if (this.state !== 'ok') return;
        this.state = 'lost';
        this.lostAt = this.now();
        this.report({ phase: 'lost' });
        this.timer = setTimeout(() => {
            this.timer = null;
            this.state = 'gave-up';
            this.report({ phase: 'gave-up' });
        }, CONTEXT_RESTORE_TIMEOUT_MS);
    }

    restored(redraw: () => void, restoredAt: number): void {
        if (this.state !== 'lost') return;
        this.clearTimer();
        this.state = 'ok';
        redraw();
        this.report({ phase: 'restored', latencyMs: restoredAt - this.lostAt });
    }

    restoredLate(): void {
        if (this.state !== 'gave-up') return;
        this.state = 'stopped';
        this.report({ phase: 'restored-late', latencyMs: this.now() - this.lostAt });
    }

    stop(): void {
        if (this.state !== 'lost') return;
        this.clearTimer();
        this.state = 'stopped';
    }

    dispose(): void {
        this.clearTimer();
        this.state = 'ok';
    }

    private clearTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }
}
