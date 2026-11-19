# Shrink the First-Visit Precache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a first visit the service worker no longer downloads the icons or a second copy of the photo the page just loaded.

**Architecture:** `vite.config.ts` stops adding the manifest icons to the precache. A Workbox precache plugin, kept in its own testable module beside `sw.ts`, re-issues the request for the two bundled photos with `cache: 'no-cache'`, so the browser revalidates the copy it already holds. Registration timing is untouched.

**Tech Stack:** TypeScript, Vite 8, vite-plugin-pwa 2 (`injectManifest`), workbox-precaching 7.4, Vitest 5, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-19-sw-precache-first-visit-design.md`

## Global Constraints

- Run npm through fnm so Node comes from `.nvmrc`: `/Users/bot/homebrew/bin/fnm exec npm …`. Commands below write `npm` for short.
- `src/pwa/register.ts` and `src/pwa/update-controller.ts` are not edited: registration timing does not change.
- `first-puzzle.jpg` and `first-puzzle-portrait.jpg` keep their URLs and stay precached.
- Repo comment policy (`CLAUDE.md`): at most one new comment in this change, on why the photos use `no-cache` and not `default` (Pages serves `max-age=600`). No others.
- American English in all code and comments.
- No help-text change.
- Throwaway harness files live under `/tmp/pw720/`, never in the repo.
- After any interrupted test run, check for orphaned vitest workers: `ps -Ao pid,ppid,%cpu,etime,command | awk '$2==1 && /vitest/'`.
- When browser work is done, close the Playwright tabs and stop the harness server.

## Review Focus

1. **The worker asks for the photo while the page is still downloading it** (the normal first visit on a slow link): one full download, not two. Browser check A in Task 3, run under the throttle.
2. **A deploy changes a photo within ten minutes of the browser caching the old one:** the precache must hold the new bytes. Browser check C in Task 3.
3. **A precache miss at runtime for a photo requested by an `<img>`** (a `no-cors` request reaches the plugin): the plugin must not throw. Unit test in Task 2.
4. **The preview deployment under `/dev/`:** the plugin matches `/dev/first-puzzle.jpg` and leaves the root deployment's `/first-puzzle.jpg` alone. Unit test in Task 2.
5. **Installing the app with the icons out of the precache:** `manifest.webmanifest` still lists the icons and both files are still deployed. Build check in Task 1.

---

### Task 1: Stop precaching the manifest icons

**Files:**
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: `BUNDLED_IMAGE_URL`, `BUNDLED_PORTRAIT_IMAGE_URL` from `src/app/bundled-image.ts`.
- Produces: `/tmp/pw720/dist-before/`, the build of the branch point, for Task 3's comparison.

- [ ] **Step 1: Keep a build of the unchanged code**

Run: `npm run build && rm -rf /tmp/pw720/dist-before && mkdir -p /tmp/pw720 && cp -R dist /tmp/pw720/dist-before`
Expected: build succeeds; `grep -o '{"revision":[^}]*}' /tmp/pw720/dist-before/sw.js` lists the precache entries, including `icon-192.png` and `icon-512.png`. Note the count.

- [ ] **Step 2: Edit the `VitePWA` options in `vite.config.ts`**

Add `includeManifestIcons: false`. Replace the two string literals in `includeAssets` with `BUNDLED_IMAGE_URL` and `BUNDLED_PORTRAIT_IMAGE_URL`, imported from `./src/app/bundled-image.js`.

- [ ] **Step 3: Build and check the precache manifest**

Run: `npm run build && grep -o '{"revision":[^}]*}' dist/sw.js`
Expected: two entries fewer than Step 1. Neither `icon-192.png` nor `icon-512.png`; both `first-puzzle.jpg` and `first-puzzle-portrait.jpg`; `manifest.webmanifest` still present.

Run: `ls dist/icon-192.png dist/icon-512.png && grep -c 'icon-512.png' dist/manifest.webmanifest`
Expected: both files exist; count is 1 or more.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "perf(pwa): stop precaching the manifest icons"
```

