/**
 * The boot flow has no user in front of it: if its `startNewGame` rejects there
 * is no previous puzzle to fall back to and no dialog to retry from, so the
 * session installs nothing and the player faces an empty canvas with nothing
 * said about why (#488). This runs the preferred start, reports a failure, then
 * starts a last-resort puzzle that can't depend on the lazy chunk.
 *
 * Not covered: the fallback keeps the failed attempt's grid size and
 * image-source preferences, so a failure rooted in those inputs repeats against
 * `startFallback` and ends at `BOOT_FAILED_TOAST`. This is a different-generator
 * fallback, not a retry-with-different-inputs one.
 */

import type { CutStyle } from '../game/cut-styles.js';
import { runWithErrorReport } from './run-with-error-report.js';
import { showToast } from '../ui/index.js';

/**
 * The cut style the boot fallback is forced to. Exported so `startNewGame`
 * and this module's failure attribution name the same style, without a second
 * literal to keep in step.
 */
export const BOOT_FALLBACK_CUT_STYLE: CutStyle = 'classic';

export const FALLBACK_STARTED_TOAST = "Couldn't start your usual puzzle — started a Classic one";

export const BOOT_FAILED_TOAST = "Couldn't start a puzzle — try reloading";

export async function startWithBootFallback(opts: {
    start: () => Promise<void>;
    /**
     * Cut style `start` is attempting, for failure attribution. The
     * fallback's own failure reports {@link BOOT_FALLBACK_CUT_STYLE}
     * instead — it never generates the requested style.
     */
    cutStyle: string;
    /** Start the last-resort puzzle: legacy Classic, no lazy chunk. */
    startFallback: () => Promise<void>;
    /**
     * Whether a puzzle actually made it onto the screen — rendered and
     * interactive, not merely "state assigned somewhere". An over-optimistic
     * answer skips both the substitution and every message — the dead-and-silent
     * app #488 is about.
     */
    hasGame: () => boolean;
}): Promise<void> {
    const started = await runWithErrorReport({
        run: async () => {
            await opts.start();
            return true;
        },
        warnMessage: 'Failed to start the boot puzzle:',
        // Before this branch a boot rejection reached the browser as an
        // unhandled rejection and printed in production. Catching it here must
        // not regress that, so this flow opts into production logging where the
        // dialog/share-link flows stay silent.
        logInProduction: true,
        event: 'new-game-failed',
        cutStyle: opts.cutStyle,
        phase: 'boot',
        // No toast: the player's message depends on whether recovery works, and
        // only one toast renders at a time.
        fallback: false,
    });
    if (started) return;

    // A rejection *after* the game was installed leaves the player with the
    // puzzle they asked for; replacing it with a Classic one would be the
    // regression. The failure is still reported above.
    if (opts.hasGame()) return;

    const recovered = await runWithErrorReport({
        run: async () => {
            await opts.startFallback();
            return true;
        },
        warnMessage: 'Boot fallback puzzle also failed to start:',
        // Same as the preferred start: the last catch before the app is stuck,
        // so it must stay visible in a production console.
        logInProduction: true,
        event: 'new-game-failed',
        cutStyle: BOOT_FALLBACK_CUT_STYLE,
        phase: 'boot-fallback',
        // No toast here either: this function owns every message, so all three
        // live in the one block below.
        fallback: false,
    });

    // After the fallback settles: the player reads "started a Classic one" only
    // once true. `hasGame()` was false above, so anything on screen now came
    // from the fallback — which can reject after rendering, and "try reloading"
    // over a working puzzle would be wrong and destructive.
    if (recovered || opts.hasGame()) {
        showToast(FALLBACK_STARTED_TOAST);
        return;
    }
    showToast(BOOT_FAILED_TOAST);
}
