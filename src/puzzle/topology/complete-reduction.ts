/**
 * Repair for a silent gap in bezier-js's `reduce()`.
 *
 * `Bezier.intersects` runs `curveintersects(this.reduce(), ...)`, which
 * only pairs the sub-curves it's handed — so any range `reduce()` drops
 * is unreachable to intersection: a crossing there is not found at all.
 *
 * `reduce()` can drop a range: its `return []` inside a `forEach`
 * callback skips the `if (t1 < 1)` tail-append that would emit the
 * piece, striking when an extremum lands within ~one 0.01 step of a
 * segment boundary. Rare but load-bearing — #498 lost a cut crossing in
 * such a sliver, leaving `buildDCEL` a missing vertex and fusing the
 * four faces around it into one 2×2 piece.
 */

import { Bezier } from 'bezier-js';
import { reduce } from './bezier-js-port.js';

/**
 * Ignore coverage holes narrower than this in `t`: far below a pixel of
 * curve (no crossing possible), and filling one would only feed
 * `pairiteration` degenerate input.
 */
const MIN_GAP_T = 1e-9;

/**
 * `curve.reduce()`, with any `t`-ranges it omitted added back. The
 * sub-curves cover `[0, 1]`, each carrying the `_t1`/`_t2` range
 * `pairiteration` maps hits back through, so the result feeds straight
 * into `Bezier.curveintersects`. Not sorted (it pairs all-against-all),
 * so callers must not rely on `t` order.
 *
 * When `reduce()` already covers the curve (the common case) its array
 * is returned as-is, so intersection stays bit-identical to
 * `intersects()` — this keeps the blast radius small, since generated
 * geometry is a reproducibility contract for share links and saves. Not
 * quite neutral where a hole is filled: a middle hole emits its hits
 * before later original parts, so `Curve.intersect`'s first-hit-wins
 * dedup can keep a slightly different point.
 */
export function completeReduction(curve: Bezier, parts = reduce(curve)): Bezier[] {
    const completed: Bezier[] = [];
    let cursor = 0;
    let filled = false;
    for (const part of parts) {
        if (part._t1 > cursor + MIN_GAP_T) {
            completed.push(subCurve(curve, cursor, part._t1));
            filled = true;
        }
        completed.push(part);
        // `Math.max` so an out-of-order part can't rewind the cursor and
        // double-fill. A NaN bound poisons the cursor permanently — the
        // safe direction: later comparisons all fail, leaving the curve
        // as `reduce()` returned it rather than a NaN-bounded piece
        // `pairiteration` never converges on. Both need a stubbed
        // `reduce()` to reach.
        cursor = Math.max(cursor, part._t2);
    }
    if (cursor < 1 - MIN_GAP_T) {
        completed.push(subCurve(curve, cursor, 1));
        filled = true;
    }

    // Return the original `parts` (not `completed`) so the caller gets
    // the very array `reduce()` returned. Saves an array object, not the
    // allocation.
    return filled ? completed : parts;
}

/**
 * The piece of `curve` over `[t1, t2]`, tagged with that range.
 * `_t1`/`_t2` are what `pairiteration` uses to map a hit back onto the
 * original curve. `Bezier.split` already sets them here, but they're
 * reassigned anyway so the range stays absolute even if someone later
 * splits from a sub-curve.
 */
function subCurve(curve: Bezier, t1: number, t2: number): Bezier {
    // `split(0, 1)` runs a full de Casteljau pass to return the same
    // curve; build the whole-curve case directly.
    const piece = t1 <= MIN_GAP_T && t2 >= 1 - MIN_GAP_T
        ? new Bezier(curve.points)
        : curve.split(t1, t2);
    piece._t1 = t1;
    piece._t2 = t2;
    return piece;
}
