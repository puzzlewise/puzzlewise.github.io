# Traced Chunk on Fallback Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first visit waits for one download (the worker script) before generation, not three in a row.

**Architecture:** The generation worker statically imports the traced generator, so its bundle is one file. The main thread stops loading its traced chunk before generation; the synchronous fallback in `generate-async.ts` loads it when the worker path has failed. Classic's quiet degrade to the legacy cut is removed, so a double failure rejects the start.

**Tech Stack:** TypeScript, Vite 8 (module worker), Vitest 5, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-18-traced-chunk-on-fallback-only-design.md`

## Global Constraints

- Run npm through fnm so Node comes from `.nvmrc` (22): `/Users/bot/homebrew/bin/fnm exec npm …`. The traced geometry digest differs under Node 24. Commands below write `npm` for short.
- Never re-record a geometry digest (`dcel-broad-phase-equivalence.test.ts`, `traced-geometry-digest.test.ts`). No `vitest -u`.
- No change to generated geometry, seeded-PRNG call order, saves or share links.
- The trace data must not enter the main entry chunk.
- Repo comment policy (`CLAUDE.md`): a comment this change makes false is deleted, not rewritten, unless it carries intent the code cannot express. Add no summary or walkthrough comments.
- `src/analytics/umami.ts` doc comments are the query spec: delete every claim this change falsifies; do not add claims readable from the source.
- American English in all code and comments.
- No help-text change.
- After any interrupted test run, check for orphaned vitest workers: `ps -Ao pid,ppid,%cpu,etime,command | awk '$2==1 && /vitest/'`.

## Review Focus

1. **A browser without module-worker support** (the worker fires `error`): the player still gets the traced puzzle they asked for, via the fallback loading the chunk. Test in Task 2.
2. **Cancel pressed while the fallback's chunk is downloading:** the start unwinds as canceled and no synchronous generation runs. Test in Task 2.
3. **Worker and chunk both unreachable at boot** (stale deploy hash, offline first visit): boot ends in the legacy Classic puzzle and its toast, never a stuck overlay. Tests in Task 2 (rejects) and Task 3 (no install); browser check in Task 5.
4. **A Fractal or pre-upgrade request on the fallback:** it must not fetch the traced chunk, or an offline player with a working legacy style gets a needless failure. Test in Task 2.
5. **A traced share link when generation fails:** the recipient keeps their existing puzzle and nothing is installed. Test in Task 3.

---

### Task 0: Baseline build

**Files:** none changed.

- [ ] **Step 1: Build `main` as it is and keep a copy**

Run on the branch before any code change:

```bash
npm run build && rm -rf /tmp/pw-dist-before && cp -R dist /tmp/pw-dist-before
ls /tmp/pw-dist-before/assets
```

Expected: two `traced-tab-generator-*.js` files and one `generation-worker-*.js`. Note the gzipped size of `index-*.js` (`gzip -c <file> | wc -c`) for Task 5.

---

### Task 1: The worker carries the traced generator

**Files:**
- Create: `src/game/worker-traced-tabs.ts`
- Create: `src/game/worker-traced-tabs.test.ts`
- Modify: `src/game/generation-worker.ts`
- Modify: `src/game/generation-worker-core.ts:43-62`
- Modify: `src/game/generation-worker-core.test.ts`
- Modify: `vite.config.ts` (the `worker: { format: 'es' }` block and its comment)
- Modify: `src/analytics/umami.ts` (docs only, see Step 7)

**Interfaces:**
- Produces: `src/game/worker-traced-tabs.ts`, a side-effect module that calls `registerTabGenerator(tracedTabGenerator)`. It exports nothing.
- Produces: `handleGenerationRequest(request: GenerationRequest): GenerationResponse` (synchronous; it was `Promise<GenerationResponse>`).

- [ ] **Step 1: Write the failing tests** in `src/game/worker-traced-tabs.test.ts`

```ts
const TRACED_CLASSIC: GenerationRequest = {
    cutStyle: 'classic',
    classicConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION },
    gridSize: { cols: 4, rows: 3 },
    imageSize: { width: 1080, height: 720 },
    seed: 42,
    tabDebug: false,
};

afterEach(() => { registerTabGenerator(tracedTabGeneratorStub); });

it('replaces the stub with the real traced generator', async () => {
    expect(getTabGenerator('traced')).toBe(tracedTabGeneratorStub);
    await import('./worker-traced-tabs.js');
    expect(getTabGenerator('traced')).toBe(tracedTabGenerator);
});

