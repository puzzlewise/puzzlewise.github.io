
import { createProgram, ShaderBuildError } from './gl-context.js';
import {
    ATLAS_GUTTER,
    ATLAS_LAYER_SIZE,
    ATLAS_LEVELS,
    type AtlasPlan,
    type AtlasRect,
    type Bounds,
    haloLayout,
    type HaloLayout,
    haloRegion,
    type RepackPlan,
    RepackPlanner,
    type RepackStep,
    type ShelfPacker,
    type SlotSize,
    slotSize,
    OUTLINE_HALF_WIDTH,
} from './halo-atlas-plan.js';
import { gaussianKernel, type HaloState, type HaloStep } from './halo-recipe.js';
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

export type { AtlasRect } from './halo-atlas-plan.js';

/** Corners in the reference piece's frame (world units) and their atlas UVs. */
export interface HaloQuad {
    refSlot: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    layer: number;
}

export interface HaloGroupLayout {
    refPiece: number;
    /** Union of the fill bounds in the reference piece's frame. */
    fills: Bounds;
}

export interface HaloSilhouette {
    refSlot: number;
    /** In the reference piece's frame, including the outline stroke when it is drawn. */
    bounds: Bounds;
    /** Fills plus outer strokes or fringes, into the shared vertex buffer. */
    indices: Uint32Array;
}

export interface HaloSource {
    layout(groupId: number): HaloGroupLayout | null;
    silhouette(groupId: number): HaloSilhouette | null;
    steps(state: HaloState): readonly HaloStep[];
    groupOfPiece(pieceId: number): number | undefined;
}

export interface HaloAtlasOptions {
    plan: AtlasPlan;
    /** Slot indices available for halo quads in the vertex buffer. */
    capacity: number;
    vertexBuffer: WebGLBuffer;
    now?: () => number;
    /** Texel fetches the GPU may be handed per `buildPending` call; a single unit may exceed it. */
    workPerCall?: number;
    /** Grid cells a repack plan visits between budget checks. */
    planWork?: number;
}

const DEFAULT_WORK_PER_CALL = 16_000_000;
const DEFAULT_PLAN_WORK = 16_000;

interface Content {
    state: HaloState;
    key: string;
    layout: HaloLayout;
    refSlot: number;
}

interface Slot {
    index: number;
    /** Where its pixels are now. */
    rect: AtlasRect;
    /** What the packer holds for it; differs from `rect` only while a repack is moving it. */
    reserved: AtlasRect;
    content: Content | null;
    visible: boolean;
}

interface Want {
    state: HaloState;
    key: string;
}

interface Group {
    refPiece: number;
    slot: Slot | null;
    /** Undefined until first requested; null when the group has no halo. */
    want: Want | null | undefined;
    /** Earlier halos (its own or absorbed groups'), drawn until the wanted one is copied in. */
    retiring: Slot[];
    failedSize: SlotSize | null;
}

interface Planning {
    planner: RepackPlanner;
    waiting: { groupId: number; size: SlotSize; index: number }[];
    /** Slots freed while planning; their targets go back to the new packer. */
    freed: Set<number>;
}

interface Job {
    groupId: number;
    slot: Slot;
    want: Want;
    content: Content;
    region: AtlasRect;
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

const sameWant = (content: Content | null, want: Want | null | undefined): boolean =>
    !!content && !!want && content.state === want.state && content.key === want.key;

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
    readonly layers: number;
    /** Bumped whenever some group's `slotsOf` changes. */
    layoutRevision = 0;
    private readonly gl: WebGL2RenderingContext;
    private readonly source: HaloSource;
    private readonly programs: HaloPrograms;
    private readonly now: () => number;
    private readonly workPerCall: number;
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
    private packer: ShelfPacker;
    private readonly slots = new Map<number, Slot>();
    private readonly freeIndices: number[];
    private readonly groups = new Map<number, Group>();
    private readonly queue = new Set<number>();
    private readonly changed = new Set<number>();
    private changeCount = 0;
    private readonly needSlots = new Map<number, SlotSize>();
    private planning: Planning | null = null;
    private repackSteps: { slot: Slot; step: RepackStep }[] = [];
    private job: Job | null = null;

    static create(gl: WebGL2RenderingContext, source: HaloSource, options: HaloAtlasOptions): HaloAtlas | null {
        const programs = createHaloPrograms(gl);
        return programs && new HaloAtlas(gl, programs, source, options);
    }

