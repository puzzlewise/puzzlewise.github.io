/**
 * Custom service worker (Workbox `injectManifest`). Instrumenting the worker's
 * own scope (#430) needs real `self.addEventListener` handlers, so this file
 * IS the worker and the build only injects the precache manifest at
 * `self.__WB_MANIFEST`. It must reproduce what `generateSW` gave for free:
 * precache + cleanup, the SPA navigation fallback, and the `prompt`-mode
 * skip-waiting handshake. Keep it thin — the
 * testable error logic lives in `sw-error-reporter.ts`.
 */

import {
    precacheAndRoute,
    cleanupOutdatedCaches,
    createHandlerBoundToURL,
    type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { createSwErrorReporter } from './sw-error-reporter.js';
import { createStashImageHandler, isStashImageRequest } from './stash-image-handler.js';
import { appNavigationAllowlist } from './navigation-allowlist.js';

// Workbox replaces `self.__WB_MANIFEST` at build time (its configured
// injectionPoint), so the string must appear verbatim — don't rename `self`.
declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// The generateSW build set `cleanupOutdatedCaches`; preserve that.
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// The app's only URL is its base, with state in the query or hash. Every other
// path goes to the network, since it may be a sibling deployment on the same
// origin (e.g. /dev/ when we're /).
const base = import.meta.env.BASE_URL;
registerRoute(
    new NavigationRoute(createHandlerBoundToURL(`${base}index.html`), {
        allowlist: [appNavigationAllowlist(base)],
    }),
);

// Cache-first keeps a stashed photo's real CDN URL loadable offline, which is
// what lets saves and share links treat it like any other Unsplash image; a
// miss is a plain network fetch, so unstashed CDN traffic is unaffected.
registerRoute(
    ({ url }) => isStashImageRequest(url),
    createStashImageHandler(self.caches),
);

// `registerType: 'prompt'`: never activate a waiting worker on our own.
// `updateSW(true)` posts `{type: 'SKIP_WAITING'}` once the page commits to
// reloading (pwa/update-controller.ts); only then do we take over.
self.addEventListener('message', (event) => {
    if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') {
        void self.skipWaiting();
    }
});

// #430: report failures in the worker's own scope, which the page's window
// listeners can't see; the page bridge relays each to analytics.
//
// Only the global `error`/`unhandledrejection` events are covered — synchronous
// throws and unhandled rejections. Failures the platform routes elsewhere (a
// `respondWith` rejection, a `waitUntil` rejection) surface as the event's own
// failure, not here — don't read absent sw-error/sw-rejection events as proof
// those paths are healthy.
//
// Best-effort: with no window client open, `matchAll` returns empty and the
// report is dropped, since only the page can call `track()`.
const reporter = createSwErrorReporter({
    post: (report) => {
        void self.clients
            .matchAll({ includeUncontrolled: true, type: 'window' })
            .then((clients) => {
                for (const client of clients) client.postMessage(report);
            });
    },
});
self.addEventListener('error', (event) => {
    reporter.report('sw-error', event.error, event.message);
});
self.addEventListener('unhandledrejection', (event) => {
    reporter.report('sw-rejection', event.reason);
});
