import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const WATCHDOG = new URL('./hang-watchdog.ts', import.meta.url).pathname;

function spinner(maxBlockedMs: number, spinMs = Infinity, label = ''): string {
    return `const { startHangWatchdog } = await import(${JSON.stringify(WATCHDOG)});
        const { writeSync } = await import('node:fs');
        startHangWatchdog({ maxBlockedMs: ${maxBlockedMs} }).beat(${JSON.stringify(label)});
        writeSync(2, 'ready\\n');
        const until = Date.now() + ${spinMs};
        while (Date.now() < until);`;
}

function runNode(script: string) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 15_000,
    });
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!isAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !isAlive(pid);
}

describe('startHangWatchdog', () => {
    it('kills a spinning process once its parent has exited', async () => {
        const parent = `const { spawn } = await import('node:child_process');
            const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(spinner(60_000))}], { stdio: ['ignore', 'ignore', 'pipe'] });
            const report = (state) => { console.log(child.pid, state); process.exit(0); };
            child.stderr.on('data', (chunk) => { if (String(chunk).includes('ready')) report(child.exitCode === null ? 'running' : 'exited'); });
            setTimeout(() => report('never-ready'), 10_000);`;
        const [pidText, stateAtParentExit] = (runNode(parent).stdout ?? '').trim().split(' ');
        const pid = Number(pidText);
        try {
            expect(stateAtParentExit).toBe('running');
            expect(await waitForExit(pid, 10_000)).toBe(true);
        } finally {
            if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
    }, 20_000);

    it('kills a process whose main thread stays blocked past the limit', () => {
        const result = runNode(spinner(1000, Infinity, 'the stuck test'));
        expect(result.signal).toBe('SIGKILL');
        expect(result.stderr).toContain('[hang-watchdog]');
        expect(result.stderr).toContain('in the stuck test');
    }, 20_000);

    it('is installed in every test worker by the vitest setup file', () => {
        expect((globalThis as { __puzzleHangWatchdog?: unknown }).__puzzleHangWatchdog).toBeDefined();
    });

    it('leaves an idle process alone past the limit while its event loop runs', () => {
        const result = runNode(`const { startHangWatchdog } = await import(${JSON.stringify(WATCHDOG)});
            startHangWatchdog({ maxBlockedMs: 1000 });
            setTimeout(() => process.exit(0), 2500);`);
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('[hang-watchdog]');
    }, 20_000);

    it('leaves a process alone that blocks for less than the limit', () => {
        const result = runNode(spinner(3000, 500));
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('[hang-watchdog]');
    }, 20_000);
});
