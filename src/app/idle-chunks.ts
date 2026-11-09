// Safari has no requestIdleCallback; the fallback yields a macrotask between
// chunks of at most this many milliseconds.
const FALLBACK_CHUNK_MS = 8;

/**
 * Runs `work` on each item in idle-time chunks, always at least one item per
 * chunk. Returns a cancel function that stops the remaining items.
 */
export function runInIdleChunks<T>(
    items: readonly T[],
    work: (item: T) => void,
): () => void {
    let next = 0;
    let cancelled = false;
    let cancelPending: () => void = () => {};

    const runChunk = (hasTimeLeft: () => boolean): void => {
        if (cancelled) return;
        do {
            work(items[next++]);
        } while (next < items.length && hasTimeLeft());
        if (next < items.length) schedule();
    };

    const schedule = (): void => {
        if (typeof requestIdleCallback === 'function') {
            const handle = requestIdleCallback((deadline) => runChunk(() => deadline.timeRemaining() > 0));
            cancelPending = () => cancelIdleCallback(handle);
        } else {
            const handle = setTimeout(() => {
                const end = performance.now() + FALLBACK_CHUNK_MS;
                runChunk(() => performance.now() < end);
            }, 0);
            cancelPending = () => clearTimeout(handle);
        }
    };

    if (items.length > 0) schedule();

    return () => {
        cancelled = true;
        cancelPending();
    };
}
