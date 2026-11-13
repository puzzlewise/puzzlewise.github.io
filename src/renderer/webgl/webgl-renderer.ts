import type { GameState, Point, Size } from '../../model/types.js';
import type { RendererAppearance } from '../appearance.js';
import type { Renderer } from '../types.js';
import { TransitionController, type ViewportValue } from './animation.js';
import { assembleIndices, drawPasses } from './draw-list.js';
import { GeometryStore } from './geometry-store.js';
import { ContextLossMonitor, type ContextEventPhase } from './context-loss.js';
import { FrameScheduler } from './frame-scheduler.js';
import { createGl, createProgram, onContextLoss, ShaderBuildError } from './gl-context.js';
import { hitTest } from './hit-test.js';
import { PhotoLoader } from './photo-loader.js';
import { watchDevicePixelRatio } from './pixel-ratio.js';
import { sliceUv, textureSizeFor } from './photo-mapping.js';
import { buildPieceFill, buildPieceStrokes } from './piece-mesh.js';
import {
    appearanceDirt,
    clientToCanvas,
    type Dirt,
    gameIdentity,
    type GameIdentity,
    NO_DIRT,
    sameGame,
    sceneDirt,
} from './render-plan.js';
import { Scene, TRANSFORM_STRIDE } from './scene.js';
import {
    MAIN_ATTRIBUTES,
    MAIN_FS,
    MAIN_UNIFORMS,
    MAIN_VERTEX_FLOATS,
    MAIN_VS,
    PHOTO_TEXTURE_UNIT,
    TRANSFORM_TEXELS_PER_SLOT,
    TRANSFORM_TEXTURE_UNIT,
    TRANSFORM_TEXTURE_WIDTH,
} from './shaders.js';


/** Runs `work` on each item in idle time; the returned function cancels the rest. */
export type IdleScheduler = <T>(items: readonly T[], work: (item: T) => void) => () => void;

export interface WebGlRendererOptions {
    runInIdle: IdleScheduler;
    onContextEvent: (phase: ContextEventPhase) => void;
    /** A restored context that can't rebuild the shaders; context events stop after it. */
    onRestoreFailed: (error: ShaderBuildError) => void;
}

// World units: half a CSS pixel at the maximum zoom of 5.
const FLATTEN_TOLERANCE = 0.1;
const OUTLINE_HALF_WIDTH = 1.5;

const DEFAULT_APPEARANCE: RendererAppearance = {
    outline: 'outline',
    outlineColor: [8 / 255, 8 / 255, 8 / 255, 1],
    constantWidth: false,
    innerOutline: false,
    selectionGlowColor: [200 / 255, 191 / 255, 1, 1],
    backgroundColor: [26 / 255, 26 / 255, 26 / 255, 1],
    pieceOpacity: 1,
    debugPieces: false,
    matelessEdges: false,
};

const ALL_DIRT: Readonly<Dirt> = { vertices: true, indices: true, transforms: true, frame: true };

type UniformLocations = Record<keyof typeof MAIN_UNIFORMS, WebGLUniformLocation | null>;

interface GlResources {
    program: WebGLProgram;
    uniforms: UniformLocations;
    vao: WebGLVertexArrayObject;
    vertexBuffer: WebGLBuffer;
    indexBuffer: WebGLBuffer;
    photoTexture: WebGLTexture;
    transformTexture: WebGLTexture | null;
    transformRows: number;
    indexCount: number;
}

interface Game {
    identity: GameIdentity;
    state: GameState;
    scene: Scene;
    store: GeometryStore;
    strokesReady: boolean;
    cancelStrokes: () => void;
}

