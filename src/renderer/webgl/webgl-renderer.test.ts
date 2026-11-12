/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameState, PieceGroup } from '../../model/types.js';
import { FakeFrameHost } from '../../test-helpers/fake-frame-host.js';
import { makeGameState, makeRectPiece } from '../../test-helpers/fixtures.js';
import { CONTEXT_RESTORE_TIMEOUT_MS } from './context-loss.js';
import { ShaderBuildError } from './gl-context.js';
import { WebGlRenderer, type WebGlRendererOptions } from './webgl-renderer.js';

function fakeGl(host: FakeFrameHost) {
    const state = { compiles: true, lost: false };
    const calls: { name: string; frame: number }[] = [];
    const answers: Record<string, (...args: unknown[]) => unknown> = {
        getShaderParameter: () => state.compiles,
        getProgramParameter: () => true,
        getShaderInfoLog: () => 'compile log',
        getProgramInfoLog: () => 'link log',
        isContextLost: () => state.lost,
        getParameter: () => 4096,
        getExtension: () => null,
    };
    const gl = new Proxy({ drawingBufferWidth: 100, drawingBufferHeight: 100 } as Record<string | symbol, unknown>, {
        get(target, name) {
            if (name in target) return target[name];
            if (typeof name !== 'string' || /^[A-Z0-9_]+$/.test(name)) return 0;
            return (...args: unknown[]) => {
                calls.push({ name, frame: host.frame });
                return answers[name]?.(...args) ?? {};
            };
        },
    });
    return { gl, state, calls };
}

function group(id: number, x: number): PieceGroup {
    return { id, pieces: new Map([[id, { x: 0, y: 0 }]]), position: { x, y: 0 }, rotation: 0 };
}

function twoPieceGame(): GameState {
    const pieces = [makeRectPiece({ id: 0, col: 0 }), makeRectPiece({ id: 1, col: 1 })];
    return makeGameState({ pieces, groups: [group(0, 0), group(1, 200)], imageUrl: null });
}

function setup(options: Partial<WebGlRendererOptions> = {}) {
    const host = new FakeFrameHost();
    const fake = fakeGl(host);
    vi.stubGlobal('WebGL2RenderingContext', {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => host.requestAnimationFrame(callback));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => host.cancelAnimationFrame(handle));
    vi.stubGlobal('queueMicrotask', (callback: () => void) => host.queueMicrotask(callback));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.gl as unknown as WebGL2RenderingContext);

    const renderer = new WebGlRenderer({
        runInIdle: (items, work) => {
            items.forEach(work);
            return () => {};
        },
        onRestoreFailed: vi.fn(),
        onContextEvent: vi.fn(),
        ...options,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderer.init(container);
    const canvas = container.querySelector('canvas')!;
    const drawFrames = () => fake.calls.filter((call) => call.name === 'drawElements').map((call) => call.frame);
    return { host, fake, renderer, canvas, drawFrames };
}

describe('WebGlRenderer', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.replaceChildren();
    });

    test('init appends the puzzle table element that input and context-menu handling key on', () => {
        const { canvas } = setup();
        expect(canvas.parentElement!.matches('[data-puzzle-table]')).toBe(true);
    });

    test('a state rendered inside a frame is drawn in that frame', () => {
        const { host, renderer, drawFrames } = setup();
        const game = twoPieceGame();
        renderer.renderState(game);
        host.runFrame();
        expect(drawFrames()).toEqual([1]);

        host.requestAnimationFrame(() => {
            renderer.renderState({ ...game, groups: [group(0, 50), group(1, 200)] });
        });
        host.runFrame();

        expect(drawFrames()).toEqual([1, 2]);
        expect(host.pendingFrames()).toBe(0);
    });

    test('a shader failure on restore is reported once, and no give-up follows', () => {
        const onRestoreFailed = vi.fn<(error: ShaderBuildError) => void>();
        const onContextEvent = vi.fn();
        const { fake, canvas } = setup({ onRestoreFailed, onContextEvent });
        const uncaught = vi.fn();
        window.addEventListener('error', uncaught);

        canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
        fake.state.compiles = false;
        canvas.dispatchEvent(new Event('webglcontextrestored'));
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
        canvas.dispatchEvent(new Event('webglcontextrestored'));
        window.removeEventListener('error', uncaught);

        expect(uncaught).not.toHaveBeenCalled();
        expect(onRestoreFailed).toHaveBeenCalledTimes(1);
        expect(onRestoreFailed.mock.calls[0][0]).toBeInstanceOf(ShaderBuildError);
        expect(onRestoreFailed.mock.calls[0][0].log).toBe('compile log');
        expect(onContextEvent.mock.calls).toEqual([['lost']]);
    });
});
