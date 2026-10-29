/**
 * App-wide backstop for uncaught async failures, reported to Umami as
 * `unhandled-error`. Observe-only: never calls `preventDefault()`, so the
 * browser's own console logging still happens (`diagnostics.warn` mirrors in
 * dev/test, no-op in production).
 *
 * A `window` listener runs in the page realm, so it never sees errors thrown
 * inside the service worker's scope — those are relayed separately by
 * `pwa/sw-error-bridge.ts` under the `sw-error` / `sw-rejection` source.
 */

import { diagnostics } from '../diagnostics.js';
import { track } from './umami.js';
import { errorName, sanitizeErrorReason } from './sanitize-error-reason.js';

/** Max reports per distinct `reason`, per session. */
const MAX_PER_REASON = 5;
/** Max total reports per session. */
const MAX_TOTAL = 50;

/**
 * Drop pure-noise `error` events: opaque cross-origin `"Script error."` (the
 * browser strips everything actionable) and browser-extension content-script
 * throws (extension-scheme `filename`). Kept narrow so a real app error is
 * never swallowed. Rejections aren't filtered — extension scripts rarely
 * surface them into the page realm.
 */
function isIgnorableErrorEvent(event: ErrorEvent): boolean {
    if (/^script error\.?$/i.test((event.message ?? '').trim())) {
        return true;
    }
    return /^[a-z-]*extension:\/\//i.test(event.filename ?? '');
}

/**
 * Install the global handlers. Call once at boot, after
 * {@link import('./umami.js').initAnalytics}. Returns a disposer that removes
 * the listeners (used by tests). No-op without a `window`.
 *
 * Per-session rate limiting guards the analytics stream against error loops:
 * each distinct `reason` at most {@link MAX_PER_REASON} times, the session at
 * most {@link MAX_TOTAL}. A single `RateLimited` notice is emitted when the
 * global cap is first hit, then the backstop goes quiet.
 */
export function initErrorTracking(): () => void {
    if (typeof window === 'undefined') return () => {};

    const reasonCounts = new Map<string, number>();
    let totalSent = 0;
    let capNoticeSent = false;

    function reportingAllowed(reason: string): boolean {
        if (totalSent >= MAX_TOTAL) return false;
        const seen = reasonCounts.get(reason) ?? 0;
        if (seen >= MAX_PER_REASON) return false;
        reasonCounts.set(reason, seen + 1);
        totalSent += 1;
        return true;
    }

    function report(source: 'rejection' | 'error', cause: unknown, message?: string): void {
        const reason = sanitizeErrorReason(cause ?? message);
        if (reportingAllowed(reason)) {
            diagnostics.warn(
                source === 'rejection' ? 'Unhandled promise rejection:' : 'Uncaught error:',
                cause ?? message,
            );
            track('unhandled-error', { source, name: errorName(cause), reason });
            return;
        }
        // Surface the flood once, only when the *global* cap (not per-reason
        // dedup) is the blocker, then stay silent.
        if (totalSent >= MAX_TOTAL && !capNoticeSent) {
            capNoticeSent = true;
            track('unhandled-error', {
                source: 'error',
                name: 'RateLimited',
                reason: `unhandled-error cap (${MAX_TOTAL}/session) reached; further errors dropped`,
            });
        }
    }

    const onRejection = (event: PromiseRejectionEvent): void => {
        report('rejection', event.reason);
    };

    // No capture phase, so failed-resource load errors (which only reach
    // window in capture) never land here — only uncaught script exceptions.
    const onError = (event: ErrorEvent): void => {
        if (isIgnorableErrorEvent(event)) return;
        report('error', event.error, event.message);
    };

    // A CSP refusal has its own event, not an `error` event.
    const onCspViolation = (event: SecurityPolicyViolationEvent): void => {
        // Keyed on the directive, not the URI, so a page blocking one image
        // per piece can't exhaust the session budget.
        const reason = `csp:${event.effectiveDirective}`;
        if (!reportingAllowed(reason)) return;
        diagnostics.warn('CSP violation:', event.effectiveDirective, event.blockedURI);
        track('csp-violation', {
            directive: event.effectiveDirective,
            // Already stripped by the browser (`'data'` for data: URLs,
            // scheme/host/port for cross-origin). See CspViolationData.
            blockedUri: event.blockedURI,
        });
    };

    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    window.addEventListener('securitypolicyviolation', onCspViolation);

    return () => {
        window.removeEventListener('unhandledrejection', onRejection);
        window.removeEventListener('error', onError);
        window.removeEventListener('securitypolicyviolation', onCspViolation);
    };
}