export class WebGlRenderer implements Renderer {
    private readonly contextLoss: ContextLossMonitor;
    private readonly runInIdle: IdleScheduler;
    private readonly onRestoreFailed: (error: ShaderBuildError) => void;
    private table: HTMLDivElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private gl: WebGL2RenderingContext | null = null;
    private res: GlResources | null = null;
    private game: Game | null = null;
    private appearance: RendererAppearance = DEFAULT_APPEARANCE;
    private viewport: ViewportValue = { scale: 1, offsetX: 0, offsetY: 0 };
    private cssSize: Size = { width: 1, height: 1 };
    private dirty: Dirt = { ...NO_DIRT };
    private resizeObserver: ResizeObserver | null = null;
    private stopPixelRatioWatch: (() => void) | null = null;
    private disposeContextLoss: (() => void) | null = null;
    private photo: HTMLImageElement | null = null;
    private photoPixels: TexImageSource | null = null;
    private photoDirty = false;
    private indexScratch: Uint32Array | undefined;
    private readonly photos = new PhotoLoader((image) => this.setPhoto(image));
    private readonly transitions = new TransitionController({
        viewport: (value) => {
            this.viewport = value;
            this.markDirty({ frame: true });
        },
        rotation: (groupId, deg, pivot) => this.overrideRotation(groupId, deg, pivot),
    });
    private readonly frames = new FrameScheduler(window, {
        draw: () => this.drawIfDirty(),
        tick: (now) => this.transitions.tick(now),
    });

    constructor(options: WebGlRendererOptions) {
        this.runInIdle = options.runInIdle;
        this.onRestoreFailed = options.onRestoreFailed;
        this.contextLoss = new ContextLossMonitor(options.onContextEvent);
    }

    init(container: HTMLElement): void {
        const table = document.createElement('div');
        table.dataset.puzzleTable = 'true';
        table.style.position = 'relative';
        table.style.width = '100%';
        table.style.height = '100%';
        table.style.overflow = 'hidden';
        table.style.touchAction = 'none';
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        table.appendChild(canvas);
        container.appendChild(table);

        try {
            this.gl = createGl(canvas);
            this.table = table;
            this.canvas = canvas;
            this.disposeContextLoss = onContextLoss(canvas, {
                lost: () => this.handleContextLost(),
                restored: () => this.handleContextRestored(),
            });
            if (!this.createResources()) this.handleContextLost();
        } catch (error) {
            this.disposeContextLoss?.();
            this.disposeContextLoss = null;
            this.gl = null;
            this.table = null;
            this.canvas = null;
            table.remove();
            throw error;
        }

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(table);
        this.stopPixelRatioWatch = watchDevicePixelRatio(() => this.resize());
        this.resize();
    }

    renderState(gameState: GameState): void {
        if (!this.table) return;
        const identity = gameIdentity(gameState);
        const game = this.game;
        if (!game || !sameGame(game.identity, identity)) {
            this.installGame(gameState, identity);
            return;
        }
        game.state = gameState;
        for (const groupId of this.transitions.takeSettledRotations()) game.scene.setRotationOverride(groupId, 0, null);
        // The app's drag path calls this from inside its own rAF callback.
        this.markDirty(sceneDirt(game.scene.sync(gameState)), true);
    }

    bringGroupToFront(groupId: number): void {
        const game = this.game;
        if (!game) return;
        game.scene.bringToFront(groupId);
        this.markDirty(sceneDirt(game.scene.sync(game.state)));
    }

    setViewportTransform(scale: number, offsetX: number, offsetY: number): void {
        this.transitions.setViewport({ scale, offsetX, offsetY });
    }

    transitionViewport(scale: number, offsetX: number, offsetY: number): Promise<void> {
        const done = this.transitions.transitionViewport(
            this.viewport,
            { scale, offsetX, offsetY },
            performance.now(),
        );
        this.frames.drawNextFrame();
        return done;
    }

    animateGroupRotation(groupId: number, toDeg: number, pivotLocal: Point): Promise<void> {
        const fromDeg = this.game?.scene.groupRotation(groupId);
        if (fromDeg === undefined) return Promise.resolve();
        const done = this.transitions.animateGroupRotation(groupId, fromDeg, toDeg, pivotLocal, performance.now());
        this.frames.drawNextFrame();
        return done;
    }

    setGroupDragging(groupId: number, dragging: boolean): void {
        this.game?.scene.setDragging(groupId, dragging);
    }