Body: the browser fetches manifest icons itself at install; precaching them cost 329 KB on a first visit (#720).

---

### Task 2: Revalidate the bundled photos

**Files:**
- Create: `src/pwa/bundled-photo-revalidation.ts`
- Test: `src/pwa/bundled-photo-revalidation.test.ts`
- Modify: `src/pwa/sw.ts`

**Interfaces:**
- Consumes: `BUNDLED_IMAGE_URL`, `BUNDLED_PORTRAIT_IMAGE_URL` from `src/app/bundled-image.ts`; `addPlugins` from `workbox-precaching`.
- Produces:

```ts
export function createBundledPhotoRevalidation(base: string): {
    requestWillFetch: (options: { request: Request }) => Promise<Request>;
};
```

`base` is `import.meta.env.BASE_URL` (`/` or `/dev/`). The module must compile under both the DOM and WebWorker libs, like `stash-image-handler.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/pwa/bundled-photo-revalidation.test.ts`, using real `Request` objects (Vitest's node environment has them):

```ts
const ORIGIN = 'https://puzzlewise.github.io';

it.each(['first-puzzle.jpg', 'first-puzzle-portrait.jpg'])(
    'revalidates %s',
    async (file) => {
        const request = new Request(`${ORIGIN}/${file}`, { cache: 'reload', credentials: 'same-origin' });
        const result = await createBundledPhotoRevalidation('/').requestWillFetch({ request });
        expect(result.url).toBe(request.url);
        expect(result.cache).toBe('no-cache');
        expect(result.credentials).toBe('same-origin');
    },
);

it('matches the photos under a non-root base', async () => {
    const plugin = createBundledPhotoRevalidation('/dev/');
    const inBase = new Request(`${ORIGIN}/dev/first-puzzle.jpg`, { cache: 'reload' });
    const sibling = new Request(`${ORIGIN}/first-puzzle.jpg`, { cache: 'reload' });
    expect((await plugin.requestWillFetch({ request: inBase })).cache).toBe('no-cache');
    expect(await plugin.requestWillFetch({ request: sibling })).toBe(sibling);
});

it.each(['index.html', 'manifest.webmanifest', 'puzzle-image.jpg', 'assets/first-puzzle.jpg'])(
    'returns the request for %s untouched',
    async (path) => {
        const request = new Request(`${ORIGIN}/${path}`, { cache: 'reload' });
        expect(await createBundledPhotoRevalidation('/').requestWillFetch({ request })).toBe(request);
    },
);

it('accepts a no-cors photo request', async () => {
    const request = new Request(`${ORIGIN}/first-puzzle.jpg`, { mode: 'no-cors' });
    const result = await createBundledPhotoRevalidation('/').requestWillFetch({ request });
    expect(result.cache).toBe('no-cache');
    expect(result.mode).toBe('no-cors');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/pwa/bundled-photo-revalidation.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createBundledPhotoRevalidation` in `src/pwa/bundled-photo-revalidation.ts`**

Match on `new URL(request.url).pathname` being exactly `base` + one of the two constants. A match returns `new Request(request, { cache: 'no-cache' })`; anything else returns the request it was given.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/pwa/bundled-photo-revalidation.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire it into `src/pwa/sw.ts`**

Call `addPlugins([createBundledPhotoRevalidation(base)])` before `precacheAndRoute(self.__WB_MANIFEST)`; the existing `const base = import.meta.env.BASE_URL` moves above both.

- [ ] **Step 6: Full checks**

Run: `npm run build && npm run lint && npm test`
Expected: all pass (the build type-checks `sw.ts` through `tsconfig.sw.json`).

- [ ] **Step 7: Commit**

```bash
git add src/pwa/bundled-photo-revalidation.ts src/pwa/bundled-photo-revalidation.test.ts src/pwa/sw.ts
git commit -m "perf(pwa): revalidate the bundled photos instead of re-downloading them"
```

Body: Workbox fetches revisioned precache entries with `cache: 'reload'`, so the photo the page had just loaded was downloaded again (#720).

---

### Task 3: Verify in Chromium and measure

No repo changes. Results go into the report to Adrian and later the PR description.

**Harness (under `/tmp/pw720/`):** a small Node static server taking a directory and a port, which behaves like GitHub Pages where it matters:

- `ETag` on every response, `Cache-Control: max-age=600`, and a bodiless 304 when `If-None-Match` matches;
- an optional shared bandwidth cap across all responses together (one token bucket, not per connection), set by an environment variable;
- one log line per response: milliseconds since the server started, status, body bytes sent, path, `Sec-Fetch-Dest`, `Referer`.

A request whose `Referer` ends in `/sw.js` came from the worker. Drive Chromium through the Playwright tools, with a fresh browser context per run (no HTTP cache, no storage, no worker), viewport 412×892 so the first puzzle uses `first-puzzle-portrait.jpg`.

- [ ] **Step 1: Check A, one download of the page's photo**

Serve `dist` with the cap at 200 KB/s. Load the app in a fresh context and wait until the worker is active.
Expected in the server log: exactly one 200 for `/first-puzzle-portrait.jpg` (from the page) and one 304 for it (from the worker); one 200 for `/first-puzzle.jpg` (worker); no request for either icon from the worker.
Repeat without the cap. Same expectation.

**If the worker's request for the portrait photo returns 200 with a full body in either run, stop.** Report the log to Adrian; do not try another mechanism.

- [ ] **Step 2: Check B, the precache holds the photo**

In the page from Step 1, read both photos back from the `workbox-precache-v2-…` cache.
Expected: blob sizes 351163 (`first-puzzle-portrait.jpg`) and 290376 (`first-puzzle.jpg`).

- [ ] **Step 3: Check C, a changed photo is picked up at once**

In a copy of `dist`, append one byte to `first-puzzle-portrait.jpg` and change that entry's revision string in `sw.js`. Point the server at the copy without restarting the browser context and reload within ten minutes of Step 1.
Expected: the new worker installs, the log shows a 200 for the photo from the worker, and the new precache entry is 351164 bytes.

- [ ] **Step 4: Check D, offline fallback**

With the worker from Step 1 in control, clear `localStorage`, take the context offline and reload. Do it at 412×892 and at 1280×800.
Expected: the first puzzle appears with its photo both times (screenshot), and no network request succeeds.

- [ ] **Step 5: Measure the first-visit timeline, before and after**

Cap at 200 KB/s. Three fresh-context loads of `/tmp/pw720/dist-before` and three of `dist`, alternating. From each run's log record:

- `photoDone`: when the page's request for `first-puzzle-portrait.jpg` finished, relative to the request for `/`;
- the bytes sent on worker requests that started before `photoDone`;
- the total bytes sent on worker requests.

Report the median of each for before and after, and the difference in `photoDone`. That difference, and what the worker still downloads before `photoDone`, is the evidence for or against deferring registration.

- [ ] **Step 6: Clean up**

Close the Playwright tabs, stop the server, and check nothing is left listening on the harness port.

---

### Task 4: Re-encode `icon-512.png`

**Files:**
- Modify: `public/icon-512.png` (only with Adrian's go-ahead)

- [ ] **Step 1: Produce candidates outside the repo**

In `/tmp/pw720/icon/`: a lossless recompression at maximum effort, and a 256-color palette version with dithering. Both must stay 512×512 PNG with no transparency. Record each file's size against the current 273573 bytes.

- [ ] **Step 2: Build a side-by-side**

One PNG showing the current icon and each candidate at 1×, and below them a 3× nearest-neighbor crop of the same two regions from each: the top-left background gradient and the glow around the piece's edge.

- [ ] **Step 3: Show Adrian and wait**

Show the side-by-side with the three sizes. Recommend the smallest candidate that shows no visible banding; if neither qualifies, recommend leaving the file alone.

- [ ] **Step 4: Apply the choice**

If Adrian picks a candidate: copy it over `public/icon-512.png`, run `npm run build`, and commit:

```bash
git add public/icon-512.png
git commit -m "perf(pwa): re-encode the 512px icon"
```

If Adrian picks neither, nothing is committed and the task is done.