    constructor(gl: WebGL2RenderingContext, programs: HaloPrograms, source: HaloSource, options: HaloAtlasOptions) {
        const { plan } = options;
        this.gl = gl;
        this.source = source;
        this.programs = programs;
        this.now = options.now ?? (() => performance.now());
        this.workPerCall = options.workPerCall ?? DEFAULT_WORK_PER_CALL;
        this.planWork = options.planWork ?? DEFAULT_PLAN_WORK;
        this.layers = plan.layers;
        this.packer = plan.packer;
        this.freeIndices = Array.from({ length: options.capacity }, (_, i) => options.capacity - 1 - i);

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

        for (const [groupId, rect] of plan.slots) {
            const slot = this.addSlot(rect);
            if (!slot) continue;
            this.groups.set(groupId, { refPiece: -1, slot, want: undefined, retiring: [], failedSize: null });
        }
    }

    get texture(): WebGLTexture {
        return this.atlas;
    }

    get pending(): boolean {
        return this.job !== null || this.queue.size > 0 || this.planning !== null
            || this.repackSteps.length > 0 || this.needSlots.size > 0;
    }

    groupIds(): number[] {
        return [...this.groups.keys()];
    }

    request(groupId: number, state: HaloState, key: string): void {
        const layout = this.source.layout(groupId);
        if (!layout) return;
        const group = this.groupFor(groupId);
        group.refPiece = layout.refPiece;
        if (group.want?.state !== state || group.want.key !== key) group.want = { state, key };
        this.ensureSlot(groupId, group, slotSize(layout.fills));
        if (group.failedSize) this.dropOtherStates(group);
        const slot = group.slot;
        if (slot && sameWant(slot.content, group.want)) {
            this.settle(group);
            return;
        }
        if (slot) this.queue.add(groupId);
    }

    hide(groupId: number): void {
        const group = this.groups.get(groupId);
        if (!group) return;
        group.want = null;
        this.queue.delete(groupId);
        this.setShown(group, false);
        this.freeRetiring(group);
    }

    /** The group left the table; a group that now holds its pieces keeps drawing its halo until its own is built. */
    release(groupId: number): void {
        const group = this.groups.get(groupId);
        if (!group) return;
        this.groups.delete(groupId);
        this.queue.delete(groupId);
        this.needSlots.delete(groupId);
        const drawn = group.retiring;
        if (group.slot) {
            if (group.slot.visible) drawn.push(group.slot);
            else this.freeSlot(group.slot);
        }
        const successor = this.source.groupOfPiece(group.refPiece);
        const heir = successor === undefined || successor === groupId ? undefined : this.groupFor(successor);
        if (heir && heir.want !== null) heir.retiring.push(...drawn);
        else for (const slot of drawn) this.freeSlot(slot);
        this.layoutRevision++;
    }

    /** Every slot the group holds, oldest first; `quad` tells which ones draw. */
    slotsOf(groupId: number): number[] {
        const group = this.groups.get(groupId);
        if (!group) return [];
        const out = group.retiring.map((slot) => slot.index);
        if (group.slot) out.push(group.slot.index);
        return out;
    }

    get revision(): number {
        return this.layoutRevision * 1_000_000 + this.changeCount;
    }

    /** Slots whose `quad` changed since the last call. */
    takeChangedSlots(): number[] {
        const out = [...this.changed];
        this.changed.clear();
        return out;
    }

    quad(index: number): HaloQuad | null {
        const slot = this.slots.get(index);
        const content = slot?.content;
        if (!slot || !content || !slot.visible) return null;
        const { layout } = content;
        const u0 = slot.rect.x + ATLAS_GUTTER;
        const v0 = slot.rect.y + ATLAS_GUTTER;
        return {
            refSlot: content.refSlot,
            x0: layout.originX,
            y0: layout.originY,
            x1: layout.originX + layout.width / layout.texelsPerUnit,
            y1: layout.originY + layout.height / layout.texelsPerUnit,
            u0: u0 / ATLAS_LAYER_SIZE,
            v0: v0 / ATLAS_LAYER_SIZE,
            u1: (u0 + layout.width) / ATLAS_LAYER_SIZE,
            v1: (v0 + layout.height) / ATLAS_LAYER_SIZE,
            layer: slot.rect.layer,
        };
    }

