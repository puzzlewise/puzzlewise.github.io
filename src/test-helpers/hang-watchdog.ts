import { Worker } from 'node:worker_threads';
import { setInterval } from 'node:timers';
import process from 'node:process';

export interface HangWatchdog {
    beat(label?: string): void;
}

const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { writeSync } = require('node:fs');
const { parentPid, maxBlockedMs } = workerData;
let lastBeat = performance.now();
let label = '';
parentPort.on('message', (message) => {
    lastBeat = performance.now();
    if (message) label = message;
});
function parentGone() {
    if (process.ppid !== parentPid) return true;
    try {
        process.kill(parentPid, 0);
        return false;
    } catch (error) {
        return error.code === 'ESRCH';
    }
}
setInterval(() => {
    let reason = '';
    if (parentGone()) reason = 'parent process ' + parentPid + ' is gone';
    else if (performance.now() - lastBeat > maxBlockedMs) reason = 'main thread blocked for over ' + maxBlockedMs + ' ms';
    if (!reason) return;
    try {
        writeSync(2, '[hang-watchdog] ' + reason + (label ? ' in ' + label : '') + '; killing pid ' + process.pid + '\\n');
    } catch {}
    process.kill(process.pid, 'SIGKILL');
}, 1000);
`;

export function startHangWatchdog({ maxBlockedMs }: { maxBlockedMs: number }): HangWatchdog {
    const worker = new Worker(WATCHDOG_SOURCE, {
        eval: true,
        execArgv: [],
        workerData: { parentPid: process.ppid, maxBlockedMs },
    });
    worker.unref();
    setInterval(() => worker.postMessage(null), 500).unref();
    return { beat: (label) => worker.postMessage(label ?? null) };
}
