/**
 * The 20 trace JSONs and `tab-shapes-traced.ts` live behind a dynamic
 * `import()`, so they don't ship in the main chunk. The Composable cut style is
 * hidden in production, but a share link with `cf.tg: "traced"` can land at any
 * client, so the path stays reachable — lazily.
 *
 * The registry hands out {@link tracedTabGeneratorStub} at boot. Callers about
 * to run traced generation must `await preloadTracedTabGenerator()` first so the
 * dynamic import resolves and the stub's delegate slot fills; the stub keeps
 * dispatching after, no re-registration needed.
 */

import { track } from '../../analytics/index.js';
import { sanitizeErrorReason } from '../../analytics/sanitize-error-reason.js';
import type { TabGenerator } from './plugin-types.js';

/**
 * Bucket a chunk-load failure so analytics aggregate despite the high-cardinality
 * raw `reason`. Matches the engines' dynamic-`import()` phrasings (Chromium
 * "Failed to fetch", Firefox "error loading", Safari "Importing a module script
 * failed") and groups parse/eval failures (incl. the missing-export below) as `parse`.
 */
function classifyFailure(reason: string): 'network' | 'parse' | 'unknown' {
    const msg = reason.toLowerCase();
    if (
        msg.includes('failed to fetch')
        || msg.includes('error loading')
        || msg.includes('importing a module script failed')
        || msg.includes('dynamically imported module')
        || msg.includes('network')
    ) {
        return 'network';
    }
    if (
        msg.includes('syntax')
        || msg.includes('unexpected')
        || msg.includes('parse')
        || msg.includes('export')
    ) {
        return 'parse';
    }
    return 'unknown';
}

/**
 * Classify a resolved-chunk timing entry from transfer size vs cached body size
 * (both populated for our same-origin chunk): `warm` (transferSize 0, from
 * cache), `revalidated` (small nonzero below body size — a 304 carried headers
 * only, still a round trip), `cold` (at/above body size, full download). Keeping
 * `revalidated` distinct stops 304s inflating the cold-latency distribution.
 * `deliveryType` is not consulted: ambiguous for 304s across engines and
 * redundant with transferSize 0 for a true hit.
 */
function classifyEntryCache(
    entry: PerformanceResourceTiming,
): 'cold' | 'warm' | 'revalidated' {
    if (entry.transferSize === 0) {
        return 'warm';
    }
    if (entry.encodedBodySize > 0 && entry.transferSize < entry.encodedBodySize) {
        return 'revalidated';
    }
    return 'cold';
}

/**
 * Locate the resolved chunk's Resource Timing entry and classify it. Returns
 * `'unknown'` when no usable entry exists — API absent (non-browser/jsdom),
 * entry evicted from a full buffer (buffer size bumped at boot in
 * app/global-handlers.ts), or the import was mocked in tests; `'unknown'` thus
 * conflates unsupported with evicted.
 */
function detectCacheState(): 'cold' | 'warm' | 'revalidated' | 'unknown' {
    if (typeof performance === 'undefined'
        || typeof performance.getEntriesByType !== 'function') {
        return 'unknown';
    }
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (let i = entries.length - 1; i >= 0; i--) {
        // Coupled to the dynamic import below: Vite names the chunk
        // `traced-tab-generator-<hash>.js`; a manualChunks/chunkFileNames rename
        // would break this match — keep the two in sync.
        if (entries[i].name.includes('traced-tab-generator')) {
            return classifyEntryCache(entries[i]);
        }
    }
    return 'unknown';
}

let preloadPromise: Promise<void> | null = null;
let realGenerator: TabGenerator | null = null;
let attemptCount = 0;

/**
 * Thrown when traced generation runs before {@link preloadTracedTabGenerator}
 * has resolved in this realm. A distinct class so callers (across a worker
 * boundary) can tell "chunk missing *here*" apart from a real generation fault:
 * the realm, not the request — `generation-worker-core.ts` classifies it as an
 * infrastructure failure for that reason.
 */
export class TracedTabLibraryNotLoadedError extends Error {
    constructor() {
        super(
            'Traced tab library not loaded. '
            + 'Call preloadTracedTabGenerator() before generating traced tabs.',
        );
        this.name = 'TracedTabLibraryNotLoadedError';
    }
}

function ensureLoaded(): TabGenerator {
    if (!realGenerator) {
        throw new TracedTabLibraryNotLoadedError();
    }
    return realGenerator;
}

export const tracedTabGeneratorStub: TabGenerator = {
    id: 'traced',
    generate(edge, random, config) {
        return ensureLoaded().generate(edge, random, config);
    },
    // Forward the retry ladder too, so `applyTabs` runs it via the registry
    // path. Without this the stub looks non-variant and the ladder silently
    // never runs. Falls back to a single `generate` candidate if a future real
    // generator drops `generateVariants`.
    generateVariants(edge, random, config) {
        const real = ensureLoaded();
        if (real.generateVariants) {
            return real.generateVariants(edge, random, config);
        }
        const candidate = real.generate(edge, random, config);
        return candidate ? [candidate] : [];
    },
};

/**
 * For a realm that bundles the generator instead of importing it lazily (the
 * generation worker). Filling the stub's slot, not re-registering, keeps every
 * realm dispatching through {@link tracedTabGeneratorStub}.
 */
export function installTracedTabGenerator(generator: TabGenerator): void {
    realGenerator = generator;
}

/**
 * Idempotent — concurrent callers and retries share one in-flight promise;
 * awaiting it guarantees the next synchronous generation uses the real impl.
 * On import rejection the cached promise is cleared so the next call retries
 * (the rejection still propagates).
 *
 * Emits per-import-attempt analytics (`traced-chunk-preload-started`, then
 * `traced-chunk-loaded` or `traced-chunk-load-failed`), each carrying a 1-based
 * `attempt` so a retry is distinguishable from a cold load. Cached-promise
 * repeats emit nothing, so events count real fetches, not awaits.
 */
export function preloadTracedTabGenerator(): Promise<void> {
    if (preloadPromise) return preloadPromise;
    const attempt = ++attemptCount;
    const startedAt = performance.now();
    track('traced-chunk-preload-started', { attempt });
    // Emits `traced-tab-generator-<hash>.js`; detectCacheState() matches that name.
    const inflight = import('./traced-tab-generator.js').then((m) => {
        if (!m.tracedTabGenerator) {
            // Fetched/parsed but the expected export is absent (tree-shake/rename
            // regression); fail here rather than as a confusing stub throw later.
            throw new Error('Traced chunk resolved without a tracedTabGenerator export');
        }
        realGenerator = m.tracedTabGenerator;
        track('traced-chunk-loaded', {
            durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
            cacheState: detectCacheState(),
            attempt,
        });
    }).catch((err) => {
        if (preloadPromise === inflight) preloadPromise = null;
        const reason = sanitizeErrorReason(err);
        track('traced-chunk-load-failed', {
            reason,
            kind: classifyFailure(reason),
            attempt,
        });
        throw err;
    });
    preloadPromise = inflight;
    return preloadPromise;
}
