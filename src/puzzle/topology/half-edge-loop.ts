import type { HalfEdge } from './dcel.js';

/**
 * Throws instead of spinning forever when a corrupt `next` chain leads into a
 * cycle that doesn't contain `start`. `slow` advances every other step (Floyd's
 * cycle detection): in a valid loop the walk is back at `start` before it can
 * meet `slow`, and in a corrupt one they meet within about twice the number of
 * reachable half-edges.
 */
export function walkLoop(start: HalfEdge): HalfEdge[] {
    const loop: HalfEdge[] = [];
    let current = start;
    let slow = start;
    do {
        loop.push(current);
        current = current.next;
        if (loop.length % 2 === 0) slow = slow.next;
        if (current === slow && current !== start) {
            throw new Error(
                `Half-edge loop from half-edge ${start.id} never returns to its start; the DCEL is corrupt`,
            );
        }
    } while (current !== start);
    return loop;
}
