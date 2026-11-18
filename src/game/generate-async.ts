/**
 * Main-thread client for off-thread puzzle generation.
 *
 * A fresh worker per call, terminated when done: cancellation is just
 * `terminate()`, no stale worker state, and spawn cost is negligible once per
 * new game. Any worker-PATH failure (no Worker, spawn/script-load failure)
 * falls back to synchronous main-thread generation — the pre-worker status
 * quo.
 *
 * The exception: a `kind: 'generation'` response (`generation-worker-core.ts`)
 * does NOT fall back. Generation is a pure function of the request, so the
 * rerun would throw identically after a second full freeze; this module
 * rethrows to the caller instead.
 *
 * Cancellation: an aborted signal terminates the worker and rejects with
 * {@link GenerationCanceledError}, never falling back — the user asked for no
 * puzzle, not a slower one.
 */

import { diagnostics } from '../diagnostics.js';
import { sanitizeErrorReason } from '../analytics/sanitize-error-reason.js';
import { preloadTracedTabGenerator } from '../puzzle/topology/traced-tab-loader.js';
import {
    runGeneration,
    requestNeedsTracedTabs,
    type GenerationRequest,
    type GenerationResult,
} from './generation-core.js';
import type { GenerationResponse } from './generation-worker-core.js';

/** Rejection sentinel for a canceled generation. */
export class GenerationCanceledError extends Error {
    constructor() {
        super('Puzzle generation canceled');
        this.name = 'GenerationCanceledError';
    }
}

/**
 * Low-cardinality bucket for why generation ran on the main thread, reported
 * alongside the free-text `fallbackReason`. A bucket because the reasons are
 * unbucketable on their own — per the HTML spec a worker whose script fails to
 * fetch fires a plain `Event` with no `message`, so chunk-missing, CSP-blocked,
 * and no-module-worker-support all produce the same text.
 */
export type GenerationFallbackKind =
    /** No `Worker` constructor in this environment. */
    | 'no-worker'
    /** `new Worker(...)` or the request `postMessage` threw synchronously. */
    | 'spawn-failed'
    /** The worker fired `error`: script fetch/parse failure, or an uncaught throw. */
    | 'worker-error'
    /** Response unusable: `messageerror`, or reading the payload threw. */
    | 'message-error'
    /** The worker reported a failure of its own plumbing. */
    | 'worker-infrastructure';

/**
 * A worker-side failure of `runGeneration` itself. Deterministic, so it must
 * NOT be retried on the main thread — the rerun would freeze for a second full
 * generation and throw identically.
 */
class WorkerGenerationError extends Error {
    constructor(message: string, workerErrorName: string) {
        // The worker-side type goes into the message, not `name`: this error is
        // the one path that leaves this module unhandled, reaching
        // `runWithErrorReport` whose reason is `sanitizeErrorReason` (reads
        // `.message` only). On `name` it would stop at the console.
        super(withErrorName(workerErrorName, message));
        this.name = 'WorkerGenerationError';
    }
}

/** A failure of the worker path itself; re-running on the main thread is the answer. */
class WorkerPathError extends Error {
    readonly kind: GenerationFallbackKind;
    constructor(kind: GenerationFallbackKind, message: string, name = 'Error') {
        super(message);
        this.kind = kind;
        this.name = name;
    }
}

export interface OffThreadGeneration {
    result: GenerationResult;
    mode: 'worker' | 'sync-fallback';
    /** Present only when `mode` is `'sync-fallback'`. */
    fallbackKind?: GenerationFallbackKind;
    /** Present only when `mode` is `'sync-fallback'`. */
    fallbackReason?: string;
}

export async function generatePiecesOffThread(
    request: GenerationRequest,
    signal?: AbortSignal,
): Promise<OffThreadGeneration> {
    if (signal?.aborted) throw new GenerationCanceledError();

    if (typeof Worker === 'undefined') {
        return runOnMainThread(request, signal, 'no-worker', 'no-worker');
    }

    try {
        const result = await runInWorker(request, signal);
        return { result, mode: 'worker' };
    } catch (err) {
        if (err instanceof GenerationCanceledError) throw err;
        // Pure function of the request: a worker-side `runGeneration` throw
        // reproduces here. Falling back would just freeze again and rethrow, so
        // surface it now.
        if (err instanceof WorkerGenerationError) throw err;
        diagnostics.warn('Generation worker failed; falling back to main thread:', err);
        if (signal?.aborted) throw new GenerationCanceledError();
        const kind = err instanceof WorkerPathError ? err.kind : 'spawn-failed';
        return runOnMainThread(request, signal, kind, sanitizedReasonWithErrorName(err));
    }
}