it('lets the worker handler generate a traced request with no chunk load', async () => {
    vi.resetModules();
    await import('./worker-traced-tabs.js');
    const { handleGenerationRequest } = await import('./generation-worker-core.js');
    const response = handleGenerationRequest(TRACED_CLASSIC);
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result.pieces).toHaveLength(12);
});

it('is the only non-test source that statically imports the traced generator', () => {
    // Walk src/ for *.ts, skipping *.test.ts and src/test-helpers/.
    expect(filesMentioning("traced-tab-generator.js'")).toEqual([
        'src/game/worker-traced-tabs.ts',
        'src/puzzle/topology/traced-tab-loader.ts',
    ]);
    expect(filesMentioning("worker-traced-tabs.js'")).toEqual(['src/game/generation-worker.ts']);
});
```

`filesMentioning(needle: string): string[]` is a local helper returning sorted repo-relative paths. `CURRENT_TRACE_SET_VERSION` comes from `src/puzzle/composable/traces/trace-set-version.ts`. If `vi.resetModules()` breaks registry identity between the first two tests, give each its own registry import after the reset; the assertions stay as written.

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -- src/game/worker-traced-tabs.test.ts`
Expected: FAIL, module `./worker-traced-tabs.js` not found.

- [ ] **Step 3: Create `src/game/worker-traced-tabs.ts`**

Import `tracedTabGenerator` from `../puzzle/topology/traced-tab-generator.js` and `registerTabGenerator` from `../puzzle/topology/generator-registry.js`, and register it. One intent comment is warranted: this module must only be imported by the worker entry, because a main-thread import would put the trace data in the entry chunk.

- [ ] **Step 4: Make `handleGenerationRequest` synchronous** in `generation-worker-core.ts`

Remove the `requestNeedsTracedTabs` / `preloadTracedTabGenerator` block and both imports that only it used. Keep the `TracedTabLibraryNotLoadedError → 'infrastructure'` mapping: if the static import is ever lost, traced games fall back to the main thread and show up in analytics, not as hard failures. Delete the file-header paragraph about the loader's `track()` no-op and the "own copy of the lazy traced chunk" comment.

- [ ] **Step 5: Update the worker entry** `generation-worker.ts`

Add `import './worker-traced-tabs.js';` as the first import. The message listener calls the synchronous handler inside `try`/`catch`; the `catch` still posts `describeFailure('infrastructure', err)`, which now covers a throwing `postMessage` directly.

- [ ] **Step 6: Update `generation-worker-core.test.ts`**

Drop the `vi.mock` of the loader and the `preloadTracedTabGenerator` import. Delete `'awaits the traced chunk before generating a traced request'` and `'reports a rejected preload as an infrastructure failure'`. In the remaining tests remove `await` on the handler and any preload assertion. Rename `'generates without touching the traced chunk for legacy classic'` to `'generates a legacy classic request'`.

- [ ] **Step 7: Correct the analytics spec** in `src/analytics/umami.ts`

- `generationFallbackKind`, `'worker-infrastructure'` bullet: delete the text about a traced-chunk fetch failing inside the worker and the sentence "The worker-side copy of the chunk emits no `traced-chunk-*` events, so this bucket is where those failures surface." What remains: a reply that could not be posted, or the traced generator missing from the worker.
- `TracedChunkPreloadStartedData`: delete the paragraph starting "Counts only the main thread's chunk".
- `TracedChunkLoadedData` and `TracedChunkLoadFailedData`: delete the closing "Main-thread-only, like every `traced-chunk-*` event" paragraphs.

- [ ] **Step 8: Remove the worker format override** in `vite.config.ts`

Delete `worker: { format: 'es' }` and the comment above it. Then:

Run: `npm run build && ls dist/assets && grep -c 'import(' dist/assets/generation-worker-*.js`
Expected: build succeeds; exactly one `generation-worker-*.js`; the main thread's `traced-tab-generator-*.js` is the only traced chunk; the grep prints `0`.

If the build fails or emits a worker that cannot load as `{ type: 'module' }` (checked in the browser in Task 5), restore `worker: { format: 'es' }` without the comment.

- [ ] **Step 9: Run the tests**

Run: `npm test -- src/game/ && npm run lint`
Expected: PASS, including both new tests and the digest suites untouched.

- [ ] **Step 10: Commit**

