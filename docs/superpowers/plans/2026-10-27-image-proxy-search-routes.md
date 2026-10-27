# Image proxy search/feed/topics routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/search`, `/photos`, `/topics` and `/topics/:slug/photos` routes to the image-proxy Worker so the probe (design step 2) can measure Unsplash's paged endpoints.

**Architecture:** All routing stays in the pure `resolveUpstream(url)` in `src/worker/image-proxy.ts`. Fixed-path routes become a table of proxy path → Unsplash path + parameter allowlist, generalizing the existing `/random` branch; `/topics/:slug/photos` is matched by a slug-format regex. `handleRequest` is unchanged. The app does not call the new routes in this PR.

**Tech Stack:** TypeScript, Cloudflare Workers (wrangler), vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-image-variety-search-design.md` (step 1 only).

## Global Constraints

- Routes are additive: `/random` and `/download` behave exactly as before.
- Each new route forwards only its allowlisted parameters; `client_id` never survives.
- Slug format: `^[a-z0-9-]+$`, validated by format, not against a list.
- The Worker imports nothing and nothing imports it (pinned by the island tests).
- Repo comment policy (`CLAUDE.md`): add no comments unless category 5/6 and definitely worth it; shed claims the change falsifies.
- Run npm through fnm: `/Users/bot/homebrew/bin/fnm exec npm …` (Node from `.nvmrc`).

## Review Focus

1. A slug carrying path tricks (`..`, `%2e%2e`, `%2F`, uppercase, empty) → 404, never an upstream URL outside `/topics/<slug>/photos`.
2. Extra path segments or near-miss paths (`/topics/nature`, `/topics/nature/photos/x`, `/search/`) → 404; the topic-detail endpoint is not exposed.
3. `client_id` on any new route → dropped.
4. Parameters outside a route's allowlist (e.g. `order_by`, `content_filter`, `collections`) → dropped.
5. Existing `/random` / `/download` tests still pass unchanged.

---

### Task 1: Table-driven fixed routes: `/search`, `/photos`, `/topics`

**Files:**
- Modify: `src/worker/image-proxy.ts` (`RANDOM_PARAMS` area ~50-61, `resolveUpstream` ~159-171, header comment lines 1-7, `BASE_HEADERS` comment ~81-87)
- Test: `src/worker/image-proxy.test.ts` (`describe('resolveUpstream')`)

**Interfaces:**
- Consumes: nothing new.
- Produces: exported `SEARCH_PARAMS = ['query', 'orientation', 'page', 'per_page']`, `FEED_PARAMS = ['page', 'per_page']`, `TOPIC_LIST_PARAMS = ['page', 'per_page']` (all `readonly string[]`, exported like `RANDOM_PARAMS` so step 3's client tests can assert against them). A module-private helper `forwardParams(source: URL, target: URL, names: readonly string[]): void` that Task 2 reuses.

- [ ] **Step 1: Write the failing tests** in `describe('resolveUpstream')`, using the existing `upstreamUrl` helper:

```ts
it.each([
    ['/search', '/search/photos'],
    ['/photos', '/photos'],
    ['/topics', '/topics'],
])('routes %s to Unsplash %s', (path, upstreamPath) => {
    const url = upstreamUrl(resolveUpstream(new URL(`https://proxy.example${path}`)));
    expect(url.origin).toBe('https://api.unsplash.com');
    expect(url.pathname).toBe(upstreamPath);
});

it('forwards query, orientation, page and per_page on /search', () => {
    const url = upstreamUrl(resolveUpstream(new URL(
        'https://proxy.example/search?query=nature&orientation=portrait&page=7&per_page=30',
    )));
    expect(Object.fromEntries(url.searchParams)).toEqual({
        query: 'nature', orientation: 'portrait', page: '7', per_page: '30',
    });
});

it.each(['/photos', '/topics'])('forwards only page and per_page on %s', (path) => {
    const url = upstreamUrl(resolveUpstream(new URL(
        `https://proxy.example${path}?page=3&per_page=30&order_by=popular&query=x&orientation=portrait`,
    )));
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '3', per_page: '30' });
});

it.each(['/search', '/photos', '/topics'])('drops client_id and unlisted parameters on %s', (path) => {
    const url = upstreamUrl(resolveUpstream(new URL(
        `https://proxy.example${path}?client_id=attacker-key&collections=1&content_filter=high&username=x`,
    )));
    expect([...url.searchParams.keys()]).toEqual([]);
});