    setGroupSelected(groupId: number, selected: boolean): void {
        this.game?.scene.setSelected(groupId, selected);
    }

    setRingsEnabled(_enabled: boolean): void {}

    setInnerOutlineEnabled(_enabled: boolean): void {}

    setViewportMoving(_moving: boolean): void {}

    setAppearance(appearance: RendererAppearance): void {
        const dirt = appearanceDirt(this.appearance, appearance);
        this.appearance = appearance;
        this.markDirty(dirt);
    }

    pieceIdAtPoint(point: Point): number | null {
        if (!this.game || !this.canvas) return null;
        const local = clientToCanvas(point, this.canvas.getBoundingClientRect(), this.cssSize);
        return hitTest(this.game.scene, local, this.viewport);
    }

    photoSettled(): Promise<'loaded' | 'failed'> {
        return this.photos.settled();
    }

    prefetchPhoto(url: string): void {
        this.photos.prefetch(url);
    }

    destroy(): void {
        this.frames.cancel();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.stopPixelRatioWatch?.();
        this.stopPixelRatioWatch = null;
        this.disposeContextLoss?.();
        this.disposeContextLoss = null;
        this.game?.cancelStrokes();
        this.game = null;
        this.transitions.dispose();
        this.photos.dispose();
        this.photo = null;
        this.photoPixels = null;
        this.photoDirty = false;
        this.indexScratch = undefined;
        this.dirty = { ...NO_DIRT };
        this.deleteResources();
        this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
        this.contextLoss.dispose();
        this.table?.remove();
        this.table = null;
        this.canvas = null;
        this.gl = null;
    }

    private installGame(state: GameState, identity: GameIdentity): void {
        this.game?.cancelStrokes();
        this.transitions.newGame();
        this.photos.load(state.imageUrl);

        const meshes = state.pieces.map((piece) => buildPieceFill(piece, FLATTEN_TOLERANCE));
        const scene = new Scene(meshes, state);
        const store = new GeometryStore(state.pieces, (id) => scene.slotOfPiece(id));
        for (const mesh of meshes) store.addFill(mesh);
        const game: Game = {
            identity,
            state,
            scene,
            store,
            strokesReady: meshes.length === 0,
            cancelStrokes: () => {},
        };
        this.game = game;
        this.markDirty(ALL_DIRT);

        let built = 0;
        game.cancelStrokes = this.runInIdle(meshes, (mesh) => {
            store.addStrokes(mesh, buildPieceStrokes(mesh));
            if (++built < meshes.length) return;
            game.strokesReady = true;
            this.markDirty({ vertices: true, indices: true, frame: true });
        });
    }

    private overrideRotation(groupId: number, deg: number, pivot: Point): void {
        const game = this.game;
        if (!game) return;
        game.scene.setRotationOverride(groupId, deg, pivot);
        this.markDirty({ transforms: true, frame: true });
    }

    private setPhoto(image: HTMLImageElement | null): void {
        this.photo = image;
        this.photoPixels = null;
        this.photoDirty = true;
        this.markDirty({ frame: true });
    }

    private markDirty(dirt: Partial<Dirt>, afterTask = false): void {
        const d = this.dirty;
        d.vertices ||= dirt.vertices ?? false;
        d.indices ||= dirt.indices ?? false;
        d.transforms ||= dirt.transforms ?? false;
        d.frame ||= dirt.frame ?? false;
        if (!d.frame) return;
        if (afterTask) this.frames.drawAfterTask();
        else this.frames.drawNextFrame();
    }

    private drawIfDirty(): void {
        if (!this.dirty.frame || this.contextLoss.isLost || !this.gl || !this.res) return;
        this.upload(this.gl, this.res);
        this.draw(this.gl, this.res);
        this.dirty = { ...NO_DIRT };
    }

