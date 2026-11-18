/**
 * The generation worker's message handler, split from the entry
 * (`generation-worker.ts`) so it can be unit-tested — importing the entry in
 * jsdom would register a `message` listener on the shared window and leak.
 */

import { TracedTabLibraryNotLoadedError } from '../puzzle/topology/traced-tab-loader.js';
import {
    runGeneration,
    type GenerationRequest,
    type GenerationResult,
} from './generation-core.js';

/**
 * Which half of the worker failed, so the client can pick a policy:
 *  - `'infrastructure'` — worker plumbing broke (the traced generator missing
 *    from this realm, or the response post). The main thread loads its own
 *    copy, so falling back and re-running there is likely to succeed.
 *  - `'generation'` — generation itself threw. Pure function of the request, so
 *    a main-thread rerun throws identically a full generation later; surface now.
 *
 * Split by cause, not by which `try` caught it: a throw from inside generation
 * can still be about the realm not the request
 * ({@link TracedTabLibraryNotLoadedError}), and only the request half
 * reproduces across threads.
 */
export type GenerationFailureKind = 'infrastructure' | 'generation';

export type GenerationResponse =
    | { ok: true; result: GenerationResult }
    | { ok: false; kind: GenerationFailureKind; error: string; name: string };

export function handleGenerationRequest(request: GenerationRequest): GenerationResponse {
    try {
        return { ok: true, result: runGeneration(request) };
    } catch (err) {
        return describeFailure(
            err instanceof TracedTabLibraryNotLoadedError ? 'infrastructure' : 'generation',
            err,
        );
    }
}

/**
 * Flatten a thrown value into the wire shape. `name` travels alongside
 * `message` because only plain data crosses `postMessage`, and this response is
 * the only place worker-side failures reach analytics. The client
 * (`generate-async.ts`) puts the name back in front of the message on both
 * branches rather than letting it stop at the console.
 */
export function describeFailure(
    kind: GenerationFailureKind,
    err: unknown,
): { ok: false; kind: GenerationFailureKind; error: string; name: string } {
    return {
        ok: false,
        kind,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : 'Error',
    };
}
