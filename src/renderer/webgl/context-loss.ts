export type ContextEventPhase = 'lost' | 'restored' | 'gave-up';

export const CONTEXT_RESTORE_TIMEOUT_MS = 5000;

/**
 * One report per phase, so the caller's message and analytics can't disagree.
 * After 'gave-up' the caller shows a failure message, so a late restore is
 * ignored rather than resuming behind it.
 */
export class ContextLossMonitor {
    private readonly report: (phase: ContextEventPhase) => void;
    private state: 'ok' | 'lost' | 'stopped' = 'ok';
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(report: (phase: ContextEventPhase) => void) {
        this.report = report;
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
        this.report('lost');
        this.timer = setTimeout(() => {
            this.timer = null;
            this.state = 'stopped';
            this.report('gave-up');
        }, CONTEXT_RESTORE_TIMEOUT_MS);
    }

    restored(redraw: () => void): void {
        if (this.state !== 'lost') return;
        this.clearTimer();
        this.state = 'ok';
        redraw();
        this.report('restored');
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
