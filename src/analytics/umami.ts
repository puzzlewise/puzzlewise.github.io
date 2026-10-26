/**
 * Umami analytics wrapper.
 *
 * Injects the Umami tracking script at startup (when configured) and
 * exposes a typed `track()` function for custom events. Nothing is sent
 * when:
 * - `VITE_UMAMI_WEBSITE_ID` is unset (e.g. localhost), or
 * - the Umami script hasn't loaded / has been blocked by an ad-blocker.
 *
 * Event schema lives here as the single source of truth.
 */

import type { Orientation } from '../model/types.js';
import type { OfflineDownloadReason } from '../images/offline-stash.js';
import type { MoveFailureReason } from '../move/move-protocol.js';
import { resolveDistinctId } from './distinct-id.js';

declare global {
    interface Window {
        umami?: {
            track: (eventName: string, eventData?: Record<string, unknown>) => void;
        };
    }
}

const DEFAULT_SCRIPT_URL = 'https://cloud.umami.is/script.js';

/**
 * Data attached to `new-game-started`.
 *
 * `source` records how the puzzle started (fresh new-game vs. opening a
 * shared link). The image-related fields and the share-recipient fields
 * are conditionally populated — see the spec for details.
 *
 * `'shared'` also covers a `__reproPuzzle` console replay, which runs the
 * same `loadSharedPuzzle` path, and `'fresh'` likewise covers a dev-console
 * start (`__newComposableGame`). This event does not separate either from a
 * real player; {@link SharedLoadFailedData} and
 * {@link PieceCountMismatchData} both do, via their own `source`. Two
 * consequences, both dev-console volume and both accepted: a share-link
 * success rate computed from `new-game-started[source=shared]` against
 * `shared-load-failed[source=shared]` has dev-console traffic in the
 * numerator only and reads slightly high; and a piece-count mismatch RATE has
 * no matching denominator here, because a dev-console start lands in
 * `new-game-started[source=fresh]` while its mismatch lands in
 * `piece-count-mismatch[source=dev]`. Count mismatches, don't rate them.
 *
 * That share-link success-rate query also has a third outcome neither term
 * counts, since #489: a shared load the recipient cancels from the loading
 * overlay emits `generation-canceled[source=shared]` and neither of the two
 * events above. Add it to the denominator (or exclude it explicitly) rather
 * than assuming started + failed covers every attempt. Bounded — Cancel is
 * only offered when a puzzle is already installed, so a first-visit
 * recipient cannot produce one.
 */
export interface NewGameData {
    source: 'fresh' | 'shared';
    cutStyle: string;
    /**
     * Trace-set version backing a puzzle's traced tabs, read off the
     * per-style config the puzzle was generated with. Present for traced-tab
     * Wavy games, Triangles games, and sine-based Classic games; omitted for
     * Fractal, Composable, legacy (classic-tab) Wavy links, pre-upgrade
     * Classic links/saves, Classic games degraded to the legacy generator by
     * a failed chunk fetch (see `tracedChunkDegraded`), boot-fallback games
     * (see `bootFallback`), and any link whose
     * per-style config the decoder dropped as invalid — a `tf`-less Triangles
     * link still generates with traced tabs, but at a version substituted
     * during generation that the state never records. Lets analytics follow
     * trace-set versions once a v2 ships.
     *
     * For `cutStyle: 'classic'` it carries a SECOND meaning: presence is the
     * generator discriminator (sine + traced tabs vs. the legacy
     * straight-grid generator), so `cutStyle === 'classic'` + absent
     * `traceSetVersion` approximates the pre-upgrade tail. Consequence for
     * queries: "has traceSetVersion" is no longer a proxy for
     * "Wavy/Triangles" — filter on `cutStyle` explicitly.
     *
     * Three confounds sit in that bucket, all separable:
     * - degraded new games (a failed chunk fetch) land in it — exclude
     *   `tracedChunkDegraded`;
     * - boot-fallback games (#488) land in it too, with no chunk failure of
     *   their own — exclude `bootFallback`;
     * - during a rollout window, clients still on the pre-upgrade build
     *   (PWA caches especially) start Classic games without the field too.
     *   Those are `source: 'fresh'`; a genuine pre-upgrade Classic *link*
     *   arrives as `source: 'shared'`.
     *
     * So the query on `new-game-started` is: `cutStyle: 'classic'`, no
     * `traceSetVersion`, neither `tracedChunkDegraded` nor `bootFallback` —
     * then split on `source`. None of the three exclusions is a negated
     * filter; all are subtractions, the same absence arithmetic
     * {@link SharedLoadFailedData}'s `source` documents: `traceSetVersion`
     * is omitted rather than null here and the two flags are absent rather
     * than `false` (each flag's own doc gives the reason), so a negated
     * property filter joins on the key and matches only the rows that carry
     * the property, never the ones that lack it.
     * Both halves count the same one thing: a Classic game that rendered
     * legacy geometry. `'fresh'` is the stale-build population and falls to
     * zero as the fleet turns over. `'shared'` is the link tail, and it is
     * not only pre-upgrade links — anything that reaches a recipient without
     * a usable `clf` lands here too. While the rollout lasts that includes
     * stale builds opening a *new* link: `isValidPayload` checks known fields
     * only, so an unknown `clf` passes validation and is then ignored.
     * Permanently, it includes links shared from a game that had no sine
     * config of its own to pass on (a degraded start, a resumed pre-upgrade
     * save, a boot-fallback game). That last one is not excludable
     * recipient-side the way a boot fallback's own start is: `bootFallback`
     * rides on the originator's `new-game-started` only, and nothing about
     * it is encoded in the link. All of them genuinely ran the legacy
     * generator, so every extra population inflates the tail in the safe
     * direction — toward keeping that generator, never toward retiring it
     * early.
     */
    traceSetVersion?: number;
    /**
     * True when a new Classic game fell back to the legacy straight-grid
     * generator because the traced-tab chunk failed to load. Only ever set
     * for fresh Classic games — every other style fails the start outright,
     * and the shared-link path never degrades. Absent otherwise, so on
     * `new-game-started` the degraded volume is a single filter and can be
     * subtracted from the "Classic without traceSetVersion" bucket above.
     *
     * A boot fallback sets `bootFallback` instead — it never attempts the
     * fetch, so there is no failure to record.
     */
    tracedChunkDegraded?: boolean;
    /**
     * True when the boot path's preferred start failed and the app
     * recovered by starting a last-resort puzzle instead (#488): legacy
     * Classic cut, lazy chunk never fetched, every other preference kept.
     * The player's cut-style preference is untouched, so this is a
     * per-boot recovery and not a permanent switch — the next New Game
     * offers their style again.
     *
     * Never set on the dialog path: there a rejection leaves the previous
     * puzzle on screen and the player retries, so there is nothing to
     * substitute. The matching `new-game-failed { phase: 'boot' }` carries
     * why the preferred start failed. That event has three possible
     * outcomes, not one: recovery succeeded (this flag follows), recovery
     * was attempted and also failed (a second `new-game-failed
     * { phase: 'boot-fallback' }` follows), or recovery was skipped because
     * a puzzle had already reached the screen before the failure (nothing
     * follows at all — see `phase`'s doc).
     *
     * Nor is the flag a clean stand-in for outcome 1 even when recovery
     * did work: it rides on `new-game-started`, which the fallback tracks
     * last, after its puzzle has rendered and persisted. A fallback that
     * throws in that tail emits the `phase: 'boot-fallback'` event with no
     * flag behind it, yet leaves the player a playable puzzle — the same
     * rare case `phase`'s doc bounds from the other side. So flag-absence
     * does not imply recovery failed. Don't treat this flag's count as the
     * numerator over `new-game-failed[phase='boot']`'s count for a recovery
     * rate: the skipped-recovery outcome and that tail both deflate it.
     *
     * Like `tracedChunkDegraded`, these games ran legacy geometry with no
     * `traceSetVersion`, so they have to come out of the pre-upgrade-tail
     * query described above — by subtracting this flag's own count, not by
     * negating a filter: the flag is absent rather than `false` when it
     * doesn't apply, so `bootFallback = true` is the only filter that
     * expresses it. The two flags never co-occur (a boot fallback never
     * starts the chunk fetch, so it cannot also be degraded), so
     * subtracting both double-counts nothing. Unlike `tracedChunkDegraded`,
     * the cause need not be the chunk at all — a saved config the build
     * cannot generate lands here too.
     */
    bootFallback?: boolean;
    rotationMode: 'none' | 'quarter-turn' | 'free';
    /**
     * Puzzle orientation. Derivable from `rows > cols` (both paths store the
     * post-transpose grid), but broken out as a first-class low-cardinality
     * dimension so portrait adoption — the point of this feature — is a plain
     * segment filter in the dashboard rather than a computed comparison.
     */
    orientation: Orientation;
    cols: number;
    rows: number;
    pieceCount: number;
    /**
     * How the puzzle's image was actually obtained, classified from the
     * achieved image URL rather than from what was requested. A rate-limited
     * fetch the backup pool covers reports `unsplash` (the pool serves an
     * `images.unsplash.com` URL) and is counted by `image-pool-fallback`, and
     * an offline or pool-miss start the offline stash covers likewise reports
     * `unsplash` and is counted by `image-stash-fallback`; only a start no
     * source covered — offline or pool-miss with an empty stash, or no proxy
     * — reports `bundled`. The one
     * exception is `first-run`, honored as a request sentinel because that
     * puzzle legitimately uses the bundled image and would otherwise be
     * indistinguishable from a failure (`resolveNewGameImageSource`).
     *
     * That exception is what makes the bundled:unsplash ratio the health check
     * for the offline/pool-miss image path — pool-covered rate-limits report
     * `unsplash` and go to `image-pool-fallback`, not this ratio.
     * **Filter to `source = 'fresh'` first:** shared games set this
     * field too, from the URL the payload already carries, and no proxy call
     * happens there — leaving them in makes the ratio drift with sharing
     * volume rather than with proxy health. Resumed saves need no exclusion:
     * they emit no `new-game-started` at all.
     *
     * Within that filter every `bundled` is a fallback — a fresh start with a
     * real photo request never lands there otherwise — so a jump is the alert.
     */
    imageSource?: string;
    imageCategory?: string;
    vibrant?: boolean;
    /**
     * Fresh unsplash games only: true when the player tapped a specific
     * candidate thumbnail, false for "Surprise me". Measures picker
     * adoption. Absent for shared games and non-photo sources.
     */
    imagePicked?: boolean;
    includesProgress?: boolean;
    recipientHadSavedState?: boolean;
    /**
     * Share-link background color outcome: 'adopted' (recipient had no
     * color preference; the link's color was applied and saved),
     * 'kept-own' (link carried a color, recipient has their own),
     * 'invalid' (link carried a `bgc` that isn't a valid palette id —
     * e.g. palette drift dropped a once-live color), or 'none' (link
     * predates the feature and carried no `bgc` at all). Only present
     * when source === 'shared'.
     */
    sharedColor?: 'adopted' | 'kept-own' | 'invalid' | 'none';
    /**
     * How the generate phase ran: `'worker'` = off the main thread in the
     * generation Web Worker (the normal path since #489), `'sync-fallback'`
     * = synchronously on the main thread because the worker path was
     * unavailable or failed (see `generationFallbackReason`). A `'no-worker'`
     * fallback froze the main thread for ~`generationMs`; a fallback that
     * followed a worker failure froze it for less than that, since part of
     * `generationMs` there is the failed (non-blocking) worker attempt —
     * see `generationMs`'s own doc. Worker games did not freeze it at all.
     * Present on every `new-game-started` from the off-thread release on;
     * absent on events from older clients (PWA caches).
     *
     * Averaging `generationMs` over `puzzle-completed` measures a
     * completion-survivorship-biased subset; `new-game-started` is the
     * unbiased denominator.
     */
    generationMode: 'worker' | 'sync-fallback';
    /**
     * Wall-clock milliseconds the generate phase took (rounded), measured
     * on the main thread around the whole off-thread round trip — worker
     * spawn, traced-chunk load inside the worker where needed, generation,
     * and result transfer — or around the synchronous call on the fallback
     * path. This is the wait a player actually experienced under the
     * loading overlay for the generation step (image fetch excluded).
     *
     * A `sync-fallback` that followed a worker failure (`generationFallbackKind`
     * other than `'no-worker'`) is not a sync-only measurement: the timer
     * starts before the worker is even spawned, so it spans the failed
     * worker round trip PLUS the synchronous rerun that followed it, not the
     * rerun alone. Only that rerun actually blocks the main thread, so on
     * this path `generationMs` overstates the freeze the player sat through
     * (though not the player's total wait, which is the whole span).
     */
    generationMs: number;
    /**
     * Which class of worker-path failure sent generation to the main
     * thread. Only present when `generationMode` is `'sync-fallback'`.
     * Low-cardinality, so it is the field to segment on; the free-text
     * `generationFallbackReason` beside it is for reading individual
     * cases. Same split, and the same reason, as
     * {@link TracedChunkLoadFailedData}'s `kind` / `reason` pair.
     *
     *  - `'no-worker'` — no `Worker` constructor in this environment.
     *  - `'spawn-failed'` — `new Worker(...)` or the request `postMessage`
     *    threw synchronously (e.g. a `DataCloneError`).
     *  - `'worker-error'` — the worker fired `error`. Per the HTML spec a
     *    worker whose script fails to fetch fires a plain `Event` with no
     *    `message`, so worker-chunk-missing-from-precache, a CSP-blocked
     *    worker and a build without module-worker support all land here
     *    with an unhelpful `generationFallbackReason`. That is exactly
     *    why this field exists — but it does not separate them from each
     *    other either; nothing in the browser does.
     *  - `'message-error'` — the response could not be used: it failed to
     *    deserialize, or reading the delivered payload threw.
     *  - `'worker-infrastructure'` — the worker reported a failure of its
     *    own plumbing: a traced-chunk fetch that failed (or a chunk never
     *    loaded) inside the worker, or a reply that could not be posted.
     *    The worker-side copy of the chunk emits no `traced-chunk-*`
     *    events, so this bucket is where those failures surface.
     *
     * A worker-side generation error is deliberately NOT in this list: it
     * is deterministic, so it is rethrown rather than retried, and lands
     * as `new-game-failed` / `shared-load-failed` instead.
     */
    generationFallbackKind?:
        | 'no-worker'
        | 'spawn-failed'
        | 'worker-error'
        | 'message-error'
        | 'worker-infrastructure';
    /**
     * Why generation fell back to the main thread, as free text: the
     * literal `'no-worker'`, or a sanitized worker-path error rendered as
     * `'<ErrorName>: <message>'` whenever the thrown value carried a name
     * other than the default `'Error'`, and as the bare message otherwise.
     * So group with a prefix match rather than equality, and expect the
     * prefix unevenly across kinds: `'worker-infrastructure'` and
     * `'spawn-failed'` rows usually carry one (`'TypeError: …'`,
     * `'DataCloneError: …'`), while the strings synthesized here rather
     * than thrown never do — every `'worker-error'` row, and the
     * `'message-error'` rows that come from a failed deserialization
     * (the ones from a throw while reading the payload do carry it).
     *
     * Only present when `generationMode` is `'sync-fallback'`. Pair it
     * with `generationFallbackKind` above, which buckets the same
     * outcomes — filter on the kind, read this for the detail.
     */
    generationFallbackReason?: string;
}

