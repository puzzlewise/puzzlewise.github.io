# Image variety: random pages in the app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Picker thumbnails, Surprise me and the offline-stash download draw from a random page of Unsplash search or topic results instead of `/photos/random`.

**Architecture:** A new `fetchRandomPhotos` in `src/images/unsplash.ts` picks a source (search for a non-empty query, a random large topic for Any), picks a random page within a per-(source, orientation) page count cached in localStorage, fetches it through the proxy's `/search` or `/topics/:slug/photos` route, drops blocked photographers, shuffles and returns `count` photos. The three consumers swap their `/random` calls for it; the old client random-photo code is deleted (the Worker's `/random` route stays for old bundles).

**Tech Stack:** TypeScript, vitest (jsdom for localStorage), Vite.

**Spec:** `docs/superpowers/specs/2026-10-27-image-variety-search-design.md` (step 3), as amended by the post-probe decisions below.

## Post-probe decisions (binding; they supersede the spec where they differ)

Probe results (2026-10-27, before the probe was stopped): plain category searches report ~10,000 results / ~334 pages, vibrant ones 950–5,500, but the last reported page of the large searches came back empty while page ~167 (~5,000 results deep) returned a full page. Topic photo lists delivered to their last page; `x-total` on `/topics/:slug/photos?orientation=…` is the orientation-filtered count. The probe triggered a key-wide Unsplash 403 and was stopped; **no further probing** — nothing in this plan may send bursts to the proxy.

- Search: usable pages = `min(total_pages − 1, 166)`, at least 1.
- Topic: usable pages = `ceil(x-total / 30) − 1`, at least 1.
- Any (built query empty) → uniformly random topic from `ANY_TOPICS`; Any + vibrant → search `vibrant colorful` (query built as today). The editorial feed is not used.
- A 200 response with zero photos on page > 1 lowers that key's cached count to `page − 1` and retries once on a page within the new count. Non-2xx responses never change the cache (a rate-limit or key-block 403 must not collapse variety).
- No seen-photo memory. The spec's 180-draw success check is dropped.

## Global Constraints

- `per_page=30` on every page request.
- One request per user action in the common case; the empty-page retry is the only second request.
- localStorage key `puzzle-image-page-counts`; TTL 7 days; at most 64 entries (evict oldest).
- `ANY_TOPICS = ['nature', 'architecture-interior', 'wallpapers', 'textures-patterns', 'travel', 'animals', 'street-photography', 'film', 'people', 'experimental']`.
- `SEARCH_PAGE_CAP = 166`.
- Client emits only parameters in the Worker's `SEARCH_PARAMS` / `TOPIC_PHOTOS_PARAMS`.
- Repo `CLAUDE.md`: comment policy (no category 1–4 comments; shed claims a change falsifies); keep `src/analytics/umami.ts` doc comments accurate; `src/worker/image-proxy.ts` must not be imported by shipped modules (tests may import it).
- npm via fnm: `/Users/bot/homebrew/bin/fnm exec npm …`.

## Review Focus

1. localStorage throws on read or write (private mode, quota) → photos still load; every draw just uses page 1.
2. Corrupt or wrong-shape cache JSON → treated as empty, overwritten on next write.
3. A query with no results (custom query nonsense) → page 1 empty → `[]` returned, no retry loop, consumers take their existing empty paths.
4. A non-2xx answer on a deep page → `undefined`, cache untouched.
5. Surprise me's `AbortSignal` reaches every fetch, including the retry.

---

### Task 1: Page-count cache

**Files:**
- Create: `src/images/page-count-cache.ts`
- Test: `src/images/page-count-cache.test.ts` (`@vitest-environment jsdom`)