/**
 * Prefixes the message with the error name (`TypeError: …`), except a bare
 * `'Error'` name, which would only spend the reason's length budget.
 */
function withErrorName(name: string, message: string): string {
    return name && name !== 'Error' ? `${name}: ${message}` : message;
}

/**
 * `sanitizeErrorReason` reads `.message` only, so the worker's `name` would
 * otherwise be dropped — and `generationFallbackReason` is the only place a
 * recovered worker-side failure reaches analytics. Composed before sanitizing
 * so the name gets the same redaction and length cap.
 */
function sanitizedReasonWithErrorName(err: unknown): string {
    if (err instanceof Error) return sanitizeErrorReason(withErrorName(err.name, err.message));
    return sanitizeErrorReason(err);
}

/**
 * The synchronous fallback. Blocks the main thread for the whole generate phase
 * (the pre-worker status quo) — which is why the two things wrapped around it
 * exist.
 */
async function runOnMainThread(
    request: GenerationRequest,
    signal: AbortSignal | undefined,
    fallbackKind: GenerationFallbackKind,
    fallbackReason: string,
): Promise<OffThreadGeneration> {
    if (requestNeedsTracedTabs(request)) {
        await preloadTracedTabGenerator();
        if (signal?.aborted) throw new GenerationCanceledError();
    }

    const result = runGeneration(request);

    // Generation just blocked the main thread, so a Cancel click made during it
    // is still queued as an undispatched task. Yield before reading the signal,
    // or the click is dropped — the puzzle installs and no `generation-canceled`
    // fires — for exactly the population with the longest freeze.
    await yieldToTaskQueue();
    if (signal?.aborted) throw new GenerationCanceledError();

    return { result, mode: 'sync-fallback', fallbackKind, fallbackReason };
}

/** Let queued tasks — notably a pending user-input event — run. */
function yieldToTaskQueue(): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function runInWorker(
    request: GenerationRequest,
    signal?: AbortSignal,
): Promise<GenerationResult> {
    return new Promise<GenerationResult>((resolve, reject) => {
        const worker = new Worker(
            new URL('./generation-worker.js', import.meta.url),
            { type: 'module' },
        );
        const settle = (fn: () => void) => {
            worker.terminate();
            signal?.removeEventListener('abort', onAbort);
            try {
                fn();
            } catch (err) {
                // `fn` reads the message payload, so a malformed response can
                // throw here. Without this the promise never settles and the
                // overlay stays up until reload. Wrapped (not rethrown raw) so
                // it doesn't hit the `'spawn-failed'` default, which names a
                // cause that didn't happen.
                reject(new WorkerPathError(
                    'message-error',
                    err instanceof Error ? err.message : String(err),
                    err instanceof Error ? err.name : 'Error',
                ));
            }
        };
        const onAbort = () => settle(() => reject(new GenerationCanceledError()));
        signal?.addEventListener('abort', onAbort);
        worker.addEventListener('message', (event: MessageEvent<GenerationResponse>) => settle(() => {
            const response = event.data;
            if (response.ok) resolve(response.result);
            else if (response.kind === 'generation') {
                reject(new WorkerGenerationError(response.error, response.name));
            } else {
                reject(new WorkerPathError(
                    'worker-infrastructure', response.error, response.name,
                ));
            }
        }));
        worker.addEventListener('error', (event) => {
            // Cancel the event: per the HTML spec an uncanceled worker `error`
            // is re-reported in the parent's global scope, where
            // `error-tracking.ts`'s window `error` listener would ship a
            // spurious `unhandled-error` (`isIgnorableErrorEvent` won't filter
            // it — the filename is the worker chunk, not an extension URL).
            event.preventDefault();
            settle(() => reject(new WorkerPathError(
                'worker-error', event.message || 'Generation worker error',
            )));
        });
        worker.addEventListener('messageerror', () => settle(() => reject(new WorkerPathError(
            'message-error', 'Generation worker response failed to deserialize',
        ))));
        try {
            worker.postMessage(request);
        } catch (err) {
            // Synchronously thrown — e.g. a `DataCloneError` from a
            // non-cloneable request field. Route through `settle`: otherwise the
            // throw still rejects the promise, but `terminate()` and the abort
            // listener removal never run, leaking the worker and the listener.
            settle(() => reject(new WorkerPathError(
                'spawn-failed',
                err instanceof Error ? err.message : String(err),
                err instanceof Error ? err.name : 'Error',
            )));
        }
    });
}
