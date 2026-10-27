# Image variety: random search pages instead of `/photos/random`

## Why

A frequent player has seen nearly every photo the app offers. Surprise me
repeated often enough that they switched to the picker, and the picker's four
thumbnails now repeat so much that they reload several times before finding
anything unseen. The goal is not "no repeat ever" but "most thumbnails are new".

Measured cause (2026-10-27, 180 draws per query through the production proxy,
`orientation=landscape&count=30`, pool estimated from collision counts):

| Query | Unique / 180 | Estimated pool |
|---|---|---|
| *(none — Any)* | 138 | ~320 |
| `vibrant colorful` | 112 | ~170 |
| `nature` | 103 | ~145 |
| `nature vibrant colorful` | 110 | ~165 |
| `animals vibrant colorful` | 108 | ~160 |

Unsplash's `/photos/random` draws from a small, slow-changing subset per query
(undocumented behavior). The picker spends 4 of ~150 per reload, so a few dozen
reloads exhaust a category.

## Goals

- Picker thumbnails and Surprise me draw from the full search result set of a
  category (thousands of photos, if Unsplash allows the depth — see Probe).
- "Any" draws from a similarly large set.
- Same Unsplash request cost per user action as today (one request per picker
  reload, one per Surprise me).

## Non-goals

- **Seen-photo memory** (localStorage history of shown IDs). Deliberately
  deferred: with a pool in the thousands, expected repeats after viewing k
  photos are ≈ k²/2N — about 8 after 400 photos at N = 10,000. Revisit only if
  the probe shows a small effective pool.
- Caching the unused remainder of a fetched page for later reloads.
- Changes to the backup pool, its harvest script, or the offline-stash storage
  format.
- Any UI change.

## Anti-goals

- More Unsplash requests per user action than today (the 1000/h budget is
  shared by every player).
- Regressing existing safety nets: blocked-photographer filtering, the backup
  pool / offline-stash fallbacks and their analytics events, download
  reporting at use time, proxy allowlisting.
- Breaking clients still running an older cached bundle: the Worker keeps
  `/random` working.

## Decided

The player prefers **variety over strict relevance**, but wants to see the
probe results before that is applied (see Probe).

Delivered in three steps, in order:

### Step 1 — Worker PR (additive)

Add two routes to `src/worker/image-proxy.ts`, following the existing pattern
(pure `resolveUpstream`, explicit param allowlist, key only in the
`Authorization` header, upstream status passed through, rate-limit headers
forwarded):

- `/search` → `GET https://api.unsplash.com/search/photos`, forwarding only
  `query`, `orientation`, `page`, `per_page`.
- `/photos` → `GET https://api.unsplash.com/photos` (editorial feed), forwarding
  only `page`, `per_page`.
- `/topics` → `GET https://api.unsplash.com/topics` (topic list, for the probe
  to discover slugs and `total_photos`), forwarding only `page`, `per_page`.
- `/topics/:slug/photos` → `GET https://api.unsplash.com/topics/:slug/photos`,
  forwarding only `page`, `per_page`, `orientation`. The slug is validated by
  format (`^[a-z0-9-]+$`), not against a list: `/search` already forwards any
  free-text query, so a slug allowlist would add no protection while forcing a
  Worker deploy to try a different topic.

`/random` and `/download` stay unchanged. Merging deploys the Worker via
`deploy-worker.yml`; the app does not call the new routes yet, so this is
invisible to players.

### Step 2 — Probe (no code shipped)

Against the deployed routes, for each category query in plain and vibrant form
plus the editorial feed, both orientations, `per_page=30`:

1. Record `total` / `total_pages` (or the `Link: rel="last"` page for
   `/photos`).
2. Fetch a middle page and the last page — do deep pages return results, or is
   there an undocumented depth cap?
3. Build contact sheets of thumbnails from page 1, a middle page and the last
   page per category, to judge off-topic drift.
4. For `/photos`: the share of each page that is landscape vs portrait.
5. Topics: list them with `total_photos`; for topics matching a category
   (e.g. nature, animals, architecture-interior, food-drink, travel, people)
   and broad ones suited to Any (e.g. wallpapers), check depth per orientation
   and build contact sheets next to the matching search's, to compare quality
   against pool size.

Report findings to the player before step 3. Decisions that hang on it:

- **Page range:** default is the full range (variety). If deep pages are badly
  off-topic, propose a cap to the player rather than applying one silently.
- **Any:** editorial feed with client-side orientation filtering, or a random
  pick across a set of broad topics (which filter by orientation upstream) —
  whichever the probe favors.
- **Categories:** search by default; a category whose topic is clearly better
  and still large enough may be sourced from its topic instead.
- **Memory:** back on the table only if the effective pool is small.

### Step 3 — App PR

Replace `/photos/random` usage in all three client consumers — picker
(`fetch-candidate-images.ts`), Surprise me (`resolve-image.ts`), offline-stash
download (`offline-stash.ts`) — with:

1. Choose a uniformly random page in `[1, totalPages]` for the
   (query, orientation) pair.
2. Fetch it (`per_page=30`), drop blocked photographers (and, for the feed,
   wrong-orientation photos), shuffle, take N (4 picker, 1 Surprise me,
   8 stash).

Each picker reload is a fresh random page. The query string is built exactly as
today (`buildImageQuery` + `resolveQueryOverride`), so custom queries and the
vibrant terms go through search too. The feed path applies only when the built
query is empty (Any without vibrant); Any + vibrant searches `vibrant colorful`.

## Left to the builder

- Where `totalPages` comes from: a per-(query, orientation) cache in
  localStorage with an expiry is the obvious shape; on an unknown count, fetch
  page 1 and use its results so the first draw costs nothing extra. Handling a
  page beyond the current total (empty `results`) without an extra request in
  the common case.
- What to do when a page yields fewer than N usable photos after filtering.
- Response parsing for search (`{ total, total_pages, results }`) vs the feed
  (bare array); confirm search results carry every field
  `parseUnsplashResponse` requires, including `links.download_location`.
- Analytics: keep `image-fetch-http-error`, `image-pool-fallback`,
  `image-stash-fallback` and `image-fetch-failed` firing in the equivalent
  situations. If `source: 'single' | 'batch'` or the "both draws landed on a
  blocked photographer" `blocked` cause stops matching reality, adjust the
  values and keep `src/analytics/umami.ts`'s doc comments accurate.
- Removing the client's now-unused random-photo code (the Worker route stays).
- Tests for the new Worker routes' allowlists and for page selection.

## Success check

Re-run the 180-draw collision probe through the new client path for `nature`,
`nature vibrant colorful` and Any: unique count should be close to 180, against
~103–138 today.