/**
 * Data attached to `puzzle-completed`.
 *
 * Same field names as `NewGameData`. The game's own `new-game-started`
 * payload, where available, is merged over the fields derived from the game
 * state (the puzzle-shape core, `imageSource`, `traceSetVersion`). A
 * `resumed` completion has that payload only for games started on a build
 * from #601 on whose stored copy survived. The resumed completions without
 * it — older saves, plus a small permanent remainder of lost copies — are
 * `resumed = true` minus `resumed = true` with any `source`: a subtraction,
 * because a negated filter matches only rows that carry the property.
 */
export type PuzzleCompletedData = Pick<
    NewGameData,
    'cutStyle' | 'rotationMode' | 'cols' | 'rows' | 'pieceCount'
> &
    Partial<NewGameData> & {
        /**
         * True when the game was restored from the save at boot, false when
         * it was started — fresh or from a link — in the page load that
         * completed it.
         */
        resumed: boolean;
        /**
         * Wall-clock ms from the puzzle's install to its completion, time in
         * the background or with the app closed included. Absent when the
         * start is unknown (games started before #602, a lost stored context,
         * a clock set back since) and on events from older clients (PWA
         * caches).
         */
        elapsedMs?: number;
        /** `elapsedMs` in whole 24-hour periods; absent along with it. */
        daysSinceStart?: number;
    };

/**
 * The game a `new-game-started` replaced, so each start doubles as the
 * abandonment record of the one before it. Absent when no game was replaced,
 * and on events from older clients (PWA caches). A filter can't match an
 * absent property, so count starts that replaced nothing as all starts minus
 * those with any `replacedCompleted`; older clients' starts inflate that count.
 */
export interface ReplacedGameData {
    /** Share of the merges done, 0 to 1, including the sharer's for a link shared with progress. */
    replacedProgress: number;
    /**
     * Also true after a Debug Solve, which sends `puzzle-solved`, not
     * `puzzle-completed`. A solve isn't saved by itself, so a reload can undo
     * it: one game can then send `puzzle-solved` more than once, or
     * `puzzle-completed` as well.
     */
    replacedCompleted: boolean;
    replacedPieceCount: number;
    replacedCutStyle: string;
    /** Wall-clock ms since that game started; absent when unknown, as `elapsedMs` is. */
    replacedElapsedMs?: number;
}

/** Data attached to `new-game-started`. */
export type NewGameStartedData = NewGameData & Partial<ReplacedGameData>;

/**
 * Data attached to `puzzle-solved`, sent instead of `puzzle-completed` when
 * the Debug Solve finishes an unfinished puzzle. Players can use it to give
 * up, so the fields describe the puzzle as it stood before the solve.
 */
export interface PuzzleSolvedData {
    /** Share of the merges done, 0 to 1, including the sharer's for a link shared with progress. */
    progress: number;
    pieceCount: number;
    cutStyle: string;
    /** Wall-clock ms since the puzzle started; absent when unknown, as `elapsedMs` on `puzzle-completed` is. */
    elapsedMs?: number;
}

/** Data attached to `puzzle-shared`. */
export interface PuzzleSharedData {
    source: 'completion-overlay' | 'info-modal';
    includesProgress: boolean;
}

/** Data attached to `background-color-changed`. */
export interface BackgroundColorChangedData {
    /** Swatch id before the switch. */
    from: string;
    /** Swatch id after the switch. */
    to: string;
}

export type InfoModalOpenedData = Record<string, never>;

/**
 * Not sent when the page unloads or the app is killed with the modal open,
 * so `info-modal-opened` minus this counts those.
 *
 * `seenPercent` (0–100) is how far down the content was on screen at some
 * point, as a share of its height: the share visible on open if never
 * scrolled, 100 once the bottom was reached. An expanded Debug section
 * counts toward the height from then on.
 */
export interface InfoModalClosedData {
    closedBy: 'button' | 'backdrop' | 'escape' | 'solve';
    /** Wall-clock, background time included. */
    openMs: number;
    seenPercent: number;
    scrolled: boolean;
    debugOpened: boolean;
}

export type SettingChangedData =
    | { setting: 'snap-distance' | 'piece-outline' | 'outline-color'; from: string; to: string }
    | { setting: 'offset-drag' | 'enclose-to-select'; from: boolean; to: boolean };

