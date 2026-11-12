import {
    ShaderBuildError,
    SvgDomRenderer,
    WebGLUnsupportedError,
    WebGlRenderer,
    type Renderer,
} from '../renderer/index.js';
import { track, whenAnalyticsReady, type RendererFailedData } from '../analytics/index.js';
import { hideLoadingOverlay, showRendererFailure, type RendererFailureKind } from '../ui/index.js';
import { runInIdleChunks } from './idle-chunks.js';

export type RendererChoice = 'svg' | 'webgl';

export function chooseRenderer(search: string): RendererChoice {
    return new URLSearchParams(search).get('renderer') === 'webgl' ? 'webgl' : 'svg';
}

/**
 * Returns null when WebGL can't start: the failure message is up and the game
 * must not boot. `pieceCount` may be called during `init`.
 */
export function startRenderer(
    container: HTMLElement,
    choice: RendererChoice,
    pieceCount: () => number,
): Renderer | null {
    if (choice === 'svg') {
        const renderer = new SvgDomRenderer();
        renderer.init(container);
        return renderer;
    }

    const renderer = new WebGlRenderer({
        runInIdle: runInIdleChunks,
        onContextEvent: (phase) => {
            if (phase === 'lost') {
                const data = { pieceCount: pieceCount(), visibilityState: document.visibilityState };
                whenAnalyticsReady(() => track('renderer-context-lost', data));
            } else if (phase === 'gave-up') {
                fail(container, 'lost', 'lost');
            }
        },
        onRestoreFailed: (error) => failUnsupported(container, 'WebGL renderer failed to restore', error, 'shader'),
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