```bash
git add src/game/worker-traced-tabs.ts src/game/worker-traced-tabs.test.ts src/game/generation-worker.ts src/game/generation-worker-core.ts src/game/generation-worker-core.test.ts src/analytics/umami.ts vite.config.ts
git commit -m "perf(generation): bundle the traced generator into the worker"
```

---

### Task 2: The fallback loads the chunk, fails loudly and honors Cancel

**Files:**
- Modify: `src/game/generate-async.ts:143-166` (`runOnMainThread`)
- Modify: `src/game/generate-async.test.ts`
- Modify: `src/analytics/umami.ts` (`generationMs` doc)

**Interfaces:**
- Consumes: `preloadTracedTabGenerator(): Promise<void>` and `requestNeedsTracedTabs(request)`, both unchanged.
- Produces: `generatePiecesOffThread` rejects with the chunk's own error when the fallback cannot load it, and with `GenerationCanceledError` when the signal aborted during the load.

- [ ] **Step 1: Write the failing tests** in `generate-async.test.ts`

Mock the loader the way `generation-worker-core.test.ts` did (`importOriginal`, only `preloadTracedTabGenerator` replaced). Default it to resolve after registering a stand-in: `registerTabGenerator({ ...classicTabGenerator, id: 'traced' })`. Restore `tracedTabGeneratorStub` in `afterEach`.

```ts
const TRACED: GenerationRequest = { ...REQUEST, cutStyle: 'triangles' };

it('loads the traced chunk before a traced fallback generation', async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    const out = await generatePiecesOffThread(TRACED);
    expect(preloadTracedTabGenerator).toHaveBeenCalledTimes(1);
    expect(out.mode).toBe('sync-fallback');
    expect(out.result.pieces.length).toBeGreaterThan(0);
});

it('does not load the traced chunk for a request that needs no traced tabs', async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    await generatePiecesOffThread(REQUEST);
    expect(preloadTracedTabGenerator).not.toHaveBeenCalled();
});

it('loads the chunk and generates the traced request after a worker error', async () => {
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    const promise = generatePiecesOffThread(TRACED);
    StubWorker.instances[0].errorHandler!({ message: '', preventDefault: vi.fn() });
    const out = await promise;
    expect(preloadTracedTabGenerator).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ mode: 'sync-fallback', fallbackKind: 'worker-error' });
});

it('rejects with the chunk error when the fallback chunk load fails', async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    const chunkError = new Error('chunk boom');
    vi.mocked(preloadTracedTabGenerator).mockRejectedValue(chunkError);
    await expect(generatePiecesOffThread(TRACED)).rejects.toBe(chunkError);
});

it('honors a Cancel that lands during the fallback chunk download', async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    let finishLoad!: () => void;
    // Resolves without registering a generator: if generation ran anyway it
    // would throw TracedTabLibraryNotLoadedError, not the cancel sentinel.
    vi.mocked(preloadTracedTabGenerator).mockReturnValue(
        new Promise<void>((resolve) => { finishLoad = resolve; }),
    );
    const controller = new AbortController();
    const promise = generatePiecesOffThread(TRACED, controller.signal);
    controller.abort();
    finishLoad();
    await expect(promise).rejects.toBeInstanceOf(GenerationCanceledError);
});
```

- [ ] **Step 2: Run them and see the last two fail**

Run: `npm test -- src/game/generate-async.test.ts`
Expected: `'rejects with the chunk error…'` fails with `TracedTabLibraryNotLoadedError`; `'honors a Cancel…during the fallback chunk download'` fails the same way. The other three may already pass.

- [ ] **Step 3: Change `runOnMainThread`**

Await `preloadTracedTabGenerator()` without the `.catch(() => {})`, then throw `GenerationCanceledError` if `signal?.aborted`. Delete the comment above it (every sentence in it becomes false).

- [ ] **Step 4: Correct `generationMs`'s doc** in `umami.ts`

Its second paragraph says a worker-failure fallback "spans the failed worker round trip PLUS the synchronous rerun". Add the chunk download to that span, in the same sentence. The first paragraph's "traced-chunk load inside the worker where needed" is false after Task 1: delete those words.

- [ ] **Step 5: Run the tests**

Run: `npm test -- src/game/generate-async.test.ts && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/game/generate-async.ts src/game/generate-async.test.ts src/analytics/umami.ts
git commit -m "fix(generation): surface a failed fallback chunk load and honor cancel during it"
```