/**
 * Data attached to `traced-chunk-preload-started`.
 *
 * Fired once per real import attempt (cached-promise calls don't
 * re-emit), so it's the denominator for the loaded/failed funnel and
 * makes abandonment observable — a started event with no matching
 * settle means the user left mid-fetch. `attempt` matches the counter
 * on the settling event.
 *
 * Counts only the main thread's chunk: the generation worker has its own
 * copy (a separate Rollup graph, `generation-worker-core.ts`) and never
 * emits this family, so a worker-side fetch/failure is invisible here. To
 * count those, filter `new-game-started` on
 * `generationFallbackKind = 'worker-infrastructure'`; the accompanying
 * `generationFallbackReason` carries the message.
 */
export interface TracedChunkPreloadStartedData {
    attempt: number;
}

/**
 * Data attached to `traced-chunk-loaded`.
 *
 * `durationMs` is the wall-clock time between the initiating call that
 * started the in-flight import (not necessarily the very first call —
 * the cache resets per attempt after a failure) and the import
 * settling, i.e. real-user preload latency. Rounded to 0.1 ms so warm
 * sub-millisecond hits don't all collapse to `0`.
 *
 * `cacheState` separates the latency populations so the metric isn't an
 * average across them: `cold` (full network fetch), `warm` (served from
 * cache, no network), and `revalidated` (a 304 round trip — headers
 * only, body from cache). Derived from the chunk's Resource Timing
 * entry; `'unknown'` when no usable entry is available (API absent or
 * the entry was evicted from a full buffer — the two aren't separable).
 *
 * `attempt` is the 1-based attempt counter for this client session, so
 * a retry after a failure is distinguishable from an unrelated cold
 * load.
 *
 * Main-thread-only, like every `traced-chunk-*` event — see
 * `TracedChunkPreloadStartedData`.
 */
export interface TracedChunkLoadedData {
    durationMs: number;
    cacheState: 'cold' | 'warm' | 'revalidated' | 'unknown';
    attempt: number;
}

/**
 * Data attached to `traced-chunk-load-failed`.
 *
 * `reason` is the rejection's message with URLs and extension origins
 * redacted (so per-deploy chunk hashes and ad-blocker extension IDs
 * don't ship to analytics) and truncated to a bounded length; empty
 * messages fall back to `'unknown'`.
 *
 * `kind` buckets the failure (network / parse / unknown) so events
 * aggregate cleanly in Umami despite the raw `reason` being
 * high-cardinality.
 *
 * `attempt` is the 1-based attempt counter for this client session.
 *
 * Main-thread-only, like every `traced-chunk-*` event — see
 * `TracedChunkPreloadStartedData`. A worker-side chunk failure is not here:
 * it lands on `new-game-started` as
 * `generationFallbackKind = 'worker-infrastructure'`, with the message in
 * `generationFallbackReason`.
 */
export interface TracedChunkLoadFailedData {
    reason: string;
    kind: 'network' | 'parse' | 'unknown';
    attempt: number;
}

/**
 * Data attached to `unhandled-error` — the app-wide backstop for async
 * failures that no local `try/catch` handled.
 *
 * `source` is the channel that caught it. The page realm reports a rejected
 * promise (`'rejection'`) or a thrown exception (`'error'`); the
 * service-worker backstop reports the same two channels from inside the
 * worker scope as `'sw-rejection'` / `'sw-error'`, so an operator can tell a
 * worker-scope failure from a page-scope one. (Named `source`, not `kind`, to
 * avoid colliding with the failure-class `kind` on
 * {@link TracedChunkLoadFailedData} — the two carry different semantics.)
 *
 * `name` is the low-cardinality bucket for aggregation/alerting: an
 * `Error`'s `name` (`TypeError`, `SecurityError`, …), or for any other value
 * its `valueType` as {@link PwaRegisterFailedData} defines it (`string`,
 * `undefined`, `Object`, …). An `error`-channel event that carried no error
 * object reports `'null'`. Rows from builds before #597 carry `'unknown'` for
 * every non-`Error` value instead.
 *
 * `reason` is the sanitized message (URLs/extension origins redacted,
 * empty falls back to `'unknown'`, length-capped); see
 * {@link import('./sanitize-error-reason.js').sanitizeErrorReason}.
 *
 * Coverage caveat for the `sw-*` sources: the worker backstop only sees
 * synchronous throws and unhandled promise rejections in the worker scope.
 * It does NOT capture `FetchEvent.respondWith` / `waitUntil`
 * failures (those surface as the event's own failure, not a global error),
 * and a report is dropped when no window client is open to relay it. So
 * absence of `sw-rejection`/`sw-error` events is not proof the worker is
 * healthy. See `pwa/sw.ts` for the full rationale.
 */
export interface UnhandledErrorData {
    source: 'rejection' | 'error' | 'sw-rejection' | 'sw-error';
    name: string;
    reason: string;
}

/**
 * Data attached to `csp-violation` — the browser refused to load something
 * under `index.html`'s Content-Security-Policy.
 *
 * The policy is `img-src` only, so in practice this fires for a blocked
 * image. It exists because a wrong `img-src` is otherwise **invisible**: the
 * SVG `<image>` the puzzle renders through carries no `error` handler, and
 * `initErrorTracking`'s `error` listener deliberately omits the capture
 * phase, so a blocked image produces transparent pieces while
 * `new-game-started` still reports a healthy `imageSource`. Nothing else in
 * the app would notice.
 *
 * The failure this is for is drift the repo cannot see: the policy names
 * `https://*.unsplash.com`, so an Unsplash CDN move to another domain blocks
 * every puzzle image with `index.html` unchanged. `src/index-html.test.ts`
 * pins the tag against *edits*; only this event covers the outside world
 * changing under it.
 *
 * So the alert is on the event existing at all: any sustained non-zero rate
 * of `csp-violation` means images are failing to load for real players.
 * Split on `blockedUri` to tell an Unsplash CDN change (a single new host,
 * all sessions) from a crafted share link (scattered one-off hosts, one
 * session each) — the latter is the policy working as designed and is
 * expected to be rare but non-zero.
 *
 * `directive` is the violated directive (`effectiveDirective`), so the event
 * stays meaningful if the policy ever grows past `img-src`.
 *
 * `blockedUri` is NOT a full URL, by specification rather than by our
 * redaction: browsers report the literal `'data'` for a `data:` URL and strip
 * a cross-origin URL to scheme/host/port. That is what makes it safe to send
 * — it can carry neither a full image URL nor an Unsplash photo ID, which is
 * the rule {@link PieceCountMismatchData} states for image URLs.
 * Do not write queries expecting a path or query string.
 *
 * Shares `initErrorTracking`'s per-session rate limiter with
 * `unhandled-error`, so a page that violates the policy once per piece
 * reports a bounded number of events — and a flood of violations consumes
 * the same budget uncaught exceptions draw on. Counts are therefore a
 * floor, not a total; treat a rate-limited session as one signal, not as a
 * measurement of how many images were blocked.
 */
export interface CspViolationData {
    directive: string;
    blockedUri: string;
}

/**
 * Data attached to `shared-load-failed` — a puzzle payload satisfied
 * surface-shape validation but failed while building the puzzle (e.g. a
 * config combination the current build's topology pipeline doesn't support).
 *
 * `reason` is the sanitized error message, and as of the generation worker it
 * has two shapes for one underlying bug: a generation failure raised inside
 * the worker arrives as `'<ErrorName>: <message>'` — the worker-side type is
 * folded into the message, the only field `sanitizeErrorReason` reads —
 * while every other producer arrives bare, including the synchronous fallback
 * running the SAME failing generation for a client with no usable Worker. The
 * two never compare equal, so a per-bug figure has to tolerate the optional
 * prefix; note also that the length cap applies after it is composed, so a
 * long message truncates slightly earlier in the prefixed form. A worker-side
 * name of the default `'Error'` is dropped rather than prefixed, as
 * `generationFallbackReason` above describes.
 *
 * `source` separates the two producers, whose base rates differ sharply.
 * `'shared'` is a real recipient opening a `#p=` link and seeing a
 * "Couldn't load shared puzzle" toast — the signal that watches for
 * share-format regressions. `'repro'` is a developer replaying an info-modal
 * repro block through `__reproPuzzle` in the console, where a generation
 * failure is often the very thing being investigated, so it is an expected
 * outcome rather than user-facing breakage. Without the discriminator the
 * two are indistinguishable, since the differing warn/toast messages never
 * reach analytics. (Named `source` to match {@link ShareFailedData} and
 * {@link UnhandledErrorData}.)
 *
 * Read an ABSENT `source` as `'shared'`: every row predating the
 * discriminator is a real share link, and during the rollout window
 * PWA-cached clients on the previous build keep emitting source-less real
 * failures (the same stale-client confound the `traceSetVersion` note above
 * describes). No property filter can express that, negated or not: event
 * properties are key/value rows, so `source != 'repro'` still joins on the
 * key and matches exactly the rows `source = 'shared'` does. The
 * share-format signal is arithmetic — total `shared-load-failed` minus
 * `source = 'repro'`.
 */
export interface SharedLoadFailedData {
    reason: string;
    source: 'shared' | 'repro';
}

/**
 * Data attached to `image-fetch-failed` — fetching a random Unsplash image
 * threw (network/parse failure). This is NOT the "no image found" case:
 * `fetchRandomImage` returns `undefined` on a 4xx/5xx response, which is
 * `image-fetch-http-error`'s case ({@link ImageFetchHttpErrorData}), so this
 * event only fires on a genuine throw. The new game still proceeds with the
 * fallback image. `reason` is the sanitized error message.
 *
 * `orientation` and `imageCategory` describe the request that failed, so a
 * portrait-specific or category-specific fetch problem is distinguishable
 * from a generic one rather than being aggregated away.
 *
 * Since #535 the request goes to the image-proxy Worker, not to Unsplash, so
 * a spike here points at Cloudflare — an unreachable Worker, a stale
 * `VITE_IMAGE_PROXY_URL`, or an origin missing from its CORS allowlist — at
 * least as often as it points at Unsplash itself.
 */
export interface ImageFetchFailedData {
    reason: string;
    orientation: Orientation;
    imageCategory: string;
}

