import { OUTLINE_HALF_WIDTH } from './draw-list.js';
import { createProgram, ShaderBuildError } from './gl-context.js';
import {
    ATLAS_GUTTER,
    ATLAS_LAYER_SIZE,
    ATLAS_LEVELS,
    type AtlasPlan,
    type AtlasRect,
    type HaloLayout,
    type SlotSize,
} from './halo-atlas-plan.js';
import { gaussianKernel, type HaloStep } from './halo-recipe.js';
import { type HaloBuild, type HaloMove, type HaloSilhouette, HaloSlots, type HaloSource } from './halo-slots.js';
import {
    BLUR_TEXTURE_UNIT,
    BLUR_X_FS,
    BLUR_Y_FS,
    HALO_IMAGE_TEXTURE_UNIT,
    HALO_TEXTURE_UNIT,
    MAIN_ATTRIBUTES,
    MAIN_VERTEX_FLOATS,
    MAX_BLUR_TAPS,
    MIP_FS,
    PASS_UNIFORMS,
    PASS_VS,
    SILHOUETTE_FS,
    SILHOUETTE_TEXTURE_UNIT,
    SILHOUETTE_UNIFORMS,
    SILHOUETTE_VS,
    TRANSFORM_TEXTURE_UNIT,
} from './shaders.js';

export interface HaloAtlasOptions {
    plan: AtlasPlan;
    /** Slot indices available for halo quads in the vertex buffer. */
    capacity: number;
    vertexBuffer: WebGLBuffer;
    now?: () => number;
    /** Grid cells a repack plan visits between budget checks. */
    planWork?: number;
}

/**
 * A render pass costs a fixed share of GPU time however few texels it covers:
 * ~50 µs per halo pass on an Apple M4, where 16 M fetches add about 1 ms.
 */
const PASS_WORK = 500_000;
/**
 * Texel fetches plus `PASS_WORK` per render pass, per `buildPending` call; a
 * single unit may exceed it. Fits about 9 selected-glow builds (~95 passes,
 * ~16 M fetches).
 */
const WORK_PER_CALL = 64_000_000;
const MAX_BLUR_BAND_FETCHES = 8_000_000;
const DEFAULT_PLAN_WORK = 16_000;

interface Job {
    build: HaloBuild;
    units: (() => number)[];
    next: number;
}

type Uniforms<T extends Record<string, string>> = Record<keyof T, WebGLUniformLocation | null>;

export interface HaloPrograms {
    silhouette: WebGLProgram;
    blurX: WebGLProgram;
    blurY: WebGLProgram;
    mip: WebGLProgram;
    su: Uniforms<typeof SILHOUETTE_UNIFORMS>;
    bx: Uniforms<typeof PASS_UNIFORMS>;
    by: Uniforms<typeof PASS_UNIFORMS>;
    mu: Uniforms<typeof PASS_UNIFORMS>;
}

function locations<T extends Record<string, string>>(gl: WebGL2RenderingContext, program: WebGLProgram, names: T): Uniforms<T> {
    return Object.fromEntries(
        Object.entries(names).map(([key, name]) => [key, gl.getUniformLocation(program, name)]),
    ) as Uniforms<T>;
}

/**
 * Null when the context is lost; throws `ShaderBuildError`. Either way,
 * nothing it created is left behind.
 */
export function createHaloPrograms(gl: WebGL2RenderingContext): HaloPrograms | null {
    const created: WebGLProgram[] = [];
    const build = (name: string, vs: string, fs: string): WebGLProgram | null => {
        let program: WebGLProgram | null;
        try {
            program = createProgram(gl, vs, fs);
        } catch (error) {
            if (!(error instanceof ShaderBuildError)) throw error;
            throw new ShaderBuildError(`Halo ${name} program: ${error.message}`, error.log);
        }
        if (program) created.push(program);
        return program;
    };
    let programs: HaloPrograms | null = null;
    try {
        const silhouette = build('silhouette', SILHOUETTE_VS, SILHOUETTE_FS);
        const blurX = silhouette && build('blurX', PASS_VS, BLUR_X_FS);
        const blurY = blurX && build('blurY', PASS_VS, BLUR_Y_FS);
        const mip = blurY && build('mip', PASS_VS, MIP_FS);
        if (silhouette && blurX && blurY && mip) {
            programs = {
                silhouette, blurX, blurY, mip,
                su: locations(gl, silhouette, SILHOUETTE_UNIFORMS),
                bx: locations(gl, blurX, PASS_UNIFORMS),
                by: locations(gl, blurY, PASS_UNIFORMS),
                mu: locations(gl, mip, PASS_UNIFORMS),
            };
        }
        return programs;
    } finally {
        if (!programs) for (const program of created) gl.deleteProgram(program);
    }
}

export function deleteHaloPrograms(gl: WebGL2RenderingContext, programs: HaloPrograms): void {
    if (gl.isContextLost()) return;
    for (const program of [programs.silhouette, programs.blurX, programs.blurY, programs.mip]) gl.deleteProgram(program);
}