---

### Task 3: Start flows stop loading the chunk; Classic's degrade is removed

**Files:**
- Modify: `src/app/start-new-game.ts`, `src/app/start-new-game.test.ts`
- Modify: `src/app/traced-tab-plan.ts`, `src/app/traced-tab-plan.test.ts`
- Modify: `src/app/generator-configs.ts`, `src/app/generator-configs.test.ts`
- Modify: `src/app/load-shared-puzzle.ts:83-87`, `src/app/load-shared-puzzle.test.ts`
- Modify: `src/app/share-payload-to-init.ts`, `src/app/share-payload-to-init.test.ts`
- Modify: `src/app/new-game-payload.ts`, `src/app/new-game-payload.test.ts`
- Modify: `src/analytics/game-context.ts`, `src/analytics/game-context.test.ts`
- Modify: `src/analytics/umami.ts`
- Modify: `src/game/generation-core.ts:82-86` and `src/app/new-game-flow.ts:208-210` (comments only)

**Interfaces:**
- Produces: `interface TracedTabPlan { cutStyle: CutStyle; forceLegacyClassic: boolean }` and `planTracedTabs(opts: { cutStyle: CutStyle; bootFallback?: boolean }): TracedTabPlan`. `resolveTracedTabOutcome` and `TracedTabOutcome` are deleted.
- Produces: `generatorConfigsForNewGame(opts: { cutStyle: CutStyle; fractalConfig?: FractalDialogConfig; wavyConfig?: WavyDialogConfig; forceLegacyClassic: boolean }): GeneratorConfigs`. Classic gets `classicConfig` unless `forceLegacyClassic`.
- Produces: `buildFreshGameData` without the `chunkDegraded` option; `NewGameData` without `tracedChunkDegraded`.
- Deleted: `needsTracedTabChunk`.

- [ ] **Step 1: Write the failing tests** in `start-new-game.test.ts`

`createNewGameAsync`'s fifth argument is the options object. Import `CURRENT_TRACE_SET_VERSION` from `../puzzle/composable/traces/trace-set-version.js`.

```ts
it('never loads the traced chunk on the main thread', async () => {
    vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
    await startNewGame({ cols: 2, rows: 2 }, { cutStyle: 'classic', imageSource: 'blank' }, deps);
    expect(preloadTracedTabGenerator).not.toHaveBeenCalled();
});

it('asks for traced Classic on an ordinary start', async () => {
    vi.mocked(createNewGameAsync).mockResolvedValue(makeAsyncGenerationResult());
    await startNewGame({ cols: 2, rows: 2 }, { cutStyle: 'classic', imageSource: 'blank' }, deps);
    expect(vi.mocked(createNewGameAsync).mock.calls[0][4]).toMatchObject({
        cutStyle: 'classic',
        classicConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION },
    });
});

it('asks for legacy Classic on a boot-fallback start', async () => {
    await startNewGame({ cols: 2, rows: 2 }, { bootFallback: true, imageSource: 'blank' }, deps);
    const options = vi.mocked(createNewGameAsync).mock.calls[0][4]!;
    expect(options.cutStyle).toBe('classic');
    expect(options).not.toHaveProperty('classicConfig');
});

it('rejects a Classic start whose generation fails, installing nothing', async () => {
    const failure = new Error('chunk boom');
    vi.mocked(createNewGameAsync).mockRejectedValue(failure);
    await expect(
        startNewGame({ cols: 2, rows: 2 }, { cutStyle: 'classic', imageSource: 'blank' }, deps),
    ).rejects.toBe(failure);
    expect(install).not.toHaveBeenCalled();
    expect(umamiTrack).not.toHaveBeenCalledWith('new-game-started', expect.anything());
});

it('prefetches the photo before generation starts', async () => {
    // Same setup as today's 'prefetches the photo before awaiting the traced chunk'.
    expect(prefetchPhoto.mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(createNewGameAsync).mock.invocationCallOrder[0]);
});
```

Delete: `'never fetches the traced chunk for a boot-fallback start'`, `'flags a Classic game degraded by a failed chunk fetch, and warns'`, `'leaves a healthy Classic start unflagged'`, `'treats a null chunk-fetch rejection as a real failure, not the success sentinel'`, `'starts the traced chunk fetch synchronously, before awaiting anything'`, `'overlaps the chunk fetch with the image request, rather than awaiting it first'`, `'prefetches the photo before awaiting the traced chunk'`.