/**
 * Data attached to `image-fetch-http-error` — the image proxy answered a
 * random-photo request with an error status (#533). `status = 403` is
 * Unsplash's rate limit: a 50-requests/hour demo-tier budget shared by
 * every player, so one hot hour blanks the picker for everyone. Keep both
 * fields mandatory — rows that all carry the keys never need the
 * absent-property arithmetic {@link SharedLoadFailedData} documents.
 */
export interface ImageFetchHttpErrorData {
    status: number;
    source: 'single' | 'batch';
}

/**
 * Data attached to `image-pool-fallback` — a single random-photo request
 * produced no usable photo and the app served a backup-pool image instead of
 * calling Unsplash. `cause` says why: `'http-error'` is a proxy refusal (the
 * `image-fetch-http-error` tier, `source:'single'`: the network is up but the
 * API said no — those rows correlate with an http-error event); `'blocked'`
 * means both draws landed on a blocked photographer (#568) with every
 * response ok, so no http-error row accompanies it. Batch/picker errors
 * never fall back. `hit` is false when the matching bucket was empty and the
 * app dropped to the single offline image; those rows isolate a category
 * whose pool needs refilling.
 */
export interface ImagePoolFallbackData {
    imageCategory: string;
    orientation: Orientation;
    vibrant: boolean;
    hit: boolean;
    /**
     * Absent on rows predating the blocklist, so split by key presence, not
     * subtraction (same arithmetic {@link SharedLoadFailedData} documents).
     */
    cause: 'http-error' | 'blocked';
}

/**
 * Data attached to `image-stash-fallback` — every network image source had
 * failed and the app consulted the player's offline stash. `cause` says which
 * path led here: `'fetch-failed'` is a thrown fetch (the offline case) — the
 * resolve path pairs it with an `image-fetch-failed` row, the picker path
 * emits none; `'pool-miss'` follows an `image-pool-fallback` row with
 * `hit: false`; `'no-candidates'` is the picker's batch fetch returning empty
 * without throwing (that path consults no pool, so no pool row accompanies
 * it). `hit: false` means no usable stashed image was present — an empty
 * stash, or one whose cached blobs the browser had evicted out from under the
 * surviving metadata — so it counts players who hit a dead image path with
 * nothing to fall back on.
 */
export interface ImageStashFallbackData {
    imageCategory: string;
    orientation: Orientation;
    vibrant: boolean;
    hit: boolean;
    cause: 'fetch-failed' | 'pool-miss' | 'no-candidates';
}

/**
 * Data attached to `offline-images-saved` — the New Game dialog's
 * offline-download attempt settled. `saved: 0` is failure, with the previous
 * stash left in place, and `reason` discriminates the ~five causes so a spike
 * separates a benign offline tap from a real client fault (see
 * {@link OfflineDownloadReason}); `reason: 'saved'` accompanies any `saved > 0`
 * row. `requested` is the batch size asked of Unsplash; blocked-photographer
 * filtering and per-photo download failures account for any shortfall.
 */
export interface OfflineImagesSavedData {
    requested: number;
    saved: number;
    reason: OfflineDownloadReason;
    imageCategory: string;
    orientation: Orientation;
    vibrant: boolean;
}

/**
 * Data attached to `new-game-failed` — starting a fresh puzzle rejected. The
 * most likely cause (the traced-tab lazy chunk import) ALSO emits
 * `traced-chunk-load-failed` one layer down, so a single failure can produce
 * both events; there is no guaranteed 1-to-1 correlation (topology and other
 * errors reach this catch without a chunk event). This event captures the
 * outcome that the inner event does not. `reason` is the sanitized error
 * message, in the same two shapes {@link SharedLoadFailedData}'s `reason`
 * describes: a worker-path generation failure usually carries an
 * `'<ErrorName>: '` prefix, every other producer never does.
 *
 * What the player saw depends on `phase`, and only the dialog path shows the
 * "Couldn't start new game" toast this event used to be synonymous with. A
 * `phase: 'boot'` event shows nothing at all — the boot path stays quiet
 * until its recovery attempt has settled — and its most common visible
 * outcome is a substitution notice over a working puzzle. So a pre-existing
 * `count(new-game-failed)` dashboard stopped counting user-facing new-game
 * failures when #488 landed: it now also counts boot failures that mostly
 * ended in a playable puzzle.
 *
 * Recovering the old metric — or any dialog-path-only figure — is
 * arithmetic, not a filter. Same absence problem {@link SharedLoadFailedData}'s
 * `source` has, for the same reason: event properties are key/value rows, so
 * `phase != 'boot'` still joins on the key and matches only rows that HAVE a
 * `phase`. Dialog-path failures are total `new-game-failed` minus
 * `phase = 'boot'` minus `phase = 'boot-fallback'`.
 */
export interface NewGameFailedData {
    reason: string;
    /**
     * Cut style the failed attempt asked for — the same attribution
     * {@link SaveFailedData}, {@link SaveCompressedData} and
     * {@link ProgressSaveSkippedData} carry, for the same stated reason:
     * without it a failure arrives as an unattributable count. (The
     * principle is {@link ImageFetchFailedData}'s too, but with the
     * dimensions that matter there — it carries `orientation` and
     * `imageCategory`, not a cut style.)
     * It is what makes the #488 question answerable at all, namely
     * whether a Wavy or Triangles preference is what dead-ends a boot. The
     * recovered `new-game-started` cannot answer it — that one reports
     * `'classic'`, the style the fallback substituted.
     *
     * The *requested* style, so on `phase: 'boot-fallback'` it is always
     * `'classic'`: the fallback's own forced cut, not the preference that
     * failed. The preference is on the paired `phase: 'boot'` event.
     *
     * Absent on rows recorded before the field existed.
     */
    cutStyle: string;
    /**
     * Which start attempt failed. Absent on the new-game dialog path,
     * where a rejection leaves the previous puzzle on screen and the
     * player can simply retry — so absence is also every event recorded
     * before this field existed.
     *
     * `'boot'` is the boot path's preferred start, the failure that used
     * to leave a dead app (#488); `'boot-fallback'` is the last-resort
     * Classic puzzle that recovers from it failing too. A `phase: 'boot'`
     * event has three possible follow-ups, not a guaranteed one: a
     * `bootFallback` game (recovery succeeded, see its doc above), a
     * `phase: 'boot-fallback'` event (recovery attempted and also failed —
     * that pair is one incident, not two), or nothing at all (recovery
     * skipped because a puzzle had already reached the screen before the
     * failure). Reading "no boot-fallback event" as "it recovered" collapses
     * the last two cases, which are opposites.
     *
     * Nor is a `'boot-fallback'` event quite "the player was left with
     * nothing": the fallback runs the same setup the preferred start does,
     * so it can reject *after* its puzzle rendered, and that player keeps
     * the puzzle and reads the substitution notice. Rare, but it makes this
     * event an upper bound on the dead-app population rather than a
     * measurement of it.
     */
    phase?: 'boot' | 'boot-fallback';
}