/**
 * Builds each halo in a scratch target and copies it into the group's slot
 * only when complete, so the previous halo keeps drawing until then. The
 * layer count is fixed at creation.
 */
export class HaloAtlas {
    readonly slots: HaloSlots;
    private readonly gl: WebGL2RenderingContext;
    private readonly programs: HaloPrograms;
    private readonly now: () => number;
    private readonly planWork: number;
    private readonly atlas: WebGLTexture;
    private readonly silhouetteTarget: WebGLTexture;
    private readonly haloTarget: WebGLTexture;
    private readonly blurTarget: WebGLTexture;
    private readonly fbo: { silhouette: WebGLFramebuffer; halo: WebGLFramebuffer; blur: WebGLFramebuffer; atlas: WebGLFramebuffer };
    private readonly silhouetteVao: WebGLVertexArrayObject;
    private readonly passVao: WebGLVertexArrayObject;
    private readonly indexBuffer: WebGLBuffer;
    private readonly weights = new Float32Array(MAX_BLUR_TAPS);
    private job: Job | null = null;

    constructor(gl: WebGL2RenderingContext, programs: HaloPrograms, source: HaloSource, options: HaloAtlasOptions) {
        const { plan } = options;
        this.gl = gl;
        this.programs = programs;
        this.now = options.now ?? (() => performance.now());
        this.planWork = options.planWork ?? DEFAULT_PLAN_WORK;
        this.atlas = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + HALO_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, ATLAS_LEVELS, gl.RGBA8, ATLAS_LAYER_SIZE, ATLAS_LAYER_SIZE, plan.layers);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const target = (unit: number, format: GLenum): WebGLTexture => {
            const texture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, format, Math.max(1, plan.scratch.w), Math.max(1, plan.scratch.h));
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            return texture;
        };
        this.silhouetteTarget = target(SILHOUETTE_TEXTURE_UNIT, gl.R8);
        this.haloTarget = target(HALO_IMAGE_TEXTURE_UNIT, gl.RGBA8);
        this.blurTarget = target(BLUR_TEXTURE_UNIT, gl.R8);
        const framebuffer = (texture: WebGLTexture | null): WebGLFramebuffer => {
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            if (texture) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            return fbo;
        };
        this.fbo = {
            silhouette: framebuffer(this.silhouetteTarget),
            halo: framebuffer(this.haloTarget),
            blur: framebuffer(this.blurTarget),
            atlas: framebuffer(null),
        };
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.indexBuffer = gl.createBuffer();
        this.silhouetteVao = gl.createVertexArray();
        gl.bindVertexArray(this.silhouetteVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, options.vertexBuffer);
        for (const { location, size, offset } of Object.values(MAIN_ATTRIBUTES)) {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, MAIN_VERTEX_FLOATS * 4, offset * 4);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        this.passVao = gl.createVertexArray();
        gl.bindVertexArray(null);

        const { su, bx, by, mu } = programs;
        gl.useProgram(programs.silhouette);
        gl.uniform1i(su.transforms, TRANSFORM_TEXTURE_UNIT);
        gl.uniform1f(su.halfWidth, OUTLINE_HALF_WIDTH);
        gl.uniform1f(su.gutter, ATLAS_GUTTER);
        gl.useProgram(programs.blurX);
        gl.uniform1i(bx.silhouette, SILHOUETTE_TEXTURE_UNIT);
        gl.uniform1i(bx.halo, HALO_IMAGE_TEXTURE_UNIT);
        gl.useProgram(programs.blurY);
        gl.uniform1i(by.source, BLUR_TEXTURE_UNIT);
        gl.useProgram(programs.mip);
        gl.uniform1i(mu.source, HALO_IMAGE_TEXTURE_UNIT);

        this.slots = new HaloSlots(plan, options.capacity, source);
    }

    get texture(): WebGLTexture {
        return this.atlas;
    }

    get pending(): boolean {
        return this.job !== null || this.slots.pending;
    }

    /** Expects the transform texture bound on its unit and the vertex buffer current. */
    buildPending(budgetMs: number): void {
        const start = this.now();
        let work = 0;
        if (!this.job) this.slots.placeWaitingSlots();
        while (this.now() - start < budgetMs && work < WORK_PER_CALL) {
            if (this.slots.planStep(this.planWork)) continue;
            const move = this.slots.nextMove();
            if (move) {
                work += this.copyHalo(move);
                continue;
            }
            const job = this.job ?? this.nextJob();
            if (!job) break;
            this.job = job;
            if (!this.slots.isCurrent(job.build)) {
                this.job = null;
                continue;
            }
            work += job.units[job.next++]();
            if (job.next === job.units.length) this.job = null;
        }
        this.restoreState();
    }

    dispose(): void {
        const gl = this.gl;
        if (gl.isContextLost()) return;
        for (const texture of [this.atlas, this.silhouetteTarget, this.haloTarget, this.blurTarget]) gl.deleteTexture(texture);
        for (const fbo of Object.values(this.fbo)) gl.deleteFramebuffer(fbo);
        gl.deleteVertexArray(this.silhouetteVao);
        gl.deleteVertexArray(this.passVao);
        gl.deleteBuffer(this.indexBuffer);
    }

    private copyHalo({ from, to }: HaloMove): number {
        const gl = this.gl;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo.atlas);
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.atlas, 0, from.layer);
        gl.activeTexture(gl.TEXTURE0 + HALO_IMAGE_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.haloTarget);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, from.x, from.y, from.w, from.h);
        return from.w * from.h + PASS_WORK + this.storeHaloImage(to);
    }

    private nextJob(): Job | null {
        const build = this.slots.nextBuild();
        if (!build) return null;
        const { layout, silhouette, steps, region } = build;
        const job: Job = { build, units: [], next: 0 };
        job.units.push(() => this.drawSilhouette(region, layout, silhouette));
        for (const step of steps) {
            const kernel = gaussianKernel(step.sigma, layout.texelsPerUnit);
            if (kernel.length > MAX_BLUR_TAPS) throw new Error(`Blur of σ ${step.sigma} needs ${kernel.length} taps`);
            const rows = Math.max(ATLAS_GUTTER, Math.floor(MAX_BLUR_BAND_FETCHES / (region.w * kernel.length)));
            for (let y = 0; y < region.h; y += rows) {
                job.units.push(() => this.blur('x', region, kernel, step, y, Math.min(region.h, y + rows)));
            }
            for (let y = 0; y < region.h; y += rows) {
                job.units.push(() => this.blur('y', region, kernel, step, y, Math.min(region.h, y + rows)));
            }
        }
        job.units.push(() => {
            const work = this.storeHaloImage(region);
            this.slots.commit(build);
            return work;
        });
        return job;
    }

    private drawSilhouette(size: SlotSize, layout: HaloLayout, silhouette: HaloSilhouette): number {
        const gl = this.gl;
        const { su } = this.programs;
        gl.enable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, size.w, size.h);
        gl.scissor(0, 0, size.w, size.h);
        gl.clearColor(0, 0, 0, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.halo);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.silhouette);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.programs.silhouette);
        gl.uniform1i(su.refSlot, silhouette.refSlot);
        gl.uniform2f(su.origin, layout.originX, layout.originY);
        gl.uniform1f(su.texelsPerUnit, layout.texelsPerUnit);
        gl.uniform2f(su.size, size.w, size.h);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        gl.bindVertexArray(this.silhouetteVao);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, silhouette.indices, gl.STREAM_DRAW);
        gl.drawElements(gl.TRIANGLES, silhouette.indices.length, gl.UNSIGNED_INT, 0);
        gl.blendEquation(gl.FUNC_ADD);
        return size.w * size.h + silhouette.indices.length + PASS_WORK;
    }

    private blur(axis: 'x' | 'y', size: SlotSize, kernel: Float32Array, step: HaloStep, y0: number, y1: number): number {
        const gl = this.gl;
        const x = axis === 'x';
        const u = x ? this.programs.bx : this.programs.by;
        gl.bindFramebuffer(gl.FRAMEBUFFER, x ? this.fbo.blur : this.fbo.halo);
        gl.enable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, size.w, size.h);
        gl.scissor(0, y0, size.w, y1 - y0);
        gl.useProgram(x ? this.programs.blurX : this.programs.blurY);
        this.weights.fill(0);
        this.weights.set(kernel);
        gl.uniform1fv(u.weights, this.weights);
        gl.uniform1i(u.radius, (kernel.length - 1) / 2);
        gl.uniform2i(u.size, size.w, size.h);
        if (x) {
            gl.disable(gl.BLEND);
        } else {
            const [r, g, b] = step.color;
            gl.uniform4f(u.color, r * step.alpha, g * step.alpha, b * step.alpha, step.alpha);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE);
        }
        gl.bindVertexArray(this.passVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return size.w * (y1 - y0) * kernel.length + PASS_WORK;
    }

    private storeHaloImage(rect: AtlasRect): number {
        const gl = this.gl;
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo.halo);
        gl.activeTexture(gl.TEXTURE0 + HALO_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
        gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, rect.x, rect.y, rect.layer, 0, 0, rect.w, rect.h);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

        const { mu } = this.programs;
        gl.useProgram(this.programs.mip);
        gl.bindVertexArray(this.passVao);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.atlas);
        for (let level = 1; level < ATLAS_LEVELS; level++) {
            gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.atlas, level, rect.layer);
            const x = rect.x >> level;
            const y = rect.y >> level;
            gl.viewport(x, y, rect.w >> level, rect.h >> level);
            gl.uniform1i(mu.factor, 1 << level);
            gl.uniform2i(mu.regionOrigin, x, y);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        return 2 * rect.w * rect.h + ATLAS_LEVELS * PASS_WORK;
    }

    private restoreState(): void {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        gl.disable(gl.SCISSOR_TEST);
    }
}
