# Load the main-thread traced chunk only on fallback

Issue: #719. Background: #685 (performance audit), #489 (generation worker), #488
(boot fallback), #373 (lazy traced chunk).

## Intent

On a first visit, three downloads run one after another before generation starts:

1. the main thread's traced chunk (29 KB gzipped), awaited in `startNewGame`;
2. the worker script (29 KB);
3. the worker's own copy of the traced chunk (29 KB), loaded inside the worker.

The two traced chunks hold the same trace data. Vite builds the worker as a
separate bundle, so the same module is emitted twice under two file names.

The main-thread copy only runs when generation falls back to the main thread.
Analytics since the worker shipped (2026-08-01): 320 games generated in the
worker, 1 fell back (a data-centre session, very likely a crawler), 0
`traced-chunk-load-failed` events in 315 loads, and no `tracedChunkDegraded` or
`bootFallback` game has ever been recorded. Every first visit waits for a
download that has effectively never been used.

So: stop loading the main-thread copy up front, and make the worker a single
file. A first visit then waits for one download (about 58 KB) before generation,
not three.

## Goals

- A normal start (fresh, dialog or share link) fetches nothing on the main thread
  before spawning the worker.
- The worker script contains the traced generator. The worker makes no further
  requests.
- When the worker path fails, the main-thread fallback loads its traced chunk at
  that point and generates the puzzle that was asked for.

## Non-goals

- Spawning the worker early, or preloading the worker script from `index.html`.
  Either could overlap the worker download with the entry chunk; both are
  separate work.
- Sharing one traced-data file between the main thread and the worker.
- Any change to generated geometry, the seeded-PRNG call order, saves or share
  links.

## Anti-goals

- The trace data ending up in the main entry chunk. It must stay a lazy
  main-thread chunk.
- A start that hangs under the loading overlay when both the worker and the chunk
  fail. It must reject.
- Re-recording either geometry digest. Nothing here should move them.

## Approaches

- **A. Spawn the worker early with a warm-up message.** Keeps both traced chunks
  and the up-front main-thread load. Three legs become two. Adds a message type
  and a worker lifetime that spans the image fetch.
- **B. Bundle the traced generator into the worker and spawn early.** Three legs
  become one, still with the up-front main-thread load in parallel.
- **C. Preload links for the worker script and its chunk.** Needs a build plugin
  to expose the worker chunk's hashed name, and relies on the HTTP cache handing
  a preloaded response to the worker's fetch.
- **D. Bundle the traced generator into the worker and load the main-thread copy
  only on fallback.** One leg, one download fewer, and no early-spawn machinery.
  The cost is restructuring the start flow and giving up Classic's quiet degrade.

The owner picked D after seeing that the fallback has not run for a real player.

## Design

### Worker bundle

The worker entry imports the traced generator statically and fills the loader's
generator slot at module load, before any message arrives. The worker no longer
calls `preloadTracedTabGenerator()`.

The static import must sit in a module that only the worker bundle includes
(`generation-worker.ts` or a module only it imports). `generation-core.ts` is
imported by the main thread too, so an import there would pull the trace data
into the entry chunk.

Fractal games and pre-upgrade share links, which need no traced tabs, now get a
worker script about 29 KB larger. Accepted.

`vite.config.ts` sets `worker: { format: 'es' }` so the worker could code-split
its lazy chunk. That reason is gone. Remove the override and its comment if the
built worker still runs; if the default format causes any problem, keep the
setting and delete only the comment. (My call.)

### Start flow

`startNewGame` and `loadSharedPuzzle` stop awaiting the chunk. They build the
request for the style that was asked for and call `createNewGameAsync` directly.

Removed as a consequence:

- `resolveTracedTabOutcome`, `TracedTabOutcome` and `TracedTabPlan.preloadChunk`
  in `traced-tab-plan.ts`. What remains of the plan is the boot fallback forcing
  legacy Classic.
- The dialog's `onPreloadTracedTabs` option, its three call sites and its wiring
  in `new-game-flow.ts`. It warmed a copy that normal generation no longer uses.
- `needsTracedTabChunk` in `share-payload-to-init.ts`, if nothing else uses it.

`generatorConfigsForNewGame` stamps Classic's trace-set version unless the plan
forces legacy Classic.

### Fallback

`runOnMainThread` already calls `preloadTracedTabGenerator()` when the request
needs traced tabs. It becomes the only place the main-thread chunk loads. Two
changes:

- A failed chunk load is no longer swallowed. It rejects with the chunk error, so
  `new-game-failed` and `shared-load-failed` carry the real reason.
- Check the abort signal after the chunk await, so a Cancel pressed during the
  download skips the synchronous generation.

### Classic's quiet degrade is removed

Today a failed chunk fetch makes a Classic start silently use the legacy
straight-grid cut. In this design the chunk is only fetched after the worker has
failed, so the case is a double failure. The owner decided that Classic then
fails like every other style:

- At boot, `startWithBootFallback` already starts a legacy Classic puzzle and
  shows "Couldn't start your usual puzzle — started a Classic one".
- From the dialog, the player sees "Couldn't start new game" and keeps their
  current puzzle.

`tracedChunkDegraded` goes from `NewGameData`, `new-game-payload.ts` and
`game-context.ts`.

### Analytics

`src/analytics/umami.ts` is the query spec, so these claims must be corrected or
shed:

- `traced-chunk-preload-started`, `-loaded` and `-load-failed` now fire only on
  the fallback path. They stop being a per-session load signal; a
  `traced-chunk-*` event now means the worker path failed first.
- `tracedChunkDegraded` is removed. No recorded event carries it.
- `generationFallbackKind: 'worker-infrastructure'` no longer covers a traced
  chunk fetch inside the worker.
- On a fallback, `generationMs` also spans the chunk download.

## Constraints

- Both geometry digests stay green without re-recording. Run tests under the
  `.nvmrc` Node version (22); the traced digest differs under Node 24.
- No help-text change: nothing a player sees changes on the normal path.

## Verification

- **Build output:** one traced chunk (the main thread's lazy one), a worker file
  with no `import(`, and an entry chunk that has not grown by the trace data.
- **First visit, before and after:** serve `dist/` from a local server that adds a
  fixed delay per request, load with an empty cache, and compare the time to
  `new-game-started` and the order of requests. Record both numbers in the PR.
- **Fallback:** with the worker script blocked, a Classic start still produces a
  traced Classic puzzle, with `generationMode: 'sync-fallback'`.
- **Double failure:** with the worker script and the main-thread chunk both
  blocked, boot ends in the legacy Classic puzzle and its toast, and a dialog
  start shows "Couldn't start new game".

## Left to the builder

- How the worker fills the generator slot (a setter on the loader, or registering
  the real generator in place of the stub).
- Whether the worker keeps its `TracedTabLibraryNotLoadedError` mapping.
- Names for whatever remains of `TracedTabPlan`.
- Which existing tests are rewritten and which are deleted with the code they
  covered.
