# Image analytics events (#674)

## Why

Nothing is logged between opening the New Game dialog and `new-game-started`,
and nothing about the puzzle photo after it starts. Questions like "how often do
players reload thumbnails before picking?", "do they see repeats?", or "did
that puzzle's photo ever load?" are unanswerable.

The owner's guideline: answer as many future questions as possible. Text logs
are cheap; **when in doubt, log**, and log each action as it happens. Cut back
only if logging is ever shown to slow the app. Never log images or
player-typed text.

## Goals

The eight events agreed in #674, specified below, with operator-facing doc
comments in `src/analytics/umami.ts` (repo `CLAUDE.md`: those docs are the
query spec and must stay accurate).

## Non-goals

- Events for non-image dialog options (size, cut style, rotation): already on
  `new-game-started`.
- Any UI or behavior change.
- Logging the dev search box's text (only whether it is in use).

## Anti-goals

- An extra network fetch of a photo just to measure it.
- Player-typed text, or image bytes, reaching Umami.
- Breaking existing event payloads or the game-context record that carries
  `new-game-started`'s fields onto `puzzle-completed`.

## Decided

**Photo ID.** The Unsplash photo ID is read from a photo's
`downloadLocation` (`https://api.unsplash.com/photos/<id>/download…`), which
fresh draws, backup-pool records and offline-stash entries all carry. No
stored shape changes. Bundled and blank puzzles have none: the field is
omitted.

**Events** (names and fields are binding; every field always present on new
rows unless marked optional):

1. `new-game-dialog-opened` — `hasPuzzle: boolean`, `puzzleCompleted: boolean`,
   `imageCategory: string`, `vibrant: boolean`, `picker: boolean` (thumbnails
   available, i.e. a proxy is configured), `offlineDownload: boolean` (the
   offline-download row is offered).
2. `image-candidates-loaded` — one per thumbnail batch, when it settles:
   `trigger: 'open' | 'refresh' | 'options'`;
   `outcome: 'shown' | 'empty' | 'error' | 'superseded' | 'abandoned'`
   (superseded = a newer batch started before this one settled; abandoned =
   the dialog closed before it settled; both still reported when it settles);
   `cause: 'none' | 'http-error' | 'blocked' | 'empty-page' | 'threw'` — why no
   network photos came back (`'none'` when they did). `fetchCandidateImages`
   must return this cause alongside its result instead of a bare `null`;
   `error` = `threw` or `http-error`, `empty` = `blocked` or `empty-page` with
   no stash fallback *(builder-check call)*;
   `source: 'unsplash' | 'stash' | 'none'` (stash = the offline-stash fallback
   served the batch; candidates without a `pageDraw` are stash);
   `count: number` (thumbnails offered); `ms: number`;
   `imageCategory`, `vibrant`, `custom: boolean`, `orientation`;
   `imagePage: number`, `imagePagesKnown: number` (from the candidates'
   `pageDraw`; 0 and 0 when none); `photoIds: string` (comma-separated, in
   tile order; `''` when none).
3. `image-option-changed` — `setting: 'category' | 'vibrant' | 'query'`;
   `from: string`, `to: string` (category ids; `'true'`/`'false'` for vibrant;
   `'custom'`/`'none'` for the dev query, never its text). Fires on the
   control's `change` event.
4. `image-thumbnail-failed` — a thumbnail `<img>` errored (thumbnails get
   load and error listeners; loads feed `thumbnailsLoaded`): `slot: number`
   (0-based tile), `photoId: string`, `imageCategory: string`.
5. `new-game-dialog-closed` —
   `outcome: 'photo' | 'surprise' | 'blank' | 'cancel'`; `openMs: number`;
   `firstThumbnailsMs: number` (open → first batch shown; -1 if never);
   `pickedSlot: number` (-1 unless `photo`); `refreshes: number` (↻ taps);
   `optionChanges: number`; `batches: number` (started, including any still
   loading at close); `thumbnailsOffered: number` (tiles filled with a
   candidate); `thumbnailsLoaded: number` (thumbnail `<img>` loads that
   completed); `thumbnailsFailed: number`; `offlineDownloadUsed: boolean`;
   `imageCategory`, `vibrant` (final values).
6. `new-game-started` gains optional `imagePhotoId: string` for fresh games
   whose photo has a `downloadLocation` (page draws, pool, stash; absent for
   shared, bundled, blank). Register it in `game-context.ts`'s `FIELD_TYPES` so
   it rides onto `puzzle-completed` like the other image fields.
7. `photo-credit-opened` — `where: 'picker' | 'puzzle'`,
   `link: 'photographer' | 'photo'`, `photoId: string` (`''` when unknown).
   Fires on the link's click; never prevents navigation.
8. `puzzle-image-loaded` — once per installed puzzle with a photo:
   `outcome: 'loaded' | 'failed' | 'abandoned'` (abandoned = the puzzle was
   replaced or uninstalled before its photo settled, so abandonment never
   counts as a load failure *(builder-check call)*), `ms: number` (install →
   settle, or → abandonment),
   `trigger: 'new' | 'resume' | 'shared'`, `imageSource: string` (same
   classification as `new-game-started`), `imagePhotoId?: string`. Observe
   one of the puzzle's existing `<image>` elements (or equivalent
   already-issued request); do not fetch the photo again.

## Left to the builder

- Where the dialog-visit counters live (a small per-visit tracker object
  passed into the picker and dialog is the obvious shape) and how
  `hasPuzzle`/`puzzleCompleted` reach `openNewGameDialog` (bootstrap owns the
  session).
- How `trigger` reaches the picker's `refresh()` (open vs ↻ vs option change).
- Which element `puzzle-image-loaded` observes and where install points hook
  in, as long as each installed puzzle reports once and nothing is refetched.
  A puzzle whose photo is already cached may settle almost instantly; that is
  fine.
- Test structure; every new event needs a typed `track` overload, a forwarding
  test in `umami.test.ts`, and doc comments.
