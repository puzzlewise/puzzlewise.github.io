export type WebGLUnsupportedCause = 'no-webgl2' | 'blocked';

export class WebGLUnsupportedError extends Error {
    override readonly cause: WebGLUnsupportedCause;

    constructor(cause: WebGLUnsupportedCause) {
        super(cause === 'no-webgl2' ? 'WebGL 2 is not available' : 'WebGL 2 context creation was refused');
        this.name = 'WebGLUnsupportedError';
        this.cause = cause;
    }
}

export class ShaderBuildError extends Error {
    readonly log: string;

    constructor(message: string, log: string) {
        super(message);
        this.name = 'ShaderBuildError';
        this.log = log;
    }
}

export const GL_CONTEXT_OPTIONS: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
};

// No webglcontextcreationerror listener on purpose: in Chrome its statusMessage
// carries the GPU's PCI vendor/device ids and driver name, device data the app
// doesn't collect without consent.
export function createGl(canvas: HTMLCanvasElement): WebGL2RenderingContext {
    if (typeof WebGL2RenderingContext === 'undefined') throw new WebGLUnsupportedError('no-webgl2');
    const gl = canvas.getContext('webgl2', GL_CONTEXT_OPTIONS);
    if (!gl) throw new WebGLUnsupportedError('blocked');
    return gl;
}

export function onContextLoss(
    canvas: HTMLCanvasElement,
    handlers: { lost: () => void; restored: () => void },
): () => void {
    const onLost = (event: Event) => {
        event.preventDefault();
        handlers.lost();
    };
    const onRestored = () => handlers.restored();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => {
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
    };
}

// Status queries return null while the context is lost: a loss for the restore path, not a shader defect.
function lostOrThrow(gl: WebGL2RenderingContext, message: string, log: () => string | null): null {
    if (gl.isContextLost()) return null;
    throw new ShaderBuildError(message, log() ?? '');
}

/** Returns null only when the context is lost; the restore path rebuilds the program. */
export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    let built = false;
    try {
        if (!vertex || !fragment || !program) return lostOrThrow(gl, 'Shader objects could not be created', () => null);
        gl.shaderSource(vertex, vs);
        gl.compileShader(vertex);
        gl.shaderSource(fragment, fs);
        gl.compileShader(fragment);
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (gl.getShaderParameter(vertex, gl.COMPILE_STATUS) !== true) {
            return lostOrThrow(gl, 'Vertex shader failed to compile', () => gl.getShaderInfoLog(vertex));
        }
        if (gl.getShaderParameter(fragment, gl.COMPILE_STATUS) !== true) {
            return lostOrThrow(gl, 'Fragment shader failed to compile', () => gl.getShaderInfoLog(fragment));
        }
        if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
            return lostOrThrow(gl, 'Program failed to link', () => gl.getProgramInfoLog(program));
        }
        gl.detachShader(program, vertex);
        gl.detachShader(program, fragment);
        built = true;
        return program;
    } finally {
        if (vertex) gl.deleteShader(vertex);
        if (fragment) gl.deleteShader(fragment);
        if (program && !built) gl.deleteProgram(program);
    }
}
