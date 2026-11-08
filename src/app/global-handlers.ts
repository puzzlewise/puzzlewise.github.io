/**
 * Global page-level wiring not owned by any feature. Call once, early in boot:
 * the ordering — analytics before error tracking before the service-worker
 * error bridge — puts every reporting channel up before anything that can throw.
 */

import { initAnalytics, initErrorTracking } from '../analytics/index.js';
import { initSwErrorReporting } from '../pwa/sw-error-bridge.js';

export function installGlobalHandlers(container: HTMLElement): void {
    // Suppress the context menu on the puzzle table only: on touch (esp. iPad)
    // a long-press would trigger it mid-drag. The table is created later by
    // renderer.init, so delegate from #app and check the target — context
    // menus in the help and settings modals must still reach the browser for
    // long-press copy of share links and repro params.
    container.addEventListener('contextmenu', (e) => {
        const target = e.target as Element | null;
        if (target?.closest('[data-puzzle-table]')) {
            e.preventDefault();
        }
    });

    initAnalytics();

    // Global backstop for unhandled rejections / uncaught errors. Observe-only;
    // never swallows them.
    initErrorTracking();

    // Companion backstop for the worker's scope (#430): page-realm `window`
    // listeners never see worker exceptions, so the worker posts them here.
    initSwErrorReporting();

    // Resource Timing entries back the traced-chunk `cacheState` dimension
    // (detectCacheState in traced-tab-loader.ts). The 250-entry default buffer
    // can evict the chunk's entry on long PWA sessions, degrading the signal to
    // `unknown`; a larger buffer keeps it reliable at negligible cost.
    performance.setResourceTimingBufferSize?.(500);

    // Injected at build time by the deploy workflow via VITE_APP_VERSION.
    const appVersion = import.meta.env.VITE_APP_VERSION as string | undefined;
    if (appVersion) {
        const versionEl = document.createElement('div');
        versionEl.className = 'app-version';
        versionEl.textContent = appVersion;
        container.appendChild(versionEl);
    }
}