**Interfaces:**
- Produces: `PAGE_COUNT_CACHE_KEY = 'puzzle-image-page-counts'`, `PAGE_COUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000`, `MAX_PAGE_COUNT_ENTRIES = 64`; `getPageCount(key: string, now?: number): number | undefined`; `setPageCount(key: string, pages: number, now?: number): void` (`now` defaults to `Date.now()`). Stored shape: `{ v: 1, entries: Record<string, { pages: number; at: number }> }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns undefined for an unknown key', () => expect(getPageCount('search:nature|landscape')).toBeUndefined());
it('round-trips a stored count', () => { setPageCount('k', 166, 1000); expect(getPageCount('k', 2000)).toBe(166); });
it('expires an entry after the TTL', () => { setPageCount('k', 5, 0); expect(getPageCount('k', PAGE_COUNT_TTL_MS + 1)).toBeUndefined(); });
it('evicts the oldest entry beyond MAX_PAGE_COUNT_ENTRIES', () => {
    for (let i = 0; i <= MAX_PAGE_COUNT_ENTRIES; i++) setPageCount(`k${i}`, 2, i);
    expect(getPageCount('k0', MAX_PAGE_COUNT_ENTRIES)).toBeUndefined();
    expect(getPageCount(`k${MAX_PAGE_COUNT_ENTRIES}`, MAX_PAGE_COUNT_ENTRIES)).toBe(2);
});
it('treats corrupt JSON as empty and overwrites it', () => {
    localStorage.setItem(PAGE_COUNT_CACHE_KEY, '{nope');
    expect(getPageCount('k')).toBeUndefined();
    setPageCount('k', 3, 0);
    expect(getPageCount('k', 0)).toBe(3);
});
it('treats a wrong-shape record as empty', () => {
    localStorage.setItem(PAGE_COUNT_CACHE_KEY, JSON.stringify({ v: 1, entries: { k: { pages: 'x', at: 0 } } }));
    expect(getPageCount('k', 0)).toBeUndefined();
});
it('survives localStorage throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => setPageCount('k', 3)).not.toThrow();
    expect(getPageCount('k')).toBeUndefined();
});
```
(`beforeEach`: `localStorage.clear()`, `vi.restoreAllMocks()`.)

- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/images/page-count-cache.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** in `src/images/page-count-cache.ts`. A wrong-shape individual entry is dropped, not the whole record.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(images): cache per-source page counts`

### Task 2: Photo source, page URL and page parsing

**Files:**
- Create: `src/images/photo-source.ts`
- Test: `src/images/photo-source.test.ts`

**Interfaces:**
- Consumes: `parseUnsplashResponse` from `src/images/unsplash.ts`; type `Orientation`.
- Produces:
  - `type PhotoSource = { kind: 'search'; query: string } | { kind: 'topic'; slug: string }`
  - `ANY_TOPICS`, `SEARCH_PAGE_CAP = 166`, `PER_PAGE = 30`
  - `pickPhotoSource(query: string | undefined, random: () => number): PhotoSource` — empty/whitespace/undefined query → topic `ANY_TOPICS[floor(random() * length)]`; otherwise search with the query as given.
  - `usablePages(source: PhotoSource, reportedPages: number): number`
  - `pageCacheKey(source: PhotoSource, orientation: Orientation): string` → `search:<query>|<orientation>` / `topic:<slug>|<orientation>`
  - `buildPageUrl(proxyBaseUrl: string, source: PhotoSource, orientation: Orientation, page: number): string` → `${proxy}/search?query&orientation&page&per_page=30` or `${proxy}/topics/${slug}/photos?orientation&page&per_page=30`
  - `parsePage(source: PhotoSource, body: unknown, headers: Headers): { photos: UnsplashImageResult[]; reportedPages: number | undefined }` — search: `body.results`, `body.total_pages`; topic: array body, `ceil(x-total / 30)`, `undefined` when the header is absent or non-numeric. Throws `Error('Invalid Unsplash API response')` on a body of the wrong shape (array expected but object given, or vice versa).

- [ ] **Step 1: Write the failing tests**

```ts
it('uses search for a query and a topic for no query', () => {
    expect(pickPhotoSource('nature vibrant colorful', () => 0)).toEqual({ kind: 'search', query: 'nature vibrant colorful' });
    expect(pickPhotoSource(undefined, () => 0)).toEqual({ kind: 'topic', slug: 'nature' });
    expect(pickPhotoSource('  ', () => 0.999)).toEqual({ kind: 'topic', slug: ANY_TOPICS[ANY_TOPICS.length - 1] });
});
it.each([
    [{ kind: 'search', query: 'q' }, 334, 166],
    [{ kind: 'search', query: 'q' }, 38, 37],
    [{ kind: 'search', query: 'q' }, 1, 1],
    [{ kind: 'search', query: 'q' }, 0, 1],
    [{ kind: 'topic', slug: 'nature' }, 1160, 1159],
    [{ kind: 'topic', slug: 'nature' }, 1, 1],
] as const)('usablePages(%o, %i) = %i', (source, reported, expected) => {
    expect(usablePages(source, reported)).toBe(expected);
});
it('builds URLs the Worker routes, with only forwarded parameters', () => {
    const search = new URL(buildPageUrl(PROXY, { kind: 'search', query: 'face' }, 'portrait', 7));
    expect(search.pathname).toBe('/search');
    expect([...search.searchParams.keys()].sort()).toEqual([...SEARCH_PARAMS].sort());
    expect(search.searchParams.get('per_page')).toBe('30');
    const topic = new URL(buildPageUrl(PROXY, { kind: 'topic', slug: 'film' }, 'landscape', 3));
    expect(topic.pathname).toBe('/topics/film/photos');
    expect([...topic.searchParams.keys()].sort()).toEqual([...TOPIC_PHOTOS_PARAMS].sort());
    for (const url of [search, topic]) expect(resolveUpstream(url).ok).toBe(true);
});
it('reads total_pages from a search body', () => {
    const r = parsePage({ kind: 'search', query: 'q' }, { total: 900, total_pages: 30, results: [PHOTO] }, new Headers());
    expect(r.reportedPages).toBe(30);
    expect(r.photos).toHaveLength(1);
});
it('derives topic pages from x-total', () => {
    expect(parsePage(TOPIC, [PHOTO], new Headers({ 'x-total': '17898' })).reportedPages).toBe(597);
    expect(parsePage(TOPIC, [PHOTO], new Headers()).reportedPages).toBeUndefined();
});
it('rejects a body of the wrong shape', () => {
    expect(() => parsePage(TOPIC, { results: [] }, new Headers())).toThrow('Invalid Unsplash API response');
});
```
(`PHOTO` is a minimal valid Unsplash photo object as in `unsplash.test.ts`; `PROXY = 'https://proxy.example'`; `SEARCH_PARAMS`, `TOPIC_PHOTOS_PARAMS`, `resolveUpstream` imported from `../worker/image-proxy.js`.)

- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/images/photo-source.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** in `src/images/photo-source.ts`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(images): pick a photo source and parse result pages`

### Task 3: `fetchRandomPhotos`

**Files:**
- Modify: `src/images/unsplash.ts` (add next to `fetchRandomImages`; old functions stay until Task 4)
- Create: `src/images/shuffled.ts` — move `shuffled` out of `src/images/offline-stash.ts` and import it from both places
- Modify: `src/analytics/umami.ts` — new `ImagePageEmptyData` + `track('image-page-empty', …)` overload, next to `ImagePoolFallbackData`
- Test: `src/images/unsplash.test.ts` (already jsdom; new `describe('fetchRandomPhotos')`; observe analytics via `window.umami.track` as the file does at ~line 477); `src/analytics/umami.test.ts` (forwarding test like the existing `image-pool-fallback` one at ~line 304)

**Interfaces:**
- Consumes: Task 1 `getPageCount`/`setPageCount`; Task 2 `pickPhotoSource`, `usablePages`, `pageCacheKey`, `buildPageUrl`, `parsePage`; existing `isBlockedPhotographerUrl`, `reportProxyHttpError`.
- Produces:

```ts
export interface PhotoRequestContext {
    caller: 'picker' | 'surprise' | 'stash';
    imageCategory: string;
    vibrant: boolean;
    custom: boolean;                // a player-typed query override is in use
}
export interface FetchRandomPhotosOptions {
    random?: () => number;          // default Math.random
    signal?: AbortSignal;
}
export async function fetchRandomPhotos(
    proxyBaseUrl: string,
    count: number,
    fetchFn: typeof fetch,
    query: string | undefined,
    orientation: Orientation,
    context: PhotoRequestContext,
    options: FetchRandomPhotosOptions = {},
): Promise<UnsplashImageResult[] | 'blocked' | undefined>
```
Resolves `undefined` on a non-2xx answer (after `reportProxyHttpError(response, caller === 'surprise' ? 'single' : 'batch')`); `'blocked'` when the final page had photos but every one was by a blocked photographer; `[]` when the final page was empty; otherwise up to `count` photos. Throws on a malformed body or a rejected fetch.