/**
 * Data attached to `piece-count-mismatch` — generation produced a different
 * number of pieces than the base cut declared it would (#512). Three
 * historical fused-piece bugs shipped undetected before this event existed.
 *
 * The event exists to be ACTED on, not just counted: `seed`, `cutStyle`,
 * `cols`, `rows`, `imageWidth`, `imageHeight`, `rotationMode` and
 * `styleConfig` are exactly the repro params the info modal prints — and
 * that `cutStyle` is not attribution-only: `reproParamsToPayload` throws
 * without it (`repro-params.ts`), so a row missing it from this list would
 * lead an operator to reassemble a `__reproPuzzle` call that fails. A row
 * here can normally be replayed locally through `__reproPuzzle` and turned
 * into a regression test — the exception is the rare row where the
 * per-style config didn't fit and `styleConfig` was replaced by
 * {@link PieceCountMismatchData.styleConfigOmitted}.
 *
 * `expected` and `actual` are PRE-STRIP, GENERATION-GRID counts, while
 * `cols`/`rows` are the USER grid. For a borderless puzzle these legitimately
 * disagree: a borderless 16x12 oversizes to 18x14 = 252 faces before the outer
 * ring is stripped, so `expected: 252` alongside `cols: 16, rows: 12` is
 * correct, not a contradiction. The user grid is what a replay needs.
 *
 * No `delta` property: it is `actual - expected` and both are here, so the
 * CSV export computes it — compute it to triage, not just to size the
 * problem. Its SIGN, not its magnitude, is the discriminator between the two
 * populations described below: a fused-face defect always gives
 * `actual < expected`, a self-intersecting-cut artifact always gives
 * `actual > expected`. So `actual < expected` is the incident query and
 * `actual > expected` is the triage bucket. Magnitude is a weak hint at
 * best — the extreme configs surveyed for #512 overshot by large factors
 * (`expected 48, actual 4881`), but a milder self-intersection lands only a
 * face or two over (`generator.test.ts` pins wavy 2x2 at `hf`/`vf` = 10
 * producing `expected 4, actual 6`), so a small positive delta is normal
 * self-intersection or sliver territory rather than an unexplained row.
 *
 * The sign splits the two populations, but it does NOT partition the
 * incidents: both act on the same counter, so a puzzle carrying a fusion
 * AND a sliver reports only their net. A fused pair (-1) alongside one
 * sliver (+1) lands on `actual == expected` and fires nothing at all; a
 * fusion alongside two slivers files as the benign `actual > expected`
 * bucket. Slivers are common enough (see below) that this is not a corner
 * case. So `actual < expected` is a LOWER BOUND on fusion incidents, not a
 * complete list of them — a clean positive-delta export means "no fusion
 * large enough to outweigh the slivers on the same puzzle", not "no
 * fusions".
 *
 * `imageUrl` is deliberately absent. Cut geometry is a function of the seed,
 * the grid, the image SIZE, the style and the style config — the image bytes
 * do not enter it, and `reproParamsToPayload` defaults a missing image to a
 * blank puzzle, so a replay is geometrically identical without it. Shipping
 * it in any form would also be the first exception to the redaction rule
 * {@link TracedChunkLoadFailedData} follows.
 *
 * `imageUrl` and `styleConfig` are the two fields this schema treats as
 * capable of running long, and each is handled by the mechanism that fits
 * it: `imageUrl` cannot be usefully shortened — a truncated URL is a broken
 * one — so it is dropped unconditionally, at build time. `styleConfig` is
 * usually a handful of numbers but occasionally unbounded (see
 * {@link PieceCountMismatchData.styleConfigOmitted}), so it is checked and
 * dropped only at runtime, only on the rows that actually cross Umami's
 * 500-char string limit. Both follow the same principle: never ship
 * something that looks replayable and isn't.
 *
 * `source` separates real players from developer investigation. Two
 * non-player values: replaying a known-bad puzzle through `__reproPuzzle`
 * re-runs generation and re-fires this event (`source = 'repro'`), and
 * `__newComposableGame`/other dev-console starts do the same for arbitrary
 * cut parameters (`source = 'dev'`) — at 2x shipped Wavy's frequency, for
 * instance, a developer poking at the console mismatches on essentially
 * every seed, and dev-deploy reports to the same Umami website ID as
 * production. Both must be excluded when counting incidents, and here that
 * exclusion is a POSITIVE filter: the player-facing population is
 * `source in ('fresh', 'shared')`.
 *
 * Deliberately not the subtraction {@link SharedLoadFailedData}'s `source`
 * needs. That one is subtractive because it was added to an already-shipping
 * event, so its absent rows have to be read as `'shared'` and no filter can
 * express "absent". This `source` shipped with the event, is required, and is
 * set unconditionally at both emit sites, so every row carries one of the four
 * values and the positive form is exact. It is also the safer of the two under
 * change: a future FIFTH `source` value would be counted as player traffic by
 * the subtraction and left out by the positive form, so the mistake it makes
 * is visible (a total that no longer adds up) rather than silent.
 *
 * `source` does not catch every developer row, and the gap is a filterable
 * one rather than a labeled one: SUBTRACT `source = 'fresh' AND cutStyle =
 * 'composable'` as well. The dev console is not the only route to an
 * arbitrary sine config — the new-game dialog offers Composable, with H/V
 * Frequency sliders reaching 10 (`new-game-dialog.ts`), wherever
 * `isComposableVisible()` is true, which is `npm run dev` AND the
 * `/dev/` preview deploy (`/puzzle/dev/` before the move to
 * puzzlewise.github.io; `cut-styles.ts`). That dialog binding is a
 * plain `startNewGame(...)`, so it reports `'fresh'`. Those rows are still
 * developer traffic by construction: the production build filters Composable
 * out of the dialog, so a production player cannot select it, and the only
 * legitimate production composable puzzle arrives from a share link — which
 * reports `'shared'`. A production row with `source = 'fresh'` and
 * `cutStyle = 'composable'` therefore means a saved Composable *preference*
 * replayed through the save-less boot path (`boot-sequence.ts`), which only
 * someone who used dev-deploy can have set (the two share an origin, so they
 * share localStorage). Note this subtraction covers `cutStyle` `'composable'`
 * only: `'wavy'` and `'triangles'` are composable-backed but ship as fixed
 * production presets, so their `'fresh'` rows are real players.
 *
 * Unlike the other `source`/`cutStyle` rules here, that one is COMPOUND — it
 * names two properties of the same row, and the two must be correlated per
 * event. (The `delta` note above is the other compound reading in this block:
 * `actual < expected` is likewise two properties of one row.) Do not
 * substitute two independent subtractions: removing `source = 'fresh'` and
 * then `cutStyle = 'composable'` takes out their UNION, not their
 * intersection, which over-subtracts and undercounts real incidents (every
 * genuine `'fresh'` Wavy row goes with it). Count this one from a per-event
 * view, where a single row carries both properties — the same export the
 * `delta` note above needs for the same reason — not by combining the two
 * per-property totals.
 *
 * That subtraction is sound only while Composable stays dev-only. Shipping it
 * to production — `isComposableVisible()` returning true for a production
 * build — makes `'fresh'` + `'composable'` a real player, and this rule starts
 * silently discarding genuine incidents. Delete it in the same change, and
 * label the dev routes some other way if they still need excluding.
 *
 * A residual neither rule removes: a composable share link CREATED on a dev
 * build and opened on the preview reports `'shared'` like any other
 * recipient, and dev-deploy shares production's website ID — the page path
 * (the preview prefix, as above) is the only thing separating the
 * two. Since an extreme sine config mismatches on essentially
 * every seed, one review link opened a few times reads as several field
 * incidents. Slice by `url` before treating a cluster of `'shared'` +
 * `'composable'` rows as production. Left as a query caveat on purpose: the
 * code cannot tell a dev-built link from a real one at open time, and a
 * `source` that tried to would suppress genuine preview signal.
 *
 * Not every row is a bug: exotic composable configs (e.g. sine `hf`/`vf` = 10
 * on a small grid) can self-intersect and carve genuine island faces, so the
 * real face count legitimately exceeds the declared one — always `actual >
 * expected`, by anything from a couple of faces to a factor of a hundred —
 * without a fused- or dropped-piece defect behind it. Treat this event as a
 * lead to replay and inspect, not an automatic incident count.
 *
 * A small positive delta has a second, even more benign explanation worth
 * ruling out first: sub-pixel sliver faces left over from curve-intersection
 * rounding. Those are real extra faces in the DCEL, so they count in `actual`
 * — the auto-group pass merges them into a neighbour's starting group but
 * never removes them (`auto-group.ts`: "leaves the topology untouched"), so
 * where the check sits relative to that pass makes no difference to this
 * number. What the pass does change is visibility: a sliver the player never
 * sees as a separate piece still shows up here. The area floor below which
 * one gets absorbed is per style (`avgPieceArea / 4` for Classic and Wavy,
 * `DEFAULT_MIN_PIECE_AREA` for a composable game that sets none), so a puzzle
 * with a handful of sub-threshold faces is unremarkable. Replay before
 * reading a small overshoot as a defect.
 */
