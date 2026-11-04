/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createManifestConfig } from './src/pwa/manifest.js';

const BASE_PATH = process.env.VITE_BASE_PATH ?? '/';

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    // We use the `injectManifest` strategy (custom worker at src/pwa/sw.ts)
    // rather than `generateSW` so the worker can register its own `error` /
    // `unhandledrejection` listeners (#430). The navigation fallback — which
    // `generateSW`'s `workbox` options used to configure — now lives in the
    // worker source; this config only injects the precache manifest.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      registerType: 'prompt',
      manifest: createManifestConfig(BASE_PATH),
      // The bundled images are the floor of the offline story: a start whose
      // every other source fails (offline with an empty stash) degrades to
      // them, and vite-plugin-pwa's default globs skip .jpg — so without this
      // the last-resort fallback itself 404s on an offline load. The legacy
      // puzzle-image.jpg stays uncached: only old saves reference it, and
      // they never go through the fallback path.
      includeAssets: ['first-puzzle.jpg', 'first-puzzle-portrait.jpg'],
      // The backup-image-pool chunk is a rate-limit-only fallback: it loads via
      // a lazy import() only when the API is refusing (an online state), and its
      // images are CDN-hotlinked, so it has no offline value. Precaching would
      // push the whole fallback-only chunk to every user's SW cache for a path
      // most never hit; exclude it so the on-demand import fetches it only when
      // a rate-limit actually occurs.
      injectManifest: {
        globIgnores: ['**/backup-pool-*.js'],
      },
    }),
  ],
  // Vite's default worker build format is 'iife', which can't emit more
  // than one chunk: any dynamic import() reachable from a `new
  // Worker(new URL(...))` entry (e.g. the traced-tab generator's lazy
  // chunk, loaded by src/game/generation-worker-core.ts) gets inlined into
  // the worker's single output file instead of staying a separate,
  // on-demand chunk. That means every worker spawn — including a plain
  // classic-cut generation that never touches traced tabs — parses a
  // baked-in copy of the traced-tab dataset. 'es' lets the worker's build
  // code-split like the main thread's. Module workers are widely
  // supported; on a browser without module-worker support, per the
  // WHATWG HTML spec the script fetch/execution failure surfaces
  // asynchronously as an `error` event on the Worker (not a synchronous
  // throw from the constructor), which generate-async.ts's `error` listener
  // already turns into the synchronous main-thread fallback — so
  // there's no new failure mode to handle.
  worker: { format: 'es' },
  test: {
    // Skip any sibling git worktrees a contributor may have checked out
    // under `.worktrees/`. Without this, vitest's default discovery walks
    // into them and runs tests from *other* branches alongside this one,
    // which drifts local test counts away from CI and can mask failures.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
    // Allow palette.css / style.css to be imported as ?raw in their tests.
    css: { include: [/palette\.css/, /style\.css/] },
    setupFiles: ['src/test-helpers/vitest-setup.ts'],
  },
});
