# Image analytics events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log the New Game dialog visit, every thumbnail batch, option change, thumbnail failure and credit tap, the photo's Unsplash ID on `new-game-started`, and whether each puzzle's photo loaded (#674).

**Architecture:** A per-visit tracker (`src/app/new-game-dialog-visit.ts`) owns the dialog events and counters. `openNewGameDialog` creates it and wires it to the dialog and picker through optional callbacks, so `src/ui` stays free of visit state. A photo-ID helper derives IDs from `downloadLocation`. A puzzle-image tracker created in bootstrap watches one of the installed puzzle's existing `<image>` elements.

**Tech Stack:** TypeScript, vitest + jsdom, Umami via `track()` overloads in `src/analytics/umami.ts`.

**Spec:** `docs/superpowers/specs/2026-10-28-image-analytics-events-design.md`

## Global Constraints

- Event names and field names exactly as in the spec; every listed field always present on new rows unless the spec marks it optional.
- Never send player-typed text or image bytes; the dev query is only `'custom'`/`'none'`.
- No extra network fetch of any photo.
- Each new event: a typed `track` overload, a forwarding test in `src/analytics/umami.test.ts`, and an operator-facing doc comment (facts the code can't express only — repo `CLAUDE.md`).
- Comment policy: add no comments beyond those docs unless category 5/6 and clearly worth it.
- npm via `/Users/bot/homebrew/bin/fnm exec npm …`. No network requests to Unsplash or the proxy from tests or scripts.

## Review Focus

1. Dialog closed while a batch is in flight → that batch reports `outcome: 'abandoned'` when it settles, and `new-game-dialog-closed.batches` already counted it. (Task 3)
2. Rapid ↻ taps → earlier batches report `'superseded'`; only the latest feeds `firstThumbnailsMs` and `thumbnailsOffered`. (Task 3)
3. Bundled, blank or shared puzzles → `imagePhotoId` omitted, never `''` or `undefined` keys. (Task 1)
4. Puzzle replaced or rolled back before its photo settles → `'abandoned'`, never `'failed'`. (Task 6)
5. Dev query typed → `image-option-changed` carries `'custom'`/`'none'`, and no payload anywhere contains the text. (Task 4)

---

### Task 1: Photo ID helper and `imagePhotoId` on `new-game-started`

**Files:**
- Create: `src/images/photo-id.ts`, `src/images/photo-id.test.ts`
- Modify: `src/images/index.ts` (export), `src/app/new-game-payload.ts`, `src/app/start-new-game.ts` (pass `downloadLocation` to `buildFreshGameData`), `src/analytics/umami.ts` (`NewGameData.imagePhotoId?: string` + doc), `src/analytics/game-context.ts` (`FIELD_TYPES.imagePhotoId: 'string'`)
- Test: `src/app/new-game-payload.test.ts`, `src/app/start-new-game.test.ts`

**Interfaces:**
- Produces: `photoIdFromDownloadLocation(url: string | undefined): string | undefined` — returns the `<id>` of `https://api.unsplash.com/photos/<id>/download[?…]`, else `undefined`. `buildFreshGameData` opts gain `downloadLocation?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
// photo-id.test.ts
it.each([
    ['https://api.unsplash.com/photos/abc123/download?ixid=x', 'abc123'],
    ['https://api.unsplash.com/photos/_p-nqrlCcyE/download', '_p-nqrlCcyE'],
])('reads the id from %s', (url, id) => expect(photoIdFromDownloadLocation(url)).toBe(id));
it.each([undefined, '', 'not a url', 'https://evil.example/photos/abc/download', 'https://api.unsplash.com/photos/abc'])(
    'returns undefined for %s', (url) => expect(photoIdFromDownloadLocation(url)).toBeUndefined());

// new-game-payload.test.ts
it('reports the photo id for an Unsplash photo with a download location', () => {
    const data = buildFreshGameData(freshOpts({
        state: makeGameState({ imageUrl: 'https://images.unsplash.com/photo-1' }),
        downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
    }));
    expect(data.imagePhotoId).toBe('abc123');
});
it('omits imagePhotoId without a download location or for non-Unsplash images', () => {
    expect('imagePhotoId' in buildFreshGameData(freshOpts({
        state: makeGameState({ imageUrl: 'https://images.unsplash.com/photo-1' }) }))).toBe(false);
    expect('imagePhotoId' in buildFreshGameData(freshOpts({
        downloadLocation: 'https://api.unsplash.com/photos/abc123/download' }))).toBe(false);
});

// start-new-game.test.ts — picked photo (makeCandidateImage's downloadLocation ends /photos/abc123/download)
it("reports the picked photo's id on new-game-started", async () => {
    vi.mocked(getImageProxyBaseUrl).mockReturnValue('https://proxy.example');
    await startNewGame({ cols: 2, rows: 2 },
        noTracedTabsOptions({ imageSource: undefined, pickedImage: makeCandidateImage() }), deps);
    expect(umamiTrack).toHaveBeenCalledWith('new-game-started', expect.objectContaining({ imagePhotoId: 'abc123' }));
});
```

- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/images/photo-id.test.ts src/app/new-game-payload.test.ts src/app/start-new-game.test.ts` — Expected: FAIL (module missing / field absent).
- [ ] **Step 3: Implement.** Parse with `new URL` inside `try`; require origin `https://api.unsplash.com` and pathname `^/photos/([\w-]+)/download$`. In the payload builder set `imagePhotoId` inside the existing `imageSource === 'unsplash'` block only when the helper returns an id. Doc on the field: fresh Unsplash games whose photo came with a download location (page draws, backup pool, offline stash); absent for shared, bundled and blank; carried to `puzzle-completed` via the game context.
- [ ] **Step 4: Run** the same command plus `src/analytics` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(analytics): report the photo's Unsplash id on new-game-started`

### Task 2: Candidate fetches return their cause

**Files:**
- Modify: `src/images/unsplash-display-image.ts` (new type), `src/images/index.ts`, `src/app/fetch-candidate-images.ts`, `src/ui/image-picker.ts` (consume the new shape, behavior unchanged), `src/ui/new-game-dialog.ts` and `src/app/new-game-flow.ts` (type plumbing)
- Test: `src/app/fetch-candidate-images.test.ts`, `src/ui/image-picker.test.ts`, `src/ui/new-game-dialog.test.ts`, `src/app/new-game-flow.test.ts`

**Interfaces:**
- Produces:

```ts
export type CandidateCause = 'none' | 'http-error' | 'blocked' | 'empty-page' | 'threw';
export interface CandidateFetchResult {
    candidates: CandidateImage[];          // [] when nothing to show
    cause: CandidateCause;                 // why no network photos came back; 'none' when they did
    source: 'unsplash' | 'stash' | 'none';
}
```
`fetchCandidateImages(...)` now resolves `CandidateFetchResult` (never `null`). The picker's `fetchCandidates` and the dialog's `fetchImageCandidates` resolve `CandidateFetchResult`; the picker shows its error state when `candidates.length === 0`, as before.

- [ ] **Step 1: Update tests first.** In `fetch-candidate-images.test.ts` replace `toBeNull()`/array expectations, e.g.:

```ts
expect(await fetchCandidateImages(PROXY, 'any', false, 'landscape')).toEqual({ candidates: [], cause: 'http-error', source: 'none' }); // fetchRandomPhotos → undefined
// 'blocked' → cause 'blocked'; [] → 'empty-page'; reject → 'threw'; photos → { candidates: [...], cause: 'none', source: 'unsplash' }
// stash fallback after a failure → { candidates: [stashEntry], cause: <the failure's cause>, source: 'stash' }
```
In picker/dialog/flow tests, wrap stubbed results as `{ candidates, cause: 'none', source: 'unsplash' }` and empty ones as `{ candidates: [], cause: 'http-error', source: 'none' }`.
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/app src/ui` — Expected: FAIL in those files.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — Expected: PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `refactor(images): return the cause with picker candidate fetches`

### Task 3: New Game dialog visit tracker and its five events

**Files:**
- Create: `src/app/new-game-dialog-visit.ts`, `src/app/new-game-dialog-visit.test.ts` (jsdom; observe `window.umami.track` as other tests do)
- Modify: `src/analytics/umami.ts` (types, overloads, docs), `src/analytics/umami.test.ts`

**Interfaces:**
- Consumes: Task 2 `CandidateFetchResult`.
- Produces:

```ts
export type BatchTrigger = 'open' | 'refresh' | 'options';
export type DialogOutcome = 'photo' | 'surprise' | 'blank' | 'cancel';
export interface BatchParams { imageCategory: string; vibrant: boolean; custom: boolean; orientation: Orientation }
export interface NewGameDialogVisit {
    batchStarted(trigger: BatchTrigger, params: BatchParams): (result: CandidateFetchResult) => void;
    optionChanged(setting: 'category' | 'vibrant' | 'query', from: string, to: string): void;
    thumbnailLoaded(): void;
    thumbnailFailed(slot: number, photoId: string, imageCategory: string): void;
    creditOpened(photoId: string): void;               // emits photo-credit-opened where:'picker', link:'photographer'
    offlineDownloadUsed(): void;
    closed(outcome: DialogOutcome, pickedSlot: number, final: { imageCategory: string; vibrant: boolean }): void;
}
export function createNewGameDialogVisit(opts: {
    hasPuzzle: boolean; puzzleCompleted: boolean; imageCategory: string; vibrant: boolean;
    picker: boolean; offlineDownload: boolean; now?: () => number;
}): NewGameDialogVisit;   // emits new-game-dialog-opened immediately
```
Event types in `umami.ts`: `NewGameDialogOpenedData`, `ImageCandidatesLoadedData`, `ImageOptionChangedData`, `ImageThumbnailFailedData`, `NewGameDialogClosedData`, `PhotoCreditOpenedData` — fields exactly as the spec's items 1–5 and 7.

Batch settle rules (not determined by the signature):
- `outcome`: `'abandoned'` if `closed` already ran; else `'superseded'` if a later `batchStarted` happened; else `'shown'` when `candidates.length > 0`; else `'error'` for cause `threw`/`http-error`, `'empty'` for `blocked`/`empty-page`.
- `imagePage`/`imagePagesKnown` from the first candidate's `pageDraw`, else 0/0; `photoIds` = `photoIdFromDownloadLocation` of each candidate in order, joined with `,` (unknown → empty segment).
- Only a `'shown'` batch adds to `thumbnailsOffered` and can set `firstThumbnailsMs` (first time only). `batches` counts every `batchStarted`. `refreshes` counts `trigger === 'refresh'`; `optionChanges` counts `optionChanged`. `closed` is idempotent (second call ignored).

- [ ] **Step 1: Write the failing tests**

```ts
it('reports the opening with the visit context', () => { /* createNewGameDialogVisit({...}) → track('new-game-dialog-opened', { hasPuzzle: true, puzzleCompleted: false, imageCategory: 'face', vibrant: false, picker: true, offlineDownload: true }) */ });
it('reports a shown batch with page, ids and timing', () => {
    // now: 0 at create, 100 at batchStarted, 350 at settle; candidates with pageDraw {page: 12, knownPages: 166} and downloadLocations …/photos/a1/download, …/photos/b2/download
    // → track('image-candidates-loaded', { trigger: 'open', outcome: 'shown', cause: 'none', source: 'unsplash', count: 2, ms: 250,
    //    imageCategory: 'face', vibrant: false, custom: false, orientation: 'portrait', imagePage: 12, imagePagesKnown: 166, photoIds: 'a1,b2' })
});
it('marks an earlier batch superseded when a newer one started', () => { /* start A, start B, settle A → outcome 'superseded'; settle B → 'shown' */ });
it('marks a batch abandoned when the dialog closed first, and counts it', () => {
    // start A; closed('surprise', -1, …) → closed event batches: 1, firstThumbnailsMs: -1, thumbnailsOffered: 0; settle A → outcome 'abandoned'
});
it.each([
    ['threw', 'error'], ['http-error', 'error'], ['blocked', 'empty'], ['empty-page', 'empty'],
] as const)("maps cause %s with no photos to outcome %s", (cause, outcome) => { /* … */ });
it('reports a stash-served batch as shown from the stash', () => { /* source 'stash', cause 'http-error', candidates 1 → outcome 'shown', imagePage 0 */ });
it('summarizes the visit on close', () => {
    // refresh batch shown (4), one option change, two thumbnailLoaded, one thumbnailFailed, offlineDownloadUsed, closed('photo', 2, {imageCategory:'nature', vibrant:true})
    // → new-game-dialog-closed { outcome: 'photo', openMs, firstThumbnailsMs, pickedSlot: 2, refreshes: 1, optionChanges: 1, batches: 1,
    //    thumbnailsOffered: 4, thumbnailsLoaded: 2, thumbnailsFailed: 1, offlineDownloadUsed: true, imageCategory: 'nature', vibrant: true }
});
it('ignores a second close', () => { /* two closed calls → one new-game-dialog-closed */ });
it('reports option changes, thumbnail failures and picker credit taps', () => {
    // optionChanged('query', 'none', 'custom') → image-option-changed { setting: 'query', from: 'none', to: 'custom' }
    // thumbnailFailed(3, 'a1', 'face') → image-thumbnail-failed { slot: 3, photoId: 'a1', imageCategory: 'face' }
    // creditOpened('a1') → photo-credit-opened { where: 'picker', link: 'photographer', photoId: 'a1' }
});
```
Plus one forwarding test per new event in `umami.test.ts`.
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/app/new-game-dialog-visit.test.ts src/analytics` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module, types, overloads and docs. Docs state: outcome meanings (incl. superseded/abandoned still being reported late), `cause` meanings, `photoIds` format, that `query` changes carry only `'custom'`/`'none'`, and that counts on the close event are per visit.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(analytics): track the New Game dialog visit`

### Task 4: Picker and dialog report into the visit

**Files:**
- Modify: `src/ui/image-picker.ts`, `src/ui/new-game-dialog.ts`, `src/app/new-game-flow.ts`, `src/app/bootstrap.ts` (new `currentGame` dep)
- Test: `src/ui/image-picker.test.ts`, `src/ui/new-game-dialog.test.ts`, `src/app/new-game-flow.test.ts`

**Interfaces:**
- Consumes: Task 2 result type; Task 3 `NewGameDialogVisit`, `createNewGameDialogVisit`, `BatchTrigger`.
- Produces:
  - Picker: `fetchCandidates?: (trigger: BatchTrigger) => Promise<CandidateFetchResult>`; initial load passes `'open'`, ↻ passes `'refresh'`; `ImagePicker.refresh(trigger: 'refresh' | 'options')`. New optional callbacks `onThumbnailLoad?(slot: number)`, `onThumbnailError?(slot: number, candidate: CandidateImage)`, `onCreditOpen?(candidate: CandidateImage)`. `NewGameImageChoice` photo variant gains `slot: number`.
  - Dialog options gain `analytics?: { optionChanged; thumbnailLoaded; thumbnailFailed; creditOpened; offlineDownloadUsed }` mirroring the visit's methods; `fetchImageCandidates(imageCategory, vibrant, queryOverride, trigger)`. Picture Type/Vibrant `change` → `refresh('options')` and `optionChanged('category' | 'vibrant', from, to)`; dev query input `change` → `optionChanged('query', from, to)` with `'custom'`/`'none'` (no refresh, as today). Offline download click → `offlineDownloadUsed()`.
  - `OpenNewGameDialogDeps` gains `currentGame: () => { completed: boolean } | undefined`; bootstrap passes `() => session.current()`. `openNewGameDialog` creates the visit (`picker` = proxy configured, `offlineDownload` = the offline row is offered), wraps `fetchImageCandidates` with `visit.batchStarted(trigger, { imageCategory, vibrant, custom: isCustomQuery(queryOverride), orientation })` and settles it with the result, calls `visit.closed(choice.kind, choice.kind === 'photo' ? choice.slot : -1, finalValues)` in `onSelect`, and passes `onCancel: () => visit.closed('cancel', -1, currentValues)`.

- [ ] **Step 1: Write the failing tests**

```ts
// image-picker.test.ts
it("passes 'open' on the first load and 'refresh' for ↻", /* fetchCandidates mock calls[0][0] === 'open'; click refresh → 'refresh' */);
it('reports the picked tile slot', /* click tile 2 → onPick({ kind: 'photo', photo, slot: 2 }) */);
it('reports thumbnail loads and errors by slot', /* dispatch 'load' on tile 0 img → onThumbnailLoad(0); 'error' on tile 1 img → onThumbnailError(1, candidate) */);
it('reports a credit tap without preventing navigation', /* click credit → onCreditOpen(candidate); event.defaultPrevented false */);
// new-game-dialog.test.ts
it("refreshes with 'options' and reports a Picture Type change", /* change select → fetch called with trigger 'options'; analytics.optionChanged('category', 'nature', 'face') */);
it("reports the dev query only as 'custom'/'none'", /* type 'red bikes' + change → optionChanged('query', 'none', 'custom'); no call argument contains 'red bikes' */);
it('reports an offline download tap', /* click offline-images-download → analytics.offlineDownloadUsed() */);
// new-game-flow.test.ts
it('opens a visit with the current game state', /* currentGame → { completed: true } → new-game-dialog-opened { hasPuzzle: true, puzzleCompleted: true, … } */);
it('closes the visit with the pick', /* pick tile slot 1 → new-game-dialog-closed { outcome: 'photo', pickedSlot: 1, … } */);
it('closes the visit on cancel', /* Escape → new-game-dialog-closed { outcome: 'cancel', pickedSlot: -1 } */);
it('reports each thumbnail batch', /* open → image-candidates-loaded { trigger: 'open', … } */);
```
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/ui src/app` — Expected: FAIL in those files.
- [ ] **Step 3: Implement.** Thumbnail listeners use property assignment (`img.onload`/`img.onerror`), matching the tile's existing `onclick` pattern, so reused tiles don't accumulate listeners. A loaded or failed thumbnail from a superseded batch still reports (the img is replaced, so its handlers simply never fire).
- [ ] **Step 4: Run** the full suite, lint and build — Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(analytics): report thumbnail batches, option changes and picker taps`

### Task 5: Puzzle attribution credit taps

**Files:**
- Modify: `src/ui/attribution.ts` (`createAttributionElement(attribution, onLinkOpen?: (link: 'photographer' | 'photo') => void)`), `src/app/bootstrap.ts` (`updateAttribution` passes a handler)
- Test: `src/ui/attribution.test.ts`, `src/app/bootstrap.test.ts` (if bootstrap's attribution wiring is testable there; otherwise test the handler factory)

**Interfaces:**
- Produces: bootstrap's handler emits `photo-credit-opened` `{ where: 'puzzle', link, photoId: loadGameContext(state.seed)?.imagePhotoId ?? '' }`.

- [ ] **Step 1: Write the failing tests** — clicking each link calls `onLinkOpen('photographer')` / `onLinkOpen('photo')` and leaves `defaultPrevented` false; a puzzle whose game context has `imagePhotoId: 'abc123'` reports it.
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/ui/attribution.test.ts src/app/bootstrap.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(analytics): report credit link taps on a puzzle`

### Task 6: Puzzle photo load tracking

**Files:**
- Create: `src/app/puzzle-image-load.ts`, `src/app/puzzle-image-load.test.ts`
- Modify: `src/analytics/umami.ts` (`PuzzleImageLoadedData`, overload, doc), `src/analytics/umami.test.ts`, `src/app/start-new-game.ts`, `src/app/load-shared-puzzle.ts`, `src/app/boot-sequence.ts` (optional `observePuzzleImage?` dep; shared rollback also calls optional `abandonPuzzleImage?`), `src/app/bootstrap.ts` (create the tracker, pass both deps)
- Test: plus `start-new-game.test.ts`, `load-shared-puzzle.test.ts`, `boot-sequence.test.ts`

**Interfaces:**
- Produces:

```ts
export type PuzzleImageTrigger = 'new' | 'resume' | 'shared';
export interface PuzzleImageLoadTracker {
    observe(state: GameState, trigger: PuzzleImageTrigger): void;  // abandons any pending observation first
    abandon(): void;
}
export function createPuzzleImageLoadTracker(deps: { root: ParentNode; now?: () => number }): PuzzleImageLoadTracker;
```
`observe` does nothing when `state.imageUrl` is null; otherwise it takes the first `image` element under `root` and listens once for `load`/`error`. On settle it emits `puzzle-image-loaded { outcome, ms, trigger, imageSource: classifyImageSource(state.imageUrl), imagePhotoId? }`, reading `imagePhotoId` from `loadGameContext(state.seed)` at settle time (a new game's context is written after install). `abandon` or a newer `observe` emits `outcome: 'abandoned'` for a pending observation and detaches its listeners. If no `image` element exists, emit `'failed'` immediately.

- [ ] **Step 1: Write the failing tests**

```ts
it('reports a loaded photo with its timing and source', /* render an <svg><image></svg> into root; observe(state with images.unsplash.com url, 'new'); now 0→420; dispatch 'load' → puzzle-image-loaded { outcome: 'loaded', ms: 420, trigger: 'new', imageSource: 'unsplash' } */);
it('reports a failed photo', /* dispatch 'error' → outcome 'failed' */);
it('reads the photo id from the game context at settle time', /* saveGameContext(seed, …imagePhotoId:'abc123') after observe, then 'load' → imagePhotoId 'abc123' */);
it('omits imagePhotoId when the context has none', /* … */);
it('reports a replaced puzzle as abandoned, not failed', /* observe A; observe B → A emits 'abandoned'; later 'load' on A's element emits nothing more */);
it('reports abandon() as abandoned', /* … */);
it('does nothing for a blank puzzle', /* imageUrl null → no event */);
// call sites
it("observes the new puzzle's photo after install", /* start-new-game: deps.observePuzzleImage called with (state, 'new') */);
it('observes a resumed puzzle', /* boot-sequence: (saved.state, 'resume') */);
it('observes a shared puzzle and abandons it on rollback', /* load-shared-puzzle: (state, 'shared'); persist throws → abandonPuzzleImage called */);
```
Plus the forwarding test in `umami.test.ts`.
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/app src/analytics` — Expected: FAIL.
- [ ] **Step 3: Implement.** Doc on `PuzzleImageLoadedData`: once per installed puzzle with a photo; `ms` from install to settle; `'abandoned'` when the puzzle was replaced or rolled back first; a cached photo may settle almost at once; `imagePhotoId` absent when the puzzle's game context has none (shared, bundled, and resumes of puzzles started before this release).
- [ ] **Step 4: Run** the full suite, lint and build — Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(analytics): report whether each puzzle's photo loaded`