```ts
// in umami.ts
export interface ImagePageEmptyData {
    caller: 'picker' | 'surprise' | 'stash';
    imageCategory: string;
    vibrant: boolean;
    custom: boolean;
    orientation: Orientation;
    sourceKind: 'search' | 'topic';
    topic: string;          // slug for topic draws, '' for search (query text is never sent)
    page: number;           // the page that came back empty
    reportedPages: number;  // Unsplash's page count on that response; 0 when absent
    loweredTo: number;      // the new cached count (page − 1)
    retry: 'ok' | 'empty' | 'http-error' | 'threw';
}
```
Doc comment (operator-facing, keep to facts the code can't show): fires once per 200 response with zero photos on page > 1, after the one retry settles; `loweredTo` against `reportedPages` measures how far Unsplash's count overstates reachable depth; `retry` says whether the player still got photos from that request; all fields always present.

Algorithm (not determined by the signature):

```
source = pickPhotoSource(query, random); key = pageCacheKey(source, orientation)
known = getPageCount(key)
page = known === undefined ? 1 : 1 + floor(random() * known)
res = fetch page → undefined on non-2xx
if known === undefined and res.reportedPages !== undefined: setPageCount(key, usablePages(source, res.reportedPages))
if res.photos is empty and page > 1:
    setPageCount(key, page - 1)
    retry = fetch page 1 + floor(random() * (page - 1))
    track('image-page-empty', { ...context, orientation, sourceKind, topic, page,
        reportedPages: res.reportedPages ?? 0, loweredTo: page - 1,
        retry: threw ? 'threw' : retry === undefined ? 'http-error' : retry.photos.length ? 'ok' : 'empty' })
    rethrow if the retry threw; return undefined if it was non-2xx; else res = retry
usable = res.photos without blocked photographers
return res.photos nonempty and usable empty ? 'blocked' : shuffled(usable, random).slice(0, count)
```
(The cache is written only when unknown or when lowering, so a later full response can't undo a lowering.)

- [ ] **Step 1: Write the failing tests** (stub `fetchFn` with `vi.fn()` returning `new Response(JSON.stringify(body), { status, headers })`; `localStorage.clear()` in `beforeEach`):

```ts
const CTX = { caller: 'picker', imageCategory: 'nature', vibrant: false, custom: false } as const;

it('fetches page 1 when the page count is unknown, and caches the usable count', async () => {
    const fetchFn = respond(200, searchBody(30, 334));
    await fetchRandomPhotos(PROXY, 4, fetchFn, 'nature', 'landscape', CTX, { random: () => 0.5 });
    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.get('page')).toBe('1');
    expect(getPageCount('search:nature|landscape')).toBe(166);
});
it('draws a random page within the cached count', async () => {
    setPageCount('search:nature|landscape', 166);
    const fetchFn = respond(200, searchBody(30, 334));
    await fetchRandomPhotos(PROXY, 4, fetchFn, 'nature', 'landscape', CTX, { random: () => 0.5 });
    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.get('page')).toBe('84');
});
it('returns count shuffled photos without blocked photographers', async () => {
    const fetchFn = respond(200, searchBody(30, 2, { blocked: 1 }));
    const photos = await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX);
    expect(photos).toHaveLength(4);
    expect((photos as UnsplashImageResult[]).some((p) => isBlockedPhotographerUrl(p.photographerUrl))).toBe(false);
});
it("returns 'blocked' when every photo on the page is by a blocked photographer", async () => {
    const fetchFn = respond(200, searchBody(3, 2, { blocked: 3 }));
    expect(await fetchRandomPhotos(PROXY, 1, fetchFn, 'q', 'landscape', CTX)).toBe('blocked');
});
it('uses a topic for no query', async () => {
    const fetchFn = respond(200, topicBody(30), { 'x-total': '17898' });
    await fetchRandomPhotos(PROXY, 4, fetchFn, undefined, 'portrait', CTX, { random: () => 0 });
    expect(new URL(fetchFn.mock.calls[0][0]).pathname).toBe('/topics/nature/photos');
    expect(getPageCount('topic:nature|portrait')).toBe(596);
});
it('lowers the count, retries once and reports an empty deep page', async () => {
    setPageCount('search:q|landscape', 166);
    const fetchFn = respondSequence([200, searchBody(0, 334)], [200, searchBody(30, 334)]);
    const photos = await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX, { random: () => 0.5 });
    expect(getPageCount('search:q|landscape')).toBe(83);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(Number(new URL(fetchFn.mock.calls[1][0]).searchParams.get('page'))).toBeLessThanOrEqual(83);
    expect(photos).toHaveLength(4);
    expect(umamiTrack).toHaveBeenCalledWith('image-page-empty', {
        caller: 'picker', imageCategory: 'nature', vibrant: false, custom: false,
        orientation: 'landscape', sourceKind: 'search', topic: '',
        page: 84, reportedPages: 334, loweredTo: 83, retry: 'ok',
    });
});
it.each([
    ['empty', [200, searchBody(0, 334)]],
    ['http-error', [403, { errors: ['Forbidden'] }]],
] as const)("reports retry '%s' when the retry fails that way", async (retry, second) => {
    setPageCount('search:q|landscape', 166);
    const fetchFn = respondSequence([200, searchBody(0, 334)], second);
    await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', CTX, { random: () => 0.5 });
    expect(umamiTrack).toHaveBeenCalledWith('image-page-empty', expect.objectContaining({ retry }));
});
it("reports retry 'threw' and rethrows when the retry fetch rejects", async () => { /* second call rejects → promise rejects; event has retry: 'threw' */ });
it('reports a topic draw with its slug', async () => { /* topic, empty deep page → sourceKind 'topic', topic 'nature' */ });
it('does not retry or report an empty first page', async () => {
    const fetchFn = respond(200, searchBody(0, 0));
    expect(await fetchRandomPhotos(PROXY, 4, fetchFn, 'zzqx', 'landscape', CTX)).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(umamiTrack).not.toHaveBeenCalledWith('image-page-empty', expect.anything());
});
it('leaves the cache alone on an error status, tagged by caller', async () => {
    setPageCount('search:q|landscape', 166);
    const fetchFn = respond(403, { errors: ['Forbidden'] });
    expect(await fetchRandomPhotos(PROXY, 4, fetchFn, 'q', 'landscape', { ...CTX, caller: 'surprise' })).toBeUndefined();
    expect(getPageCount('search:q|landscape')).toBe(166);
    expect(umamiTrack).toHaveBeenCalledWith('image-fetch-http-error', { status: 403, source: 'single' });
});
it('passes the abort signal to every fetch, including the retry', async () => { /* empty deep page then full; both calls' init.signal === controller.signal */ });
it('still loads photos when localStorage throws', async () => { /* getItem/setItem throw → page 1, photos returned */ });
```
Plus in `umami.test.ts`: `it('forwards image-page-empty with the typed payload', …)` mirroring the `image-pool-fallback` test.

- [ ] **Step 2: Run** the test file — Expected: FAIL (`fetchRandomPhotos` not exported).
- [ ] **Step 3: Implement** `fetchRandomPhotos`, `src/images/shuffled.ts`, and the `umami.ts` event type + overload + doc; export `fetchRandomPhotos`, `PhotoRequestContext` and `FetchRandomPhotosOptions` from `src/images/index.ts`.
- [ ] **Step 4: Run** the test file plus `src/images/offline-stash.test.ts` and `src/analytics/umami.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(images): fetch random photos from a random result page`

### Task 4: Switch the consumers and remove the client's random-photo code

**Files:**
- Modify: `src/app/fetch-candidate-images.ts`, `src/app/resolve-image.ts`, `src/app/download-offline-images.ts`, `src/images/offline-stash.ts`, `src/images/unsplash.ts`, `src/images/index.ts`, `src/analytics/umami.ts` (doc comments ~630-690, `ImagePoolFallbackData.cause`)
- Test: `src/app/fetch-candidate-images.test.ts`, `src/app/resolve-image.test.ts`, `src/app/download-offline-images.test.ts` (if present), `src/images/offline-stash.test.ts`, `src/images/unsplash.test.ts`

**Interfaces:**
- Consumes: Task 3 `fetchRandomPhotos`.
- Produces: no new exports. Removed: `fetchRandomImage`, `fetchRandomImages`, `buildRandomPhotoUrl`, `PROXY_RANDOM_PATH`.

Call mapping (`ctx = { caller, imageCategory, vibrant, custom: Boolean(queryOverride?.trim()) }`; `src/app/download-offline-images.ts` already holds category, vibrant and override, so thread a `context: PhotoRequestContext` through `DownloadOfflineImagesOptions`):
- Picker: `fetchRandomPhotos(proxyBaseUrl, CANDIDATE_IMAGE_COUNT, fetchFn, query, orientation, { ...ctx, caller: 'picker' })`; `undefined`, `'blocked'` or `[]` → existing `'no-candidates'` stash path.
- Surprise me: `fetchRandomPhotos(proxyBaseUrl, 1, fetch, query, orientation, { ...ctx, caller: 'surprise' }, { signal })`; `undefined` → pool fallback `cause: 'http-error'`; `'blocked'` → `cause: 'blocked'`; `[]` → `cause: 'empty'`; else `toDisplayImage(photos[0])`.
- Offline stash: `fetchRandomPhotos(proxyBaseUrl, OFFLINE_STASH_COUNT, fetchFn, query, orientation, { ...ctx, caller: 'stash' })`; `undefined`, `'blocked'` or `[]` → existing `'batch-empty'`.

- [ ] **Step 1: Update the consumer tests first.** Re-point each `vi.mock` of `fetchRandomImages`/`fetchRandomImage` at `fetchRandomPhotos`, and assert the call arguments above, e.g. in `resolve-image.test.ts`:

```ts
expect(fetchRandomPhotos).toHaveBeenCalledWith(PROXY, 1, fetch, 'nature', 'landscape',
    { caller: 'surprise', imageCategory: 'nature', vibrant: false, custom: false }, { signal });
it.each([['blocked', 'blocked'], [[], 'empty']] as const)(
    'falls back to the pool with the matching cause when fetchRandomPhotos returns %o',
    /* → track('image-pool-fallback', expect.objectContaining({ cause })) */);
it('marks a player-typed query as custom', /* queryOverride 'lighthouse' → context.custom true */);
```
Delete the `unsplash.test.ts` tests for the removed functions, including "emits exactly the parameters the Worker forwards" for `/random` (Task 2's URL test replaces it).
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/app src/images` — Expected: FAIL in the three consumer test files.
- [ ] **Step 3: Implement** the call mapping; delete the removed functions and exports. In `umami.ts`: replace the `fetchRandomImage` mention (~line 633) with `fetchRandomPhotos`; `ImageFetchHttpErrorData` "random-photo request" → "photo request"; `ImagePoolFallbackData`: "a single random-photo request" → "a single photo request"; `'blocked'` → "the fetched page had photos but every one was by a blocked photographer (#568)"; add `'empty'` to the `cause` union, documented as "the fetched page was empty, even after the one retry; an `image-page-empty` row with `caller: 'surprise'` accompanies it unless the empty page was page 1". Change nothing else there.
- [ ] **Step 4: Run** `/Users/bot/homebrew/bin/fnm exec npm test && /Users/bot/homebrew/bin/fnm exec npm run lint && /Users/bot/homebrew/bin/fnm exec npm run build` — Expected: all PASS, lint clean, build succeeds; `git grep -n "fetchRandomImage\|buildRandomPhotoUrl\|PROXY_RANDOM_PATH" src` prints nothing.
- [ ] **Step 5: Commit** `feat(images): draw picker, Surprise me and stash photos from random pages`

### Verification after the PR is open (owner)

The PR preview deploys to `https://puzzlewise.github.io/dev/`. The owner judges variety and relevance by playing at normal pace. No scripted request bursts against the proxy.
