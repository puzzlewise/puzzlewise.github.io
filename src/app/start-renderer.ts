import {
    ShaderBuildError,
    WebGLUnsupportedError,
    WebGlRenderer,
    type Renderer,
} from '../renderer/index.js';
import {
    sanitizeErrorReason,
    track,
    whenAnalyticsReady,
    type RendererDegradedData,
    type RendererFailedData,
} from '../analytics/index.js';
import { hideLoadingOverlay, showRendererFailure, type RendererFailureKind } from '../ui/index.js';
import { runInIdleChunks } from './idle-chunks.js';

/**
 * Returns null when WebGL can't start: the failure message is up and the game
 * must not boot. `pieceCount` may be called during `init`.
 */
export function startRenderer(container: HTMLElement, pieceCount: () => number): Renderer | null {
    const reported = new Set<'halos' | 'fills'>();
    const reportDegradedOnce = (what: 'halos' | 'fills', data: RendererDegradedData): void => {
        if (reported.has(what)) return;
        reported.add(what);
        whenAnalyticsReady(() => track('renderer-degraded', data));
    };

    const renderer = new WebGlRenderer({
        runInIdle: runInIdleChunks,
        onContextEvent: (event) => {
            if (event.phase === 'lost') {
                const data = { pieceCount: pieceCount(), visibilityState: document.visibilityState };
                whenAnalyticsReady(() => track('renderer-context-lost', data));
            } else if (event.phase === 'gave-up') {
                fail(container, 'lost', 'lost');
            } else {
                const data = {
                    latencyMs: Math.round(event.latencyMs),
                    ...(event.phase === 'restored-late' ? { late: true as const } : {}),
                };
                whenAnalyticsReady(() => track('renderer-context-restored', data));
            }
        },
        onRestoreFailed: (error) => failUnsupported(container, 'WebGL renderer failed to restore', error, 'shader'),
        onHalosUnavailable: (kind) => reportDegradedOnce('halos', { kind }),
        onFillsOmitted: ({ skipped, errored, error, budgetExhaustedAfter }) => reportDegradedOnce('fills', {
            kind: 'fills',
            skipped,
            errored,
            ...(errored > 0 ? { reason: sanitizeErrorReason(error) } : {}),
            ...(budgetExhaustedAfter === undefined ? {} : { budgetExhaustedAfter }),
        }),
    });
    try {
        renderer.init(container);
        return renderer;
    } catch (error) {
        const kind = initFailureKind(error);
        if (!kind) throw error;
        failUnsupported(container, 'WebGL renderer failed to start', error, kind);
        return null;
    }
}

function failUnsupported(
    container: HTMLElement,
    message: string,
    error: unknown,
    kind: RendererFailedData['kind'],
): void {
    // eslint-disable-next-line no-console
    console.error(message, error, ...(error instanceof ShaderBuildError ? [error.log] : []));
    hideLoadingOverlay();
    fail(container, 'unsupported', kind);
}

function initFailureKind(error: unknown): RendererFailedData['kind'] | null {
    if (error instanceof WebGLUnsupportedError) return error.cause;
    if (error instanceof ShaderBuildError) return 'shader';
    return null;
}

function fail(container: HTMLElement, message: RendererFailureKind, kind: RendererFailedData['kind']): void {
    showRendererFailure(container, message);
    whenAnalyticsReady(() => track('renderer-failed', { kind }));
}