    /** Expects the transform texture bound on its unit and the vertex buffer current. */
    buildPending(budgetMs: number): void {
        const start = this.now();
        let work = 0;
        if (!this.job && !this.planning && this.repackSteps.length === 0 && this.needSlots.size > 0) {
            this.placeWaitingSlots();
        }
        while (this.now() - start < budgetMs && work < this.workPerCall) {
            if (this.planning) {
                const plan = this.planning.planner.step(this.planWork);
                if (plan !== undefined) this.adoptRepack(plan);
                continue;
            }
            const step = this.repackSteps.shift();
            if (step) {
                work += this.runRepackStep(step);
                continue;
            }
            const job = this.job ?? this.nextJob();
            if (!job) break;
            this.job = job;
            if (!this.stillWanted(job)) {
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

    private groupFor(groupId: number): Group {
        let group = this.groups.get(groupId);
        if (!group) {
            group = { refPiece: -1, slot: null, want: undefined, retiring: [], failedSize: null };
            this.groups.set(groupId, group);
        }
        return group;
    }

    private settle(group: Group): void {
        this.setShown(group, true);
        this.freeRetiring(group);
    }

    private markChanged(index: number): void {
        this.changed.add(index);
        this.changeCount++;
    }

    private setShown(group: Group, shown: boolean): void {
        const slot = group.slot;
        if (!slot || slot.visible === shown) return;
        slot.visible = shown;
        this.markChanged(slot.index);
    }

    /** No halo is better than one for another state, once the wanted one can't be placed. */
    private dropOtherStates(group: Group): void {
        const keep = group.retiring.filter((slot) => slot.content?.state === group.want?.state);
        if (keep.length === group.retiring.length) return;
        for (const slot of group.retiring) if (!keep.includes(slot)) this.freeSlot(slot);
        group.retiring = keep;
        this.layoutRevision++;
    }

    private failSlot(groupId: number, group: Group, size: SlotSize): void {
        group.failedSize = size;
        // eslint-disable-next-line no-console
        console.warn(`No room for group ${groupId}'s ${size.w}×${size.h} halo slot; it draws without its halo`);
        this.dropOtherStates(group);
    }

    private freeRetiring(group: Group): void {
        if (group.retiring.length === 0) return;
        for (const slot of group.retiring) this.freeSlot(slot);
        group.retiring = [];
        this.layoutRevision++;
    }

    private ensureSlot(groupId: number, group: Group, need: SlotSize): void {
        const slot = group.slot;
        if (slot && slot.reserved.w >= need.w && slot.reserved.h >= need.h) return;
        if (slot) {
            if (slot.visible) group.retiring.push(slot);
            else this.freeSlot(slot);
            group.slot = null;
            this.layoutRevision++;
        }
        if (group.failedSize && group.failedSize.w === need.w && group.failedSize.h === need.h) return;
        group.failedSize = null;
        // The plan in progress covers exactly the slots that existed when it started.
        if (!this.planning) group.slot = this.allocSlot(need);
        if (group.slot) this.needSlots.delete(groupId);
        else this.needSlots.set(groupId, need);
    }

    private addSlot(rect: AtlasRect): Slot | null {
        const index = this.freeIndices.pop();
        if (index === undefined) {
            this.packer.free(rect);
            return null;
        }
        const slot: Slot = { index, rect, reserved: rect, content: null, visible: false };
        this.slots.set(index, slot);
        this.markChanged(index);
        this.layoutRevision++;
        return slot;
    }

    private allocSlot(size: SlotSize): Slot | null {
        if (this.freeIndices.length === 0) return null;
        const rect = this.packer.alloc(size.w, size.h);
        return rect ? this.addSlot(rect) : null;
    }

    private freeSlot(slot: Slot): void {
        if (this.slots.get(slot.index) !== slot) return;
        this.planning?.freed.add(slot.index);
        this.packer.free(slot.reserved);
        this.slots.delete(slot.index);
        this.freeIndices.push(slot.index);
    }

    private placeWaitingSlots(): void {
        for (const [groupId, size] of this.needSlots) {
            const group = this.groups.get(groupId);
            const slot = group && this.allocSlot(size);
            if (!group) this.needSlots.delete(groupId);
            if (!slot) continue;
            group!.slot = slot;
            this.needSlots.delete(groupId);
            this.queue.add(groupId);
        }
        if (this.needSlots.size === 0) return;

        const live = new Map(Array.from(this.slots, ([index, slot]) => [index, slot.reserved]));
        const waiting = [...this.needSlots].map(([groupId, size]) => ({ groupId, size, index: this.freeIndices.pop() }));
        this.needSlots.clear();
        if (waiting.some(({ index }) => index === undefined)) {
            for (const { groupId, size, index } of waiting) {
                if (index !== undefined) this.freeIndices.push(index);
                this.failSlot(groupId, this.groups.get(groupId)!, size);
            }
            return;
        }
        const placed = waiting as Planning['waiting'];
        const planner = new RepackPlanner(live, placed.map(({ size, index }) => ({ id: index, ...size })), this.layers);
        this.planning = { planner, waiting: placed, freed: new Set() };
    }

    private adoptRepack(plan: RepackPlan | null): void {
        const { waiting, freed } = this.planning!;
        this.planning = null;
        if (!plan) {
            for (const { groupId, size, index } of waiting) {
                this.freeIndices.push(index);
                const group = this.groups.get(groupId);
                if (group) this.failSlot(groupId, group, size);
            }
            return;
        }
        this.packer = plan.packer;
        for (const index of freed) {
            const target = plan.targets.get(index);
            if (target && !this.slots.has(index)) this.packer.free(target);
        }
        for (const slot of this.slots.values()) slot.reserved = plan.targets.get(slot.index)!;
        for (const { groupId, index } of waiting) {
            const rect = plan.targets.get(index)!;
            const group = this.groups.get(groupId);
            if (!group || group.slot || this.needSlots.has(groupId)) {
                this.packer.free(rect);
                this.freeIndices.push(index);
                continue;
            }
            const slot: Slot = { index, rect, reserved: rect, content: null, visible: false };
            this.slots.set(index, slot);
            this.markChanged(index);
            this.layoutRevision++;
            group.slot = slot;
            this.queue.add(groupId);
        }
        this.repackSteps = plan.steps.flatMap((step) => {
            const slot = this.slots.get(step.id);
            return slot && !freed.has(step.id) ? [{ slot, step }] : [];
        });
    }

    private runRepackStep({ slot, step }: { slot: Slot; step: RepackStep }): number {
        if (this.slots.get(slot.index) !== slot) return 0;
        if (step.kind === 'evict') {
            slot.content = null;
            slot.rect = slot.reserved;
            this.markChanged(slot.index);
            for (const [groupId, group] of this.groups) {
                if (group.slot === slot) {
                    this.setShown(group, false);
                    this.queue.add(groupId);
                } else if (group.retiring.includes(slot)) {
                    group.retiring.splice(group.retiring.indexOf(slot), 1);
                    this.freeSlot(slot);
                    this.layoutRevision++;
                }
            }
            return 0;
        }
        const gl = this.gl;
        const { rect } = slot;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo.atlas);
        gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.atlas, 0, rect.layer);
        gl.activeTexture(gl.TEXTURE0 + HALO_IMAGE_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.haloTarget);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rect.x, rect.y, rect.w, rect.h);
        this.storeHaloImage(step.to);
        slot.rect = step.to;
        this.markChanged(slot.index);
        return 2 * rect.w * rect.h;
    }

