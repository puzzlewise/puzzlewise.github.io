# Shrink the service worker's first-visit precache

Issue: #720. Background: #685 (performance audit).

## Intent

A first visit is the app's first impression. On that visit the service worker
registers on window `load` and precaches 1.15 MB while the first puzzle's photo
and generation code are still downloading. 970 KB of it is images:

| Entry | Size |
| --- | --- |
| `first-puzzle-portrait.jpg` | 351 KB |
| `first-puzzle.jpg` | 290 KB |
| `icon-512.png` | 274 KB |
| `icon-192.png` | 55 KB |

Workbox fetches every entry that carries a revision with `cache: 'reload'`
(`workbox-precaching/PrecacheController.js:103`), so the bundled photo the page
has just loaded is downloaded a second time.

Cut what the worker downloads on a first visit, without changing when it
registers.

## Goals

- The icons are not precached.
- The bundled photo the page already loaded is not downloaded again by the
  worker.
- Both bundled photos stay precached: they are the offline fallback.

## Non-goals

- Deferring registration. It is the only part of the issue's proposal with a
  serious failure mode (a worker that never registers on some path means no
  offline and no updates, silently). Revisit only if the measurement below shows
  the remaining download still delays the first puzzle.
- Renaming the bundled photos to hashed filenames. Saves and share links store
  `first-puzzle.jpg` as a URL, so it has to stay stable.
- The manifest listing `icon-512.png` twice (`any` and `maskable`). The precache
  already holds it once.

## Anti-goals

- A photo cached under a new revision but holding the previous deploy's bytes.
- A worker install that fails where it succeeds today.

## Approaches

1. **Defer registration until the first photo has loaded** (the issue's
   proposal). Removes all contention, but adds a "not registered yet" state and
   several triggers that each have to be wired correctly; the renderer-failed
   path and the share-link rescue need the worker and may never load a photo. It
   also only helps first visits: on a return visit the browser installs an
   update on navigation, whenever `registerSW` is called.
2. **Precache less, register as today** (chosen). Drop the icons and let the
   photos come from the HTTP cache. One config line and a small plugin. Expected
   to remove about two thirds of the contending image bytes; the photo for the
   other orientation (290–351 KB) still downloads alongside the first puzzle.
3. **Both.** Deferred until approach 2 has been measured.

Adrian picked approach 2, with approach 1 to follow only if the measurement
calls for it.

## Design

- **Icons:** `includeManifestIcons: false` in `vite.config.ts`. The browser
  fetches manifest icons itself when it installs the app.
- **Photos:** a Workbox precache plugin in `src/pwa/sw.ts` whose
  `requestWillFetch` re-issues the request for the two bundled photos with
  `cache: 'no-cache'`. The browser then revalidates against GitHub Pages
  (which sends an `ETag`), gets a 304 for a copy it already holds, and takes the
  body from the HTTP cache. `no-cache` rather than `default`: Pages serves
  `max-age=600`, and `default` could store a pre-deploy copy under the new
  revision for up to ten minutes after a deploy.
- **`icon-512.png`:** try a smaller encoding. Adrian compares old and new side by
  side before it is committed; if the new one looks worse the file stays as it
  is. With the icons out of the precache its size only matters at install time.

## Verification

- A production build's precache manifest lists neither icon and still lists
  both photos.
- First visit in Chromium against a server that mimics Pages (`ETag`,
  `max-age=600`): the worker's request for the photo the page loaded transfers
  headers only, and the photo is in the precache afterwards.
- With the worker installed and the network off, a start that falls back to the
  bundled photo still shows it, in both orientations.
- Record the first-visit timeline before and after (when the photo finishes,
  what the worker downloads meanwhile). That measurement decides whether
  deferred registration is worth its complexity.

## Left to the builder

- The plugin's shape and how it recognises the two photos, as long as the list
  of bundled photos has one source.
- Which tool re-encodes the icon.