it('404s a trailing-slash variant of a route', () => {
    expect(resolveUpstream(new URL('https://proxy.example/search/'))).toEqual({
        ok: false, status: 404, message: 'Not found',
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `/Users/bot/homebrew/bin/fnm exec npm test -- src/worker/image-proxy.test.ts`
Expected: the new tests FAIL with 404 resolutions / missing exports; existing tests PASS.

- [ ] **Step 3: Implement**

Replace the `/random` branch with a lookup in a `ReadonlyMap<string, { upstreamPath: string; params: readonly string[] }>` covering `/random` (→ `/photos/random`, `RANDOM_PARAMS`), `/search`, `/photos`, `/topics`; build the target with `forwardParams`. `/download` stays as is. In the file header, replace "forwards the only two Unsplash calls the app makes" / "On `/random` only `RANDOM_PARAMS` survive the hop" with a route-count-free statement (each fixed route forwards only its allowlist); in the `BASE_HEADERS` comment drop the "neither route … (/random varies each call, /download is a usage report)" enumeration, keeping only the load-bearing reason. Keep the `RANDOM_PARAMS` doc comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `/Users/bot/homebrew/bin/fnm exec npm test -- src/worker/image-proxy.test.ts src/images/unsplash.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/image-proxy.ts src/worker/image-proxy.test.ts
git commit -m "feat(worker): add search, editorial feed and topic list routes"
```

### Task 2: `/topics/:slug/photos` route

**Files:**
- Modify: `src/worker/image-proxy.ts` (`resolveUpstream`)
- Test: `src/worker/image-proxy.test.ts`

**Interfaces:**
- Consumes: `forwardParams` from Task 1.
- Produces: exported `TOPIC_PHOTOS_PARAMS = ['page', 'per_page', 'orientation']`; module-private `TOPIC_PHOTOS_PATH = /^\/topics\/([a-z0-9-]+)\/photos$/`.

- [ ] **Step 1: Write the failing tests**

```ts
it('routes /topics/:slug/photos to the topic photo list', () => {
    const url = upstreamUrl(resolveUpstream(new URL(
        'https://proxy.example/topics/architecture-interior/photos?page=2&per_page=30&orientation=landscape&order_by=popular&client_id=k',
    )));
    expect(url.origin).toBe('https://api.unsplash.com');
    expect(url.pathname).toBe('/topics/architecture-interior/photos');
    expect(Object.fromEntries(url.searchParams)).toEqual({
        page: '2', per_page: '30', orientation: 'landscape',
    });
});

it.each([
    '/topics/Nature/photos',
    '/topics//photos',
    '/topics/a%2Fb/photos',
    '/topics/na_ture/photos',
    '/topics/nature',
    '/topics/nature/photos/extra',
    '/topics/nature/photos/',
])('404s %s', (path) => {
    expect(resolveUpstream(new URL(`https://proxy.example${path}`))).toEqual({
        ok: false, status: 404, message: 'Not found',
    });
});

it('lets no dot-segment slug reach a topic URL', () => {
    // WHATWG URL parsing treats %2e%2e as `..`, so this arrives as /photos.
    const url = upstreamUrl(resolveUpstream(new URL('https://proxy.example/topics/%2e%2e/photos')));
    expect(url.pathname).toBe('/photos');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `/Users/bot/homebrew/bin/fnm exec npm test -- src/worker/image-proxy.test.ts`
Expected: the routing test FAILS (404); the 404 cases may already pass.

- [ ] **Step 3: Implement** — after the table lookup, match `TOPIC_PHOTOS_PATH`; on a match build `${UNSPLASH_API_ORIGIN}/topics/${slug}/photos` and `forwardParams(url, target, TOPIC_PHOTOS_PARAMS)`.

- [ ] **Step 4: Run the full checks**

Run: `/Users/bot/homebrew/bin/fnm exec npm test && /Users/bot/homebrew/bin/fnm exec npm run lint && /Users/bot/homebrew/bin/fnm exec npm run build`
Expected: all tests PASS, lint clean, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/worker/image-proxy.ts src/worker/image-proxy.test.ts
git commit -m "feat(worker): add topic photos route"
```

### Task 3: Ship and smoke-test (needs the owner)

- [ ] **Step 1:** Push the branch and open a PR — only once the owner asks for it.
- [ ] **Step 2:** After the owner merges, confirm the `Deploy worker` workflow run succeeded: `gh run list --workflow deploy-worker.yml --limit 1`.
- [ ] **Step 3:** Smoke-test each route against production with `-H 'Origin: https://puzzlewise.github.io'`:
  - `/search?query=nature&orientation=landscape&per_page=30` → 200, JSON with `total`, `total_pages`, 30 `results`.
  - `/photos?per_page=30` → 200, JSON array of 30.
  - `/topics?per_page=30` → 200, JSON array with `slug` and `total_photos`.
  - `/topics/nature/photos?orientation=portrait&per_page=30` → 200, JSON array (use a slug from the `/topics` response if `nature` 404s upstream).
  - `/random?count=1` → 200 (regression).
  Expected: all as listed; `x-ratelimit-remaining` header present.