And in `load-shared-puzzle.test.ts`, replace `'preloads the traced chunk only when the payload needs it'` with:

```ts
it('never loads the traced chunk on the main thread', async () => {
    // A payload with c: 'triangles'; stub createNewGameAsync as the file's other tests do.
    expect(preloadTracedTabGenerator).not.toHaveBeenCalled();
});

it('installs nothing when generation of a traced link fails', async () => {
    const failure = new Error('chunk boom');
    // createNewGameAsync rejects with `failure` for a c: 'triangles' payload.
    await expect(loadSharedPuzzle(payload, undefined, deps)).rejects.toBe(failure);
    expect(install).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -- src/app/start-new-game.test.ts src/app/load-shared-puzzle.test.ts`
Expected: the two `'never loads the traced chunk on the main thread'` tests FAIL (preload was called).

- [ ] **Step 3: Simplify `traced-tab-plan.ts` and `generator-configs.ts`** to the interfaces above

Update their tests: delete the `resolveTracedTabOutcome` block and the two `preloadChunk` tests; keep `'forces legacy Classic … for the boot fallback'` asserting `{ cutStyle: 'classic', forceLegacyClassic: true }`, and add one asserting an ordinary `'wavy'` plan is `{ cutStyle: 'wavy', forceLegacyClassic: false }`. In `generator-configs.test.ts` the two Classic tests pass `forceLegacyClassic: false` / `true`.

- [ ] **Step 4: Rewrite the chunk handling out of `startNewGame`**

Remove the `preloadTracedTabGenerator` import, `tracedTabsPreload`, the `resolveTracedTabOutcome` block, `chunkDegraded` and its `diagnostics.warn`. Keep the `controller.signal.aborted` check before the download report. Pass `forceLegacyClassic: tracedTabPlan.forceLegacyClassic` to `generatorConfigsForNewGame`. Keep `deps.prefetchPhoto(imageUrl)` where it is; cut its comment down to the #689 reason that is still true.

- [ ] **Step 5: Remove the preload from `loadSharedPuzzle`** and delete `needsTracedTabChunk` with its tests

In `generation-core.ts`, delete the sentence in `requestNeedsTracedTabs`'s doc that says it mirrors `needsTracedTabChunk`.

- [ ] **Step 6: Remove `tracedChunkDegraded`**

From `NewGameData` (with its doc block), `FIELD_TYPES` in `game-context.ts`, and `buildFreshGameData` (the option, the destructuring, the `if (chunkDegraded)` block and the comment above `traceSetVersionOf` that mentions degraded Classic). Update the two test files and the `buildFreshGameData` call in `start-new-game.ts`.

- [ ] **Step 7: Correct the analytics spec** in `umami.ts`

- `traceSetVersion` doc: remove the degraded-fetch entry from the omitted-for list, the first of the "three confounds" (it becomes two), `tracedChunkDegraded` from the query sentence, and "a degraded start" from the list of games with no sine config to pass on.
- `bootFallback` doc: in the last paragraph, delete the comparisons with `tracedChunkDegraded` ("Like `tracedChunkDegraded`, …", "The two flags never co-occur …", "Unlike `tracedChunkDegraded`, …"), keeping the subtraction instruction for this flag.
- `TracedChunkPreloadStartedData`: add one sentence, since queries across the release date need it: before #719 this family fired on a session's first traced start; since then only when generation fell back to the main thread.
- `NewGameFailedData`: delete the claim that the traced chunk import is the most likely cause.

In `new-game-flow.ts`, delete the sentence "The traced-tab chunk load is the likeliest rejection here (a network blip or stale deploy hash)."

- [ ] **Step 8: Run everything**

Run: `npm run build && npm run lint && npm test`
Expected: PASS. `tsc` reports no unused imports; both digest suites are green.

- [ ] **Step 9: Commit**

```bash
git add -A src
git commit -m "perf(app): stop loading the traced chunk before generation"
```

Body: explain that the main-thread chunk now loads only when the worker path fails, and that Classic no longer degrades to the legacy cut on a chunk failure (boot recovers through the boot fallback; the dialog reports a failed start). Reference #719.

---

### Task 4: Remove the dialog preload and the unused style flag