    private nextJob(): Job | null {
        for (const groupId of this.queue) {
            this.queue.delete(groupId);
            const group = this.groups.get(groupId);
            const slot = group?.slot;
            const want = group?.want;
            if (!group || !slot || !want || sameWant(slot.content, want)) continue;
            const silhouette = this.source.silhouette(groupId);
            if (!silhouette) continue;
            const steps = this.source.steps(want.state);
            if (steps.length === 0) continue;
            const layout = haloLayout(silhouette.bounds, steps);
            const size = haloRegion(layout);
            if (size.w > slot.reserved.w || size.h > slot.reserved.h) continue;
            const job: Job = {
                groupId,
                slot,
                want,
                content: { ...want, layout, refSlot: silhouette.refSlot },
                region: { ...slot.rect, ...size },
                units: [],
                next: 0,
            };
            job.units.push(() => this.drawSilhouette(size, layout, silhouette));
            for (const step of steps) {
                const kernel = gaussianKernel(step.sigma, layout.texelsPerUnit);
                if (kernel.length > MAX_BLUR_TAPS) throw new Error(`Blur of σ ${step.sigma} needs ${kernel.length} taps`);
                const rows = Math.max(ATLAS_GUTTER, Math.floor(this.workPerCall / 2 / (size.w * kernel.length)));
                for (let y = 0; y < size.h; y += rows) {
                    job.units.push(() => this.blur('x', size, kernel, step, y, Math.min(size.h, y + rows)));
                }
                for (let y = 0; y < size.h; y += rows) {
                    job.units.push(() => this.blur('y', size, kernel, step, y, Math.min(size.h, y + rows)));
                }
            }
            job.units.push(() => this.commit(job));
            return job;
        }
        return null;
    }

    private stillWanted(job: Job): boolean {
        const group = this.groups.get(job.groupId);
        return !!group && group.slot === job.slot && group.want === job.want
            && !this.planning && this.repackSteps.length === 0;
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
        return size.w * size.h + silhouette.indices.length;
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
        return size.w * (y1 - y0) * kernel.length;
    }

    private commit(job: Job): number {
        const { slot, content, region } = job;
        this.storeHaloImage(region);
        slot.content = content;
        this.markChanged(slot.index);
        const group = this.groups.get(job.groupId)!;
        this.setShown(group, true);
        this.freeRetiring(group);
        return 2 * region.w * region.h;
    }

    private storeHaloImage(rect: AtlasRect): void {
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
    }

    private restoreState(): void {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        gl.disable(gl.SCISSOR_TEST);
    }
}
