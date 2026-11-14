/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGl, createProgram, onContextLoss, ShaderBuildError, WebGLUnsupportedError } from './gl-context.js';

const VERTEX_SHADER = 0x8b31;
const FRAGMENT_SHADER = 0x8b30;
const COMPILE_STATUS = 0x8b81;
const LINK_STATUS = 0x8b82;

interface FakeGlOptions {
    vertexStatus?: boolean | null;
    fragmentStatus?: boolean | null;
    linkStatus?: boolean | null;
    lost?: boolean;
}

function fakeGl({ vertexStatus = true, fragmentStatus = true, linkStatus = true, lost = false }: FakeGlOptions = {}) {
    const shaders: { type: number }[] = [];
    const program = { program: true };
    const gl = {
        VERTEX_SHADER,
        FRAGMENT_SHADER,
        COMPILE_STATUS,
        LINK_STATUS,
        createShader: vi.fn((type: number) => {
            const shader = { type };
            shaders.push(shader);
            return shader;
        }),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: vi.fn((shader: { type: number }) =>
            shader.type === VERTEX_SHADER ? vertexStatus : fragmentStatus,
        ),
        getShaderInfoLog: vi.fn((shader: { type: number }) =>
            shader.type === VERTEX_SHADER ? 'vertex log' : 'fragment log',
        ),
        createProgram: vi.fn(() => program),
        attachShader: vi.fn(),
        detachShader: vi.fn(),
        linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => linkStatus),
        getProgramInfoLog: vi.fn(() => 'link log'),
        deleteShader: vi.fn(),
        deleteProgram: vi.fn(),
        isContextLost: vi.fn(() => lost),
    };
    return { gl, program, shaders, context: gl as unknown as WebGL2RenderingContext };
}

function captureError(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected a throw');
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('createGl', () => {
    it('reports no-webgl2 when WebGL2RenderingContext is undefined', () => {
        vi.stubGlobal('WebGL2RenderingContext', undefined);
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');

        const error = captureError(() => createGl(document.createElement('canvas')));

        expect(error).toBeInstanceOf(WebGLUnsupportedError);
        expect((error as WebGLUnsupportedError).cause).toBe('no-webgl2');
        expect(getContext).not.toHaveBeenCalled();
    });

    it('reports blocked when getContext returns null', () => {
        vi.stubGlobal('WebGL2RenderingContext', vi.fn());
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

        const error = captureError(() => createGl(document.createElement('canvas')));

        expect(error).toBeInstanceOf(WebGLUnsupportedError);
        expect((error as WebGLUnsupportedError).cause).toBe('blocked');
    });

    it('requests webgl2 with the exact context options', () => {
        vi.stubGlobal('WebGL2RenderingContext', vi.fn());
        const { context } = fakeGl();
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);

        expect(createGl(document.createElement('canvas'))).toBe(context);
        expect(getContext).toHaveBeenCalledWith('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
        });
    });

    it('never forwards the webglcontextcreationerror status message', () => {
        vi.stubGlobal('WebGL2RenderingContext', vi.fn());
        const statusMessage = 'ANGLE (vendor 0x10de, device 0x2484, driver 31.0.15)';
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
            const event = new Event('webglcontextcreationerror');
            Object.assign(event, { statusMessage });
            this.dispatchEvent(event);
            return null;
        });

        const error = captureError(() => createGl(document.createElement('canvas'))) as WebGLUnsupportedError;

        expect(error.cause).toBe('blocked');
        expect(JSON.stringify({ message: error.message, cause: error.cause, stack: error.stack })).not.toContain(
            '0x10de',
        );
    });
});

describe('onContextLoss', () => {
    it('prevents the default on loss and reports loss and restore', () => {
        const canvas = document.createElement('canvas');
        const lost = vi.fn();
        const restored = vi.fn();
        onContextLoss(canvas, { lost, restored });

        const lossEvent = new Event('webglcontextlost', { cancelable: true });
        canvas.dispatchEvent(lossEvent);

        expect(lossEvent.defaultPrevented).toBe(true);
        expect(lost).toHaveBeenCalledOnce();
        expect(restored).not.toHaveBeenCalled();

        canvas.dispatchEvent(new Event('webglcontextrestored'));
        expect(restored).toHaveBeenCalledOnce();
    });

    it('stops listening once disposed', () => {
        const canvas = document.createElement('canvas');
        const lost = vi.fn();
        const restored = vi.fn();
        const dispose = onContextLoss(canvas, { lost, restored });

        dispose();
        const lossEvent = new Event('webglcontextlost', { cancelable: true });
        canvas.dispatchEvent(lossEvent);
        canvas.dispatchEvent(new Event('webglcontextrestored'));

        expect(lossEvent.defaultPrevented).toBe(false);
        expect(lost).not.toHaveBeenCalled();
        expect(restored).not.toHaveBeenCalled();
    });
});

describe('createProgram', () => {
    it('returns the linked program and releases the shaders', () => {
        const { gl, program, context } = fakeGl();

        expect(createProgram(context, 'vs', 'fs')).toBe(program);
        expect(gl.shaderSource).toHaveBeenCalledWith({ type: VERTEX_SHADER }, 'vs');
        expect(gl.shaderSource).toHaveBeenCalledWith({ type: FRAGMENT_SHADER }, 'fs');
        expect(gl.deleteShader).toHaveBeenCalledTimes(2);
        expect(gl.deleteProgram).not.toHaveBeenCalled();
    });

    it('returns null when the context is lost and the statuses read as failed', () => {
        const { gl, context } = fakeGl({ vertexStatus: null, fragmentStatus: null, linkStatus: null, lost: true });

        expect(createProgram(context, 'vs', 'fs')).toBeNull();
        expect(gl.getShaderInfoLog).not.toHaveBeenCalled();
    });

    it('returns null when the context is lost before shaders can be created', () => {
        const { gl, context } = fakeGl({ lost: true });
        gl.createShader.mockReturnValue(null as never);
        gl.createProgram.mockReturnValue(null as never);

        expect(createProgram(context, 'vs', 'fs')).toBeNull();
    });

    it.each([
        ['vertex', { vertexStatus: false }, 'vertex log'],
        ['fragment', { fragmentStatus: false }, 'fragment log'],
    ] as const)('throws ShaderBuildError with the %s compile log', (_name, options, log) => {
        const { gl, context } = fakeGl({ ...options, linkStatus: false });

        const error = captureError(() => createProgram(context, 'vs', 'fs'));

        expect(error).toBeInstanceOf(ShaderBuildError);
        expect((error as ShaderBuildError).log).toBe(log);
        expect(gl.deleteProgram).toHaveBeenCalled();
    });

    it('throws ShaderBuildError with the program log on link failure', () => {
        const { gl, context } = fakeGl({ linkStatus: false });

        const error = captureError(() => createProgram(context, 'vs', 'fs'));

        expect(error).toBeInstanceOf(ShaderBuildError);
        expect((error as ShaderBuildError).log).toBe('link log');
        expect(gl.deleteProgram).toHaveBeenCalled();
    });
});