**Files:**
- Modify: `src/ui/new-game-dialog.ts:92,378,504,682-689,746,754-756`, `src/ui/new-game-dialog.test.ts:162-…`
- Modify: `src/app/new-game-flow.ts:41,156-162`, `src/app/new-game-flow.test.ts`
- Modify: `src/game/cut-styles.ts`, `src/game/cut-styles.test.ts:203-240`, `src/game/index.ts` if it re-exports the function

**Interfaces:**
- Deleted: `NewGameDialogOptions.onPreloadTracedTabs`, the composable section's `onTabGeneratorChange` option (if nothing else passes it), `cutStyleNeedsTracedTabs`, and `CutStyleOption.tracedTabs`.

- [ ] **Step 1: Delete the tests for the removed behavior**

The `onPreloadTracedTabs` tests in `new-game-dialog.test.ts`, the preload test and loader mock in `new-game-flow.test.ts` (keep the mock only if another test in the file still needs it), and the `cutStyleNeedsTracedTabs` and `tracedTabs` blocks in `cut-styles.test.ts`.

- [ ] **Step 2: Delete the code**

The dialog option, its three call sites and the `needsTracedTabs` helper; the `onPreloadTracedTabs` wiring and the loader import in `new-game-flow.ts`; `cutStyleNeedsTracedTabs` and the `tracedTabs` field from every entry in `CUT_STYLE_OPTIONS`.

- [ ] **Step 3: Verify nothing still refers to them**

Run: `grep -rn "onPreloadTracedTabs\|cutStyleNeedsTracedTabs\|tracedTabs:" src; grep -rn "preloadTracedTabGenerator" src --include="*.ts" | grep -v "\.test\.ts"`
Expected: the first grep prints nothing; the second lists only `traced-tab-loader.ts` and `generate-async.ts`.

- [ ] **Step 4: Run everything**

Run: `npm run build && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "refactor(ui): remove the new-game dialog's traced chunk preload"
```

---

### Task 5: Verify the build and the first visit

**Files:** none committed. Scratch files live in `/tmp/pw-measure/`, outside the repo.

- [ ] **Step 1: Check the build output**

```bash
npm run build
ls dist/assets
grep -c 'import(' dist/assets/generation-worker-*.js
grep -l '02-tab-a' dist/assets/*.js
gzip -c dist/assets/index-*.js | wc -c
```

Expected: one `traced-tab-generator-*.js`; the `import(` count is `0`; `02-tab-a` (the first trace's id) appears in exactly the worker file and the traced chunk, not in `index-*.js`; the entry's gzipped size is within 1 KB of the Task 0 baseline, or smaller.

- [ ] **Step 2: Write the delay server** `/tmp/pw-measure/serve.mjs`

`node serve.mjs <distDir> <port> <delayMs>`: a static file server using only Node built-ins that waits `delayMs` before answering each request, sends `Cache-Control: max-age=600` (what GitHub Pages sends), and logs `<ms since first request> <path>` per request to stdout.

- [ ] **Step 3: Measure before and after**

Serve `/tmp/pw-dist-before` on port 4701 and `dist` on 4702, both with a 300 ms delay. With the Playwright browser tools, load each five times, each time in a fresh browser context (empty HTTP cache, no service worker). Record the time from navigation start to the loading overlay being hidden (find its element in `src/ui/`), and take the request order from the server log.

Expected: before, the log shows the traced chunk, then the worker, then the worker's traced chunk, each starting after the previous finished. After, the worker script is the only request between the entry chunk and the puzzle appearing, and the median time is lower by roughly two delays (about 600 ms). Keep both medians and both request orders for the PR description.

- [ ] **Step 4: Check the fallback in the browser**

Against port 4702 in a fresh context, abort requests matching `**/generation-worker-*.js`.

Expected: the puzzle still appears with no toast, and the server log shows `traced-tab-generator-*.js` requested only after the blocked worker request.

- [ ] **Step 5: Check the double failure in the browser**

In a fresh context, abort both `**/generation-worker-*.js` and `**/traced-tab-generator-*.js`.

Expected: boot ends with a puzzle on screen and the toast "Couldn't start your usual puzzle — started a Classic one". Then start a Classic game from the new-game dialog: the toast reads "Couldn't start new game" and the puzzle on screen is unchanged.

- [ ] **Step 6: Clean up**

Stop both servers, close the browser tabs opened for this, and remove `/tmp/pw-measure` and `/tmp/pw-dist-before`.

- [ ] **Step 7: Final full run**

Run: `npm run build && npm run lint && npm test`
Expected: PASS. Nothing to commit; `git status` is clean.