    private resize(): void {
        const { table, canvas } = this;
        if (!table || !canvas) return;
        const width = Math.max(1, table.clientWidth);
        const height = Math.max(1, table.clientHeight);
        const ratio = window.devicePixelRatio || 1;
        const backingWidth = Math.max(1, Math.round(width * ratio));
        const backingHeight = Math.max(1, Math.round(height * ratio));
        this.cssSize = { width, height };
        if (canvas.width === backingWidth && canvas.height === backingHeight) {
            this.markDirty({ frame: true });
            return;
        }
        canvas.width = backingWidth;
        canvas.height = backingHeight;
        // Resizing clears the canvas; drawing now avoids presenting a blank frame.
        this.dirty.frame = true;
        this.drawIfDirty();
    }

    private createResources(): boolean {
        const gl = this.gl!;
        const program = createProgram(gl, MAIN_VS, MAIN_FS);
        if (!program) return false;
        const uniforms = Object.fromEntries(
            Object.entries(MAIN_UNIFORMS).map(([key, name]) => [key, gl.getUniformLocation(program, name)]),
        ) as UniformLocations;

        const vao = gl.createVertexArray();
        const vertexBuffer = gl.createBuffer();
        const indexBuffer = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        for (const { location, size, offset } of Object.values(MAIN_ATTRIBUTES)) {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, MAIN_VERTEX_FLOATS * 4, offset * 4);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bindVertexArray(null);

        const photoTexture = gl.createTexture();
        gl.useProgram(program);
        gl.uniform1i(uniforms.transforms, TRANSFORM_TEXTURE_UNIT);
        gl.uniform1i(uniforms.photo, PHOTO_TEXTURE_UNIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (gl.isContextLost()) return false;

        this.res = {
            program,
            uniforms,
            vao,
            vertexBuffer,
            indexBuffer,
            photoTexture,
            transformTexture: null,
            transformRows: 0,
            indexCount: 0,
        };
        this.photoDirty = true;
        this.markDirty(ALL_DIRT);
        return true;
    }

    private deleteResources(): void {
        const { gl, res } = this;
        this.res = null;
        if (!gl || !res || gl.isContextLost()) return;
        gl.deleteProgram(res.program);
        gl.deleteVertexArray(res.vao);
        gl.deleteBuffer(res.vertexBuffer);
        gl.deleteBuffer(res.indexBuffer);
        gl.deleteTexture(res.photoTexture);
        if (res.transformTexture) gl.deleteTexture(res.transformTexture);
    }

    private handleContextLost(): void {
        this.res = null;
        this.contextLoss.lost();
    }

    private handleContextRestored(): void {
        if (!this.contextLoss.canRestore) return;
        let created: boolean;
        try {
            created = this.createResources();
        } catch (error) {
            if (!(error instanceof ShaderBuildError)) throw error;
            this.contextLoss.stop();
            this.onRestoreFailed(error);
            return;
        }
        // A null program means the context was lost again mid-rebuild; its own events follow.
        if (!created) return;
        this.contextLoss.restored(() => this.drawIfDirty());
    }

    private upload(gl: WebGL2RenderingContext, res: GlResources): void {
        if (this.photoDirty) this.uploadPhoto(gl, res);
        const game = this.game;
        const dirty = this.dirty;
        if (!game) return;
        if (dirty.vertices) {
            gl.bindBuffer(gl.ARRAY_BUFFER, res.vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, game.store.vertices(), gl.STATIC_DRAW);
        }
        if (dirty.indices) {
            const passes = drawPasses(this.appearance, game.strokesReady);
            const indices = assembleIndices(game.scene, game.store, passes, this.indexScratch);
            if (indices.buffer !== this.indexScratch?.buffer) this.indexScratch = indices;
            gl.bindVertexArray(res.vao);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
            gl.bindVertexArray(null);
            res.indexCount = indices.length;
        }
        if (dirty.transforms) this.uploadTransforms(gl, res, game.scene.pieceTransforms());
    }

    private uploadTransforms(gl: WebGL2RenderingContext, res: GlResources, transforms: Float32Array): void {
        const texels = (transforms.length / TRANSFORM_STRIDE) * TRANSFORM_TEXELS_PER_SLOT;
        const rows = Math.max(1, Math.ceil(texels / TRANSFORM_TEXTURE_WIDTH));
        gl.activeTexture(gl.TEXTURE0 + TRANSFORM_TEXTURE_UNIT);
        if (!res.transformTexture || res.transformRows !== rows) {
            if (res.transformTexture) gl.deleteTexture(res.transformTexture);
            res.transformTexture = gl.createTexture();
            res.transformRows = rows;
            gl.bindTexture(gl.TEXTURE_2D, res.transformTexture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, TRANSFORM_TEXTURE_WIDTH, rows);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, res.transformTexture);
        }
        const fullRows = Math.floor(texels / TRANSFORM_TEXTURE_WIDTH);
        if (fullRows > 0) {
            gl.texSubImage2D(
                gl.TEXTURE_2D, 0, 0, 0, TRANSFORM_TEXTURE_WIDTH, fullRows, gl.RGBA, gl.FLOAT, transforms, 0,
            );
        }
        const rest = texels - fullRows * TRANSFORM_TEXTURE_WIDTH;
        if (rest > 0) {
            gl.texSubImage2D(
                gl.TEXTURE_2D, 0, 0, fullRows, rest, 1, gl.RGBA, gl.FLOAT,
                transforms, fullRows * TRANSFORM_TEXTURE_WIDTH * 4,
            );
        }
    }