export interface PieceCountMismatchData {
    /** The cut style the player chose. */
    cutStyle: string;
    /**
     * The base-cut generator that declared the expectation — `'sine'` on
     * every row today, because sine is the only generator that implements
     * `expectedPieceCount` (`plugin-types.ts` explains why Venn and the
     * triangular lattice are exempt rather than permanently false-positive).
     *
     * NOT derivable from `cutStyle`, and the mapping is not onto: the
     * mismatch is a property of the base cut, and only THREE cut styles reach
     * a checked one. Sine-based Classic (i.e. a puzzle carrying
     * `classicConfig.traceSetVersion`), Wavy, and a Composable game left on
     * its default `'sine'` base cut. The rest are structurally exempt and can
     * never appear here, which matters because their absence is silence
     * rather than health:
     *
     * - `triangles` — the shipped preset hardcodes `baseCutGenerator:
     *   'triangular'` (`cut-style-strategies.ts`), which declares no expected
     *   count. Zero Triangles rows says nothing about Triangles.
     * - `fractal` — a different generator entirely; it never reaches the
     *   topology pipeline.
     * - legacy `classic` (no `classicConfig`) — runs `generateProceduralPuzzle`
     *   and produces no topology result to check.
     * - `composable` with `baseCutGenerator: 'triangular'` — same exemption as
     *   Triangles.
     * - `composable` with `baseCutGenerator: 'venn'` — the other registered
     *   base cut that declares no expected count (`generator.test.ts` pins
     *   both). Reachable from `__startVennPuzzle` (`dev-hooks.ts`, so
     *   `source: 'dev'`) and from a share link, since the decoder's
     *   `isValidComposableCf` accepts any registered base-cut id.
     */
    baseCut: string;
    /** Faces the base cut intended to produce. Pre-strip, generation-grid. */
    expected: number;
    /** Faces the pipeline actually yielded. Pre-strip, generation-grid. */
    actual: number;
    /**
     * Repro param: the puzzle's PRNG seed, normalized to a uint32 by the
     * payload builder. `generateSeed` already produces one, but the share-link
     * decoder only checks that `s` is a number, so a crafted link can arrive
     * carrying a fraction or a value past `DECIMAL(19,4)`'s range — which
     * Umami would round or reject. The normalization is a no-op for every real
     * seed and preserves the PRNG stream for the crafted ones, so the value
     * here always replays the puzzle it describes. It is therefore NOT
     * guaranteed to equal the seed the info modal's "Reproduction parameters"
     * block prints for the same puzzle — the modal prints `state.seed` raw.
     * They agree on every real and every legitimate share-link seed; they can
     * disagree only on a crafted one, and both still replay the same puzzle.
     *
     * `-1` is a sentinel, not a seed — see the note on sentinels below.
     */
    seed: number;
    /** Repro param: the USER grid — see the note above. `-1` is a sentinel. */
    cols: number;
    /** Repro param: the USER grid — see the note above. `-1` is a sentinel. */
    rows: number;
    /**
     * Repro param: image width. Part of the geometry contract, not
     * decoration.
     *
     * SENTINEL — applies to `seed`, `cols`, `rows`, `imageWidth` and
     * `imageHeight`: `-1` means the field was missing from the state the
     * payload was built from, NOT a real value. It is unreachable for a
     * generated puzzle (`createNewGame` always sets seed, grid and image
     * size), so a `-1` row is a bug in the payload builder rather than
     * something about the puzzle — and it is deliberately reported instead of
     * dropping the event, because a diagnostic that silently declines to
     * report is worse than one carrying an obviously impossible value. Such a
     * row is not replayable; exclude `-1` when aggregating these fields, and
     * treat any occurrence as a defect to investigate.
     *
     * `cutStyle` and `rotationMode` carry NO sentinel, and that is not an
     * oversight: absence of either has a defined meaning in this codebase — a
     * state with no cut style is classic, one with no rotation mode is
     * `'none'` — so the builder falls back to that meaning rather than to an
     * impossible value. There is no equivalent reading of a missing seed,
     * grid or image size.
     */
    imageWidth: number;
    /** Repro param: image height. Part of the geometry contract, not decoration. `-1` is a sentinel. */
    imageHeight: number;
    /** Repro param: rotation mode. */
    rotationMode: string;
    /**
     * Repro param: compact JSON of the per-style config block belonging to
     * this row's own `cutStyle` — `classicConfig` for `'classic'`,
     * `wavyConfig` for `'wavy'`, and so on. One property rather than four
     * mutually-exclusive flattened shapes, and exactly what
     * `reproParamsToPayload` needs to rebuild the payload: reassemble it
     * under the key that matches `cutStyle`, unambiguously, with no guessing
     * from the JSON's shape.
     *
     * The builder gates on `cutStyle` rather than taking whichever block the
     * state happens to carry, so a state with a stray FOREIGN block — a
     * crafted share link, a hand-edited save — cannot have another style's
     * config attributed to it and produce a row that reads as replayable and
     * isn't.
     *
     * Absent in two cases, and {@link
     * PieceCountMismatchData.styleConfigOmitted} is what tells them apart:
     * - the puzzle genuinely carries no block for its own style — a wavy or
     *   composable share link that arrived without `wf`/`cf`
     *   (`share-payload-to-init.ts`), which replays on the generator's
     *   defaults. No flag;
     * - the block serialized past Umami's 500-char string limit. Flag set.
     *
     * The builder has two further branches that drop the field, and NEITHER
     * can produce a row — don't read one into an export:
     * - the `cutStyle` gate discarding a FOREIGN block. `createNewGame` writes
     *   only the block matching the style's `configKey` and `undefined` for
     *   the other four (`game/init.ts`), and both call sites pass its return
     *   value straight to the builder — so on every state this app builds, "a
     *   stray foreign block" is the first case above. The gate is structural
     *   safety against a state this app doesn't build, not a cause an operator
     *   can observe;
     * - the block failing to serialize at all (`JSON.stringify` throws on a
     *   circular or BigInt-bearing config and overflows on a deeply-nested
     *   one), which would also set the flag. Both flows call
     *   `deps.persistNewPuzzle(state)` BEFORE they `track` this event
     *   (`app/start-new-game.ts`, `app/load-shared-puzzle.ts`), and
     *   `saveGeometry` hands the same `composableConfig` to an unguarded
     *   `JSON.stringify` (`persistence/storage.ts`) — so a config that cannot
     *   serialize throws out of the save first and the event never fires. That
     *   covers a crafted link's deeply-nested config as much as the dev-console
     *   `__newComposableGame` live object — the live object is the one source
     *   that can construct a CIRCULAR config, but being `JSON.parse` output
     *   bounds neither depth nor size: the parser accepts nesting far past the
     *   point `JSON.stringify` overflows at, and `isValidComposableCf` checks
     *   only that `bgc`/`tgc` are non-null objects (`sharing/share-link.ts`).
     *   The save's stringify walks the same chain one level deeper —
     *   `serializeStatic` nests `composableConfig` under a wrapper object
     *   (`persistence/serialization.ts`) — so it overflows on a SHALLOWER
     *   config than the builder's would, and still throws first. The builder's
     *   `try` is defense in depth against that ordering changing.
     *
     * So every `styleConfigOmitted` row an operator can see is over-limit,
     * whatever its `source`.
     *
     * Legacy Classic — whose *absence* of `classicConfig` is load-bearing,
     * selecting the legacy generator — cannot produce this event at all: it
     * runs `generateProceduralPuzzle` and never reaches a checked base cut.
     *
     * Mutually exclusive with `styleConfigOmitted`: at most one of the two is
     * ever present, so the event never carries more than the 12 documented
     * properties.
     *
     * Unlike every other field here, this one is not validated against the
     * redaction convention {@link TracedChunkLoadFailedData} follows:
     * composable's `baseCutConfig`/`tabConfig` pass through from the share
     * link's wire format unvalidated (see `styleConfigOmitted` below), so a
     * crafted link can place an arbitrary string under 500 chars in here —
     * e.g. `{ u: "https://..." }` — and it ships verbatim. That the OTHER four
     * blocks cannot do the same is a property of the decoder, not of their
     * types: every field they reconstruct from is type-checked or clamped on
     * decode (`ff.bl`/`wf.bl` must be booleans; `wf.tv`/`tf.tv`/`clf.tv` are
     * clamped to a known trace-set version or dropped). Loosen any of those
     * and this field's exposure widens beyond composable — and a `wavy` or
     * `triangles` row lands OUTSIDE the `cutStyle = 'composable'` filter an
     * operator would reach for. Two things not to understate about that: the
     * trigger is reliable rather than incidental (an extreme sine config
     * mismatches on essentially every seed, so one opened link puts a chosen
     * string in the dataset on demand), and "never rendered" is true of the
     * app, not of the Umami dashboard, which is where an operator actually
     * reads this. Impact is still bounded — 500 chars of attacker-authored
     * text, no victim data, landing only in our own dataset — so the gap is
     * left open deliberately: filtering keys here would silently change what
     * a legitimate composable repro carries, which would break the replay
     * guarantee this event exists for.
     * Validating the composable config's shape belongs with the share-link
     * decoder (#491), not with this payload builder.
     */
    styleConfig?: string;
    /**
     * Set instead of `styleConfig` when the puzzle's per-style config
     * serializes past Umami's 500-char string limit. The builder also sets it
     * when the config does not serialize at all, but no such row can reach
     * Umami — the save on the way to this event stringifies the same config
     * first and throws, see the absence list on {@link
     * PieceCountMismatchData.styleConfig} — so read this flag as "over-limit".
     * A row with this flag is **not** replayable as-is through `__reproPuzzle`
     * — the config needed to regenerate the exact cut is missing — but every
     * other repro field (`seed`, `cols`, `rows`, `imageWidth`, `imageHeight`,
     * `rotationMode`) is still valid and the `expected`/`actual` counts are
     * unaffected.
     *
     * In practice this means `cutStyle: 'composable'`: `composableConfig`'s
     * `baseCutConfig`/`tabConfig` are opaque `Record<string, unknown>`
     * (`model/types.ts`), and the share-link decoder only checks that they
     * are non-null objects — no size or shape bound — so a crafted share
     * link can produce a config large enough to cross the limit. None of the
     * other four per-style config blocks can be driven there from a share
     * link: they carry only booleans and clamped trace-set versions, and the
     * decoder enforces exactly that — see the note on {@link
     * PieceCountMismatchData.styleConfig}, which depends on the same
     * enforcement. Truncating instead of omitting was rejected: truncated
     * JSON does not parse, so a truncated `styleConfig` would look replayable
     * and not be — the same reasoning that keeps `imageUrl` off this event
     * entirely.
     *
     * Never `false`; absent on every row not dropped for size. Query it the
     * way this schema treats every optional property: PRESENCE is the filter —
     * `styleConfigOmitted = true` selects exactly the dropped-config rows. The
     * complement is arithmetic, not a filter: rows NOT dropped for size are
     * total `piece-count-mismatch` minus that. `styleConfigOmitted != true`
     * does not express it — the property's only value is `true`, so that
     * filter joins on the key and then excludes every row it matched, i.e. it
     * returns nothing at all. (Sharper than the same absence problem {@link
     * SharedLoadFailedData}'s `source` has: there the two-valued field at
     * least matches the rows that carry it.) Note the complement is "not
     * dropped for size", not "carried a config": it also contains the rows
     * documented two paragraphs above on {@link
     * PieceCountMismatchData.styleConfig}, where the puzzle genuinely had no
     * block for its own style — a wavy or composable link that arrived
     * without `wf`/`cf` replays on the generator's defaults and can mismatch
     * like any other.
     */
    styleConfigOmitted?: true;
    /**
     * How the puzzle started. See the note above on excluding `'repro'` and
     * `'dev'` from the incident count. `'dev'` is never `'repro'` — a fresh
     * dev-console game is not a replay of anything — so the two stay
     * separately queryable even though both are non-player traffic.
     */
    source: 'fresh' | 'shared' | 'repro' | 'dev';
}

/**
 * Data attached to `share-failed` — the share flow fell through to its error
 * path (clipboard write failed, or no share mechanism was available) and the
 * user saw a "Couldn't share" toast. User cancellation of the native share
 * sheet (`AbortError`) is NOT a failure and is never tracked. `source` mirrors
 * `puzzle-shared`: the info-modal share section or the completion overlay.
 */
export interface ShareFailedData {
    source: 'info-modal' | 'completion-overlay';
    reason: string;
}

/**
 * Data attached to `save-failed` — a `localStorage` write failed even after
 * the lz-string compression fallback (typically quota exhaustion).
 *
 * On `main` this surfaced incidentally as an `unhandled-error`; the persistence
 * layer now catches it, so this is the explicit replacement signal.
 *
 * `op` distinguishes the per-move progress write from the one-time new-puzzle
 * (geometry) write, so an operator can tell whether a save failed at creation
 * (nothing persisted) or mid-play (only the latest moves were dropped).
 *
 * `cutStyle`/`pieceCount`/`traceSetVersion` match its `save-compressed` and
 * `progress-save-skipped` siblings, so a failure can be attributed to the
 * geometry regime that caused it instead of arriving as an unattributable
 * count. `cutStyle: 'classic'` alone no longer identifies a regime — it spans
 * both the light legacy straight-grid geometry and the ~14×-larger sine
 * geometry — so `traceSetVersion` presence is what separates them.
 */
export interface SaveFailedData {
    op: 'progress' | 'new-puzzle';
    cutStyle: string;
    pieceCount: number;
    /** See {@link NewGameData.traceSetVersion} — same derivation, from the saved state. */
    traceSetVersion?: number;
}

/**
 * Data attached to `save-compressed` — a write exceeded the plain-write quota
 * and fell back to the lz-string-compressed payload. Emitted once per created
 * puzzle, so an operator can see a puzzle crossing into the near-quota regime
 * (one growth step from total failure) before it tips into `save-failed`.
 *
 * Scope is the whole one-time new-puzzle save, not the geometry write alone:
 * `saveNewPuzzle` writes geometry and the initial progress and reports the
 * worse of the two, so an initial *progress* write that compressed produces
 * the same event. Geometry dominates the payload by orders of magnitude, so in
 * practice this reads as a geometry signal — but unlike its `save-failed`
 * sibling there is no `op` dimension to prove it, and adding one means
 * widening `saveNewPuzzle`'s return type to report per-key outcomes.
 */
