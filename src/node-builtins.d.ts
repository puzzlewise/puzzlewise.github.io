/**
 * Minimal ambient decls for the Node builtins the tests and test helpers use.
 * Deliberately not `@types/node`: `tsconfig.json` pins `types` to
 * `vite/client` + `vite-plugin-pwa/client`, so the app's type surface is a
 * browser's — pulling in Node's would let `process`/`Buffer`/`__dirname`
 * typecheck in client code that has none at runtime. Keep to what's imported.
 */

declare module 'node:child_process' {
    export function spawnSync(
        file: string,
        args: readonly string[],
        options?: { encoding?: 'utf8'; timeout?: number },
    ): {
        status: number | null;
        signal: string | null;
        stdout: string | null;
        stderr: string | null;
        error?: { message: string };
    };
}

declare module 'node:fs' {
    export function mkdtempSync(prefix: string): string;
    export function readdirSync(path: string): string[];
    export function writeFileSync(path: string, data: string): void;
    export function rmSync(
        path: string,
        options?: { recursive?: boolean; force?: boolean },
    ): void;
}


declare module 'node:path' {
    export function join(...parts: string[]): string;
}

declare module 'node:process' {
    const process: {
        readonly pid: number;
        readonly ppid: number;
        readonly execPath: string;
        kill(pid: number, signal?: string | number): true;
    };
    export default process;
}

declare module 'node:timers' {
    export function setInterval(callback: () => void, ms: number): { unref(): void };
}

declare module 'node:worker_threads' {
    export class Worker {
        constructor(
            source: string,
            options: { eval: true; execArgv?: string[]; workerData?: unknown },
        );
        postMessage(value: unknown): void;
        unref(): void;
    }
}