    private uploadPhoto(gl: WebGL2RenderingContext, res: GlResources): void {
        this.photoDirty = false;
        gl.activeTexture(gl.TEXTURE0 + PHOTO_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, res.photoTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const image = this.photo;
        if (!image) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
            return;
        }
        this.photoPixels ??= scaledPhoto(image, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.photoPixels);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }

    private draw(gl: WebGL2RenderingContext, res: GlResources): void {
        const [r, g, b] = this.appearance.backgroundColor;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const game = this.game;
        if (!game || res.indexCount === 0 || !res.transformTexture) return;

        const { state } = game;
        const u = res.uniforms;
        const appearance = this.appearance;
        const uv = this.photo
            ? sliceUv(state.imageSize, { width: this.photo.naturalWidth, height: this.photo.naturalHeight })
            : { scale: { x: 1, y: 1 }, offset: { x: 0, y: 0 } };

        gl.useProgram(res.program);
        gl.activeTexture(gl.TEXTURE0 + TRANSFORM_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, res.transformTexture);
        gl.activeTexture(gl.TEXTURE0 + PHOTO_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, res.photoTexture);
        gl.uniform1f(u.scale, this.viewport.scale);
        gl.uniform2f(u.offset, this.viewport.offsetX, this.viewport.offsetY);
        gl.uniform2f(u.viewportSize, this.cssSize.width, this.cssSize.height);
        gl.uniform1f(u.pixelRatio, gl.drawingBufferWidth / this.cssSize.width);
        gl.uniform2f(u.imageSize, state.imageSize.width, state.imageSize.height);
        gl.uniform2f(u.uvScale, uv.scale.x, uv.scale.y);
        gl.uniform2f(u.uvOffset, uv.offset.x, uv.offset.y);
        gl.uniform1i(u.blank, state.imageUrl === null ? 1 : 0);
        gl.uniform1f(u.pieceOpacity, appearance.pieceOpacity);
        gl.uniform4f(u.outlineColor, ...appearance.outlineColor);
        gl.uniform1f(u.halfWidth, OUTLINE_HALF_WIDTH);
        gl.uniform1i(u.constantWidth, appearance.constantWidth ? 1 : 0);
        gl.uniform1i(u.innerOnly, drawPasses(appearance, game.strokesReady).strokesOver ? 1 : 0);

        gl.bindVertexArray(res.vao);
        gl.drawElements(gl.TRIANGLES, res.indexCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
    }
}

function scaledPhoto(image: HTMLImageElement, maxTextureSize: number): TexImageSource {
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    const size = textureSizeFor(natural, maxTextureSize);
    if (size.width === natural.width && size.height === natural.height) return image;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) return image;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas;
}