export interface SaveCompressedData {
    cutStyle: string;
    pieceCount: number;
    /** See {@link SaveFailedData.traceSetVersion} — separates the two Classic regimes. */
    traceSetVersion?: number;
}

/**
 * Data attached to `save-unreadable` — a saved game was present but could not
 * be restored, so the player was offered the recovery dialog instead of having
 * their puzzle silently regenerated over.
 *
 * `reason` distinguishes the failure class (the persistence layer already
 * separates these internally): a parse/deserialize failure, a geometry/progress
 * seed mismatch, or a torn write with no usable progress. Low cardinality, so
 * it groups cleanly in the dashboard.
 */
export interface SaveUnreadableData {
    reason: 'parse-error' | 'seed-mismatch' | 'torn-write';
}

/**
 * Data attached to `progress-save-skipped` — a debounced progress autosave was
 * refused because the recorded owner of the save slot is a different puzzle
 * than the one being saved (see `saveProgress`). `cutStyle`/`pieceCount`
 * describe the puzzle whose progress was dropped.
 *
 * **Not a synonym for "cross-tab takeover".** It counts two distinct causes,
 * and the takeover may well be the smaller:
 *
 * 1. **The cross-tab race** (#404) — another tab started a puzzle over this
 *    one. This is what the guard was built for, and what previously produced a
 *    torn save and a false "corrupt" dialog. Every later autosave of this
 *    tab's puzzle mismatches too, so it shows up as a *run*.
 * 2. **A new puzzle too large to store.** When `saveNewPuzzle`'s geometry
 *    write fails on quota (the #487/#399 large-save regime), the *previous*
 *    puzzle's geometry stays in the slot and the token correctly still names
 *    it — so every autosave of the new puzzle mismatches and skips, for the
 *    rest of the session, with no second tab involved at all. Note this
 *    produces exactly the shape a sustained takeover would: a long run of this
 *    event from one user.
 *
 * A new game does *not* strand a save here: `GameSession.install` cancels the
 * outgoing puzzle's pending autosave before the new geometry takes the slot,
 * so the doomed save never flushes (#514). Before that fix it was a third
 * cause — an isolated skip around every new game started with an active
 * multi-select selection — so sessions predating the fix can still show it.
 *
 * Discriminating them is per-session inspection, not arithmetic on the totals.
 * `save-failed` with `op: 'new-puzzle'` is the useful marker but it neither
 * counts nor filters: cause 2 emits *one* of it ahead of a run of *many*
 * skips, so the two counts are at different granularities and differencing
 * them is meaningless; and `op: 'new-puzzle'` also fires when the geometry
 * write succeeded and only the initial *progress* write hit quota
 * (`saveNewPuzzle` reports the worse of the two), which produces no skipped
 * run at all. Absence is not filterable here either (see
 * {@link NewGameFailedData}). So read sessions: a `save-failed{op:'new-puzzle'}`
 * followed by a long run is cause 2; a long run with no `save-failed` is
 * cause 1.
 *
 * Since #490 the comparison reads the derived `puzzle-geometry-seed` token
 * instead of decoding the geometry blob. That does not add a cause: every path
 * the app can take keeps the token equal to the seed of the blob in the slot —
 * it is re-anchored on load, dropped on a foreign geometry write and on a
 * bfcache restore, and left alone on a failed geometry write (which is what
 * makes cause 2 a correct skip rather than a bug). A token written by foreign
 * same-origin script is the one thing that could make it lie, and no dimension
 * separates that case.
 */
export interface ProgressSaveSkippedData {
    cutStyle: string;
    pieceCount: number;
    /** See {@link SaveFailedData.traceSetVersion} — separates the two Classic regimes. */
    traceSetVersion?: number;
}

/**
 * Data attached to `save-recovery` — emitted once when the player closes the
 * unreadable-save dialog. `downloaded` records whether they took a copy of the
 * raw data before starting over, so an operator can tell whether the recovery
 * affordance is actually used.
 */
export interface SaveRecoveryData {
    downloaded: boolean;
}

/**
 * Data attached to `pwa-update-detected` — a freshly-built service worker is
 * waiting and the persistent "update ready" indicator was shown. This is the
 * funnel denominator. The gap between detected and applied is the
 * stuck-indicator field signal.
 */
export type PwaUpdateDetectedData = Record<string, never>;

/**
 * Data attached to `pwa-update-check-failed` — a background update *check*
 * (`registration.update()` at registration or on a visibility regain)
 * rejected. This is distinct from `pwa-update-apply-failed`: nothing was being
 * applied, the check itself
 * failed (typically offline or a server error), and it self-heals on the next
 * visibility change. It labels the check-failure leg of the funnel
 * (`pwa-update-detected` → check failures → `pwa-update-applied` /
 * `pwa-update-apply-failed`) that would otherwise only surface as a generic
 * `unhandled-error`.
 *
 * Checks fire on every visibility regain, so an offline session would reject on
 * every return to the tab. To avoid flooding, each distinct sanitized `reason`
 * is reported at most once per session and the number of distinct reasons is
 * capped (see `setupUpdateChecks`). `reason` is the sanitized rejection
 * message.
 */
export interface PwaUpdateCheckFailedData {
    reason: string;
}

/**
 * Data attached to `pwa-update-applied` — a deferred service-worker update was
 * applied (the page committed to reloading into the new version).
 *
 * `trigger` records what caused the apply:
 * - `focus-regain` — auto-applied when the app became visible again with an
 *   update pending.
 * - `manual` — the user tapped the persistent indicator.
 * - `share-link-rescue` — an undecodable `#p=` link forced an update check
 *   that found a newer build; applied automatically so the reload can
 *   re-parse the link.
 * - `other-tab` — another tab applied the update, and this page, which a
 *   worker controlled at load, reloads as the new worker takes over.
 * This is the numerator against `pwa-update-detected` — the gap between the two
 * is the stuck-indicator signal (detected but never applied).
 *
 * The pwa update-controller derives its `UpdateApplyTrigger` union from this
 * payload, so the set of triggers has a single source of truth here.
 */
export interface PwaUpdateAppliedData {
    trigger: 'focus-regain' | 'manual' | 'share-link-rescue' | 'other-tab';
}

/**
 * Data attached to `pwa-update-fallback-reload` — the applied worker did not
 * reach `activated` (or the reload did not navigate the page away) within 3 s,
 * so the fallback hard reload fired. A worker that another tab already
 * activated reloads at once and is not reported, so every event is a failed
 * hand-off.
 */
export type PwaUpdateFallbackReloadData = Record<string, never>;

/**
 * Data attached to `pwa-update-install-failed` — a new service worker went
 * `redundant` while still installing, typically because a precached file
 * failed to download. The player stays on the build they have, and since the
 * worker never waits, no `pwa-update-detected` precedes it. Reported at most
 * once per session.
 *
 * - `isUpdate` — false when no worker was active: the first install failed and
 *   the player has no offline copy yet.
 * - `online` — `navigator.onLine`. False reliably means offline; true does not
 *   prove the network works.
 */
export interface PwaUpdateInstallFailedData {
    isUpdate: boolean;
    online: boolean;
}

/**
 * Data attached to `pwa-update-apply-failed` — `updateSW(true)` rejected while
 * trying to activate the waiting worker. The scheduled fallback reload still
 * covers recovery; this event makes a consistently-failing apply path visible
 * instead of silent. `reason` is the sanitized rejection message.
 */
export interface PwaUpdateApplyFailedData {
    reason: string;
}

/**
 * Data attached to `pwa-register-failed` — `registerSW`'s `onRegisterError`
 * fired: the service worker could not be registered at all (script 404,
 * security error, or the browser blocking registration). This is the
 * registration *precondition*, conceptually upstream of the
 * `pwa-update-detected` → applied funnel: when it fires there is no
 * registration, so no update checks run and the PWA update mechanism is dead
 * for the session. That makes it the most severe update-related failure — a
 * failed *check* (`pwa-update-check-failed`) self-heals on the next visibility
 * regain, whereas a failed registration does not recover until the next page
 * load.
 *
 * `registerSW` is called exactly once per page load, so `onRegisterError` fires
 * at most once; unlike `pwa-update-check-failed` this needs no per-reason dedup
 * or cardinality guard. vite-plugin-pwa 1.3.0 also routes a failed
 * `import('workbox-window')` chunk load here, indistinguishable from a
 * failed `register()` except by the error itself.
 *
 * `reason` is the sanitized rejection message, which drops a non-`Error`
 * value's type (#597's bare `Rejected`). `valueType` keeps it: `typeof`, or
 * the constructor name for an object (`DOMException`, `TypeError`,
 * `Object`). `name` is the {@link UnhandledErrorData} dimension, so it
 * equals `valueType` for a non-`Error`.
 *
 * `registerFunction` is `navigator.serviceWorker.register` at failure time:
 * `replaced` when page or extension script swapped it out, `unavailable` when
 * `navigator.serviceWorker` was absent or threw on access. `native` is not
 * proof it was untouched — a bound or `Proxy` wrapper also stringifies as
 * native code.
 *
 * Rows from builds before #597 carry `reason` alone.
 */
export interface PwaRegisterFailedData {
    reason: string;
    valueType: string;
    name: string;
    registerFunction: 'native' | 'replaced' | 'unavailable';
    displayMode: 'standalone' | 'browser';
    visibilityState: DocumentVisibilityState;
}

/**
 * Data attached to `share-link-rescue-attempted` — a `#p=` share link failed
 * to decode, and since the payload format has historically grown without
 * bumping `v`, the client may simply be a stale cached build. The app ran the
 * rescue: one forced service-worker update check, guarded per link.
 *
 * `outcome` records how it ended: `updated` (a newer build was found and
 * applied — a reload with the hash intact is imminent, and the follow-up
 * `share-link-rescue-result` event on the next page load closes the funnel),
 * `no-update` (the check completed and this client is already current), or
 * `unavailable` (no service-worker registration, e.g. the dev server; the
 * check rejected while offline; or the deadline expired). The `no-update` /
 * `unavailable` legs fall straight through to the invalid-link toast.
 *
 * The pwa share-link-rescue module derives its `RescueOutcome` union from
 * this payload, so the set of outcomes has a single source of truth here
 * (same pattern as `PwaUpdateAppliedData` / `UpdateApplyTrigger`).
 */
export interface ShareLinkRescueAttemptedData {
    outcome: 'updated' | 'no-update' | 'unavailable';
}

/**
 * Data attached to `share-link-rescue-result` — the page load after a rescue
 * reload re-parsed the same link. `decoded` records whether the updated build
 * understood it (`true`) or it still fell through to the invalid-link toast
 * (`false`). Paired with `share-link-rescue-attempted` outcome `updated`,
 * this measures whether the rescue actually fixes links in the wild.
 */
export interface ShareLinkRescueResultData {
    decoded: boolean;
}

export type MoveTrigger = 'banner' | 'new-game';

/**
 * Move events come only from a build with `VITE_MOVED_TO` set — the legacy
 * adrianschmidt.github.io deploy steering players to puzzlewise.github.io.
 * `ios-standalone` is an installed iOS home-screen app: it is shown
 * instructions instead of the handoff and never sends `move-started`.
 */
export interface MoveDialogShownData {
    trigger: MoveTrigger;
    variant: 'handoff' | 'ios-standalone';
}

export interface MoveStartedData {
    trigger: MoveTrigger;
}

/**
 * `done` means the new site confirmed it wrote the data. Closing the dialog
 * mid-handoff sends no result, so `move-started` minus `move-result` counts
 * abandoned attempts. `reason` is present only with `failed`.
 */
export interface MoveResultData {
    outcome: 'done' | 'declined' | 'failed' | 'popup-blocked' | 'timeout' | 'closed';
    reason?: MoveFailureReason;
}

/**
 * A game start was canceled from the loading overlay (#489). The Cancel
 * affordance only exists while a puzzle is already installed, so every
 * event here means "returned to the previous puzzle".
 *
 * `source` uses the same four-way split as {@link PieceCountMismatchData}
 * rather than collapsing to fresh/shared: `installDevHooks` runs in
 * production builds and dev-deploy reports to production's Umami website
 * ID, so a developer canceling a `__newComposableGame` or `__reproPuzzle`
 * start would otherwise be indistinguishable from a real player losing
 * patience (#512). Filter to `'fresh'`/`'shared'` for the player question.
 *
 * `cutStyle` is the style the canceled start *requested* (for
 * `source: 'shared'`/`'repro'`, the link's style).
 *
 * `cols`/`rows` are the POST-TRANSPOSE grid, matching `NewGameData`'s
 * `cols`/`rows` and `orientation`: a portrait 192-piece puzzle is 12×16
 * on both events, so "cancel rate by grid" divides two comparable
 * buckets. (The fresh path's requested grid is always landscape-
 * normalized — see `PUZZLE_SIZE_OPTIONS` — so reporting it raw would put
 * every portrait cancel in a bucket no `new-game-started` ever lands in.)
 * `orientation` rides along for the same reason it does on `NewGameData`:
 * "cancel rate by orientation" is a segment filter on both events rather
 * than a `rows > cols` comparison computed per event.
 *
 * `elapsedMs` is overlay-shown → cancel, so it includes image fetch time,
 * not just generation — it measures the canceler's patience, not
 * generator speed. It is timestamped at unwind, not at the click:
 * canceling only takes effect at the next abort checkpoint, so a click
 * during an in-flight step with none of its own — the Unsplash image
 * fetch and the traced-tab chunk fetch today — isn't observed until that
 * step settles, and `elapsedMs` runs past the actual time-to-click by
 * however long was left on it. The chunk fetch alone can precede a
 * `source: 'shared'` cancel too: a shared load has no Unsplash fetch, but
 * still awaits the chunk when the link needs one, so the missing Unsplash
 * leg does not make a shared cancel's `elapsedMs` click-accurate. A click
 * landing during a synchronous main-thread generation — which blocks the
 * thread, so the click cannot even be dispatched until it finishes — is
 * honored (`generate-async.ts` yields to the task queue before its
 * post-generation abort check) but is late by the remainder of that
 * generation. That subset is not separable here: this event carries no
 * `generationMode`, and a cancel emits no `new-game-started` to join to.
 *
 * No completion-side pair: a canceled start emits no `new-game-started`.
 */
export interface GenerationCanceledData {
    source: 'fresh' | 'dev' | 'shared' | 'repro';
    cutStyle: string;
    orientation: Orientation;
    cols: number;
    rows: number;
    elapsedMs: number;
}

/**
 * Inject the Umami tracking script if a website ID is configured.
 *
 * Call exactly once, early in app startup, before any rendering.
 * Calling more than once would inject duplicate script tags.
 *
 * On devices opted in by visiting any app URL with `?userid=<id>`
 * (`?userid=off` opts out), the export's `distinct_id` carries the id on
 * pageview and custom-event rows. Umami stores `event_type` 5 (Web
 * Vitals) rows without it, and without `hostname`, even though the
 * tracker sends both: attribute the id via `session_id` and the site via
 * `url_path`. It labels known devices; it does not exclude them.
 */
export function initAnalytics(): void {
    const distinctId = resolveDistinctId();
    const websiteId = import.meta.env.VITE_UMAMI_WEBSITE_ID as string | undefined;
    if (!websiteId) {
        return;
    }

    const scriptUrl =
        (import.meta.env.VITE_UMAMI_SCRIPT_URL as string | undefined) ||
        DEFAULT_SCRIPT_URL;

    const script = document.createElement('script');
    script.defer = true;
    script.src = scriptUrl;
    script.dataset.websiteId = websiteId;
    // Opt into Umami's tracker-side Core Web Vitals collection (LCP/INP/
    // CLS/FCP/TTFB). Without this attribute those native event columns
    // stay null.
    script.dataset.performance = 'true';
    if (distinctId) {
        script.dataset.distinctId = distinctId;
    }
    document.head.appendChild(script);
}

/**
 * Send a typed analytics event.
 *
 * Drops the call silently in non-browser environments where there is
 * no `window` (server-side rendering, node-based unit tests) and when
 * `window.umami` is undefined (the script hasn't loaded, is blocked, or
 * analytics aren't configured for this build). Never throws.
 */
export function track(name: 'new-game-started', data: NewGameStartedData): void;
export function track(name: 'puzzle-completed', data: PuzzleCompletedData): void;
export function track(name: 'puzzle-solved', data: PuzzleSolvedData): void;
export function track(name: 'puzzle-shared', data: PuzzleSharedData): void;
export function track(name: 'background-color-changed', data: BackgroundColorChangedData): void;
export function track(name: 'info-modal-opened', data: InfoModalOpenedData): void;
export function track(name: 'info-modal-closed', data: InfoModalClosedData): void;
export function track(name: 'setting-changed', data: SettingChangedData): void;
export function track(name: 'traced-chunk-preload-started', data: TracedChunkPreloadStartedData): void;
export function track(name: 'traced-chunk-loaded', data: TracedChunkLoadedData): void;
export function track(name: 'traced-chunk-load-failed', data: TracedChunkLoadFailedData): void;
export function track(name: 'unhandled-error', data: UnhandledErrorData): void;
export function track(name: 'csp-violation', data: CspViolationData): void;
export function track(name: 'shared-load-failed', data: SharedLoadFailedData): void;
export function track(name: 'image-fetch-failed', data: ImageFetchFailedData): void;
export function track(name: 'image-fetch-http-error', data: ImageFetchHttpErrorData): void;
export function track(name: 'new-game-failed', data: NewGameFailedData): void;
export function track(name: 'piece-count-mismatch', data: PieceCountMismatchData): void;
export function track(name: 'share-failed', data: ShareFailedData): void;
export function track(name: 'save-failed', data: SaveFailedData): void;
export function track(name: 'save-compressed', data: SaveCompressedData): void;
export function track(name: 'save-unreadable', data: SaveUnreadableData): void;
export function track(name: 'save-recovery', data: SaveRecoveryData): void;
export function track(name: 'progress-save-skipped', data: ProgressSaveSkippedData): void;
export function track(name: 'pwa-update-detected', data: PwaUpdateDetectedData): void;
export function track(name: 'pwa-update-check-failed', data: PwaUpdateCheckFailedData): void;
export function track(name: 'pwa-update-applied', data: PwaUpdateAppliedData): void;
export function track(name: 'pwa-update-fallback-reload', data: PwaUpdateFallbackReloadData): void;
export function track(name: 'pwa-update-apply-failed', data: PwaUpdateApplyFailedData): void;
export function track(name: 'pwa-update-install-failed', data: PwaUpdateInstallFailedData): void;
export function track(name: 'pwa-register-failed', data: PwaRegisterFailedData): void;
export function track(name: 'share-link-rescue-attempted', data: ShareLinkRescueAttemptedData): void;
export function track(name: 'share-link-rescue-result', data: ShareLinkRescueResultData): void;
export function track(name: 'generation-canceled', data: GenerationCanceledData): void;
export function track(name: 'image-pool-fallback', data: ImagePoolFallbackData): void;
export function track(name: 'image-stash-fallback', data: ImageStashFallbackData): void;
export function track(name: 'offline-images-saved', data: OfflineImagesSavedData): void;
export function track(name: 'move-dialog-shown', data: MoveDialogShownData): void;
export function track(name: 'move-started', data: MoveStartedData): void;
export function track(name: 'move-result', data: MoveResultData): void;
export function track(name: string, data: object): void {
    if (typeof window === 'undefined') return;
    window.umami?.track(name, data as Record<string, unknown>);
}
