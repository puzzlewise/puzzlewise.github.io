import type { RendererAppearance } from '../appearance.js';
import { drawPasses } from './draw-list.js';
import { HALO_STATES, haloMargin, haloSteps, haloTexelsPerUnit, type HaloStep } from './halo-recipe.js';

export const ATLAS_LAYER_SIZE = 2048;
/** Texels of transparent border around each halo, so mip levels don't bleed between slots. */
export const ATLAS_GUTTER = 8;
/** Level 3 still keeps one gutter texel between neighbors. */
export const ATLAS_LEVELS = 4;
const ALIGN = 1 << (ATLAS_LEVELS - 1);
export const ATLAS_LAYER_BYTES = (ATLAS_LAYER_SIZE * ATLAS_LAYER_SIZE * 4 * 4) / 3;
/** The halo image (RGBA8) plus the silhouette and blur pass targets (R8 each). */
const SCRATCH_BYTES_PER_TEXEL = 4 + 1 + 1;
/** World units the outline stroke reaches past the piece edge. */
export const OUTLINE_HALF_WIDTH = 1.5;
/** 64 MiB with mips; puzzles needing more play without halos. */
const MAX_LAYERS = 3;

const mayStroke = (outline: RendererAppearance['outline']): boolean => silhouetteStroke({ outline, innerOutline: false });
const PRESET_MAY_STROKE = { outline: mayStroke('outline'), shadow: mayStroke('shadow'), none: mayStroke('none') } satisfies Record<RendererAppearance['outline'], boolean>;
export const OUTLINE_PRESETS = Object.keys(PRESET_MAY_STROKE) as readonly RendererAppearance['outline'][];
const ANY_GLOW = [1, 1, 1, 1] as const;

export interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface AtlasRect {
    layer: number;
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SlotSize {
    w: number;
    h: number;
}

/** Texel (0, 0) of the halo image starts at `origin` in the silhouette's frame, in world units. */
export interface HaloLayout {
    texelsPerUnit: number;
    originX: number;
    originY: number;
    width: number;
    height: number;
}

export function silhouetteStroke(appearance: Pick<RendererAppearance, 'outline' | 'innerOutline'>): boolean {
    return drawPasses(appearance, true).strokesUnder;
}

export function silhouetteBounds(
    pieces: Iterable<{ bounds: Bounds; x: number; y: number }>,
    stroke: boolean,
): Bounds {
    const pad = stroke ? OUTLINE_HALF_WIDTH : 0;
    const out = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const { bounds, x, y } of pieces) {
        out.minX = Math.min(out.minX, bounds.minX + x - pad);
        out.minY = Math.min(out.minY, bounds.minY + y - pad);
        out.maxX = Math.max(out.maxX, bounds.maxX + x + pad);
        out.maxY = Math.max(out.maxY, bounds.maxY + y + pad);
    }
    return out;
}

export function haloLayout(silhouette: Bounds, steps: readonly HaloStep[]): HaloLayout {
    const texelsPerUnit = haloTexelsPerUnit(steps);
    const margin = haloMargin(steps);
    return {
        texelsPerUnit,
        originX: silhouette.minX - margin,
        originY: silhouette.minY - margin,
        width: Math.ceil((silhouette.maxX - silhouette.minX + 2 * margin) * texelsPerUnit),
        height: Math.ceil((silhouette.maxY - silhouette.minY + 2 * margin) * texelsPerUnit),
    };
}

const align = (v: number): number => Math.ceil(v / ALIGN) * ALIGN;

/**
 * The texels a halo's build and draw touch: past the image, blur reach and
 * edge antialiasing stay inside the gutter, and trilinear sampling up to the
 * last mip level stays inside the alignment.
 */
export function haloRegion(layout: Pick<HaloLayout, 'width' | 'height'>): SlotSize {
    return { w: align(layout.width + 2 * ATLAS_GUTTER), h: align(layout.height + 2 * ATLAS_GUTTER) };
}

/**
 * Sized for every state under every preset, so neither a state change nor a
 * preset change ever needs a bigger slot. `fills` is the union of the fill
 * bounds, without the stroke.
 */
export function slotSize(fills: Bounds, presets: readonly RendererAppearance['outline'][] = OUTLINE_PRESETS): SlotSize {
    let w = 0;
    let h = 0;
    for (const preset of presets) {
        const silhouette = PRESET_MAY_STROKE[preset] ? expand(fills, OUTLINE_HALF_WIDTH) : fills;
        for (const state of HALO_STATES) {
            const steps = haloSteps(state, preset, ANY_GLOW);
            if (steps.length === 0) continue;
            const layout = haloLayout(silhouette, steps);
            w = Math.max(w, layout.width);
            h = Math.max(h, layout.height);
        }
    }
    return haloRegion({ width: w, height: h });
}

function expand(b: Bounds, d: number): Bounds {
    return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

export function scratchBytes(size: SlotSize): number {
    return size.w * size.h * SCRATCH_BYTES_PER_TEXEL;
}

interface Shelf {
    y: number;
    h: number;
    /** Free x intervals [start, end), sorted and disjoint. */
    spans: [number, number][];
}

interface Layer {
    shelves: Shelf[];
    top: number;
}

const isEmpty = (shelf: Shelf): boolean =>
    shelf.spans.length === 1 && shelf.spans[0][0] === 0 && shelf.spans[0][1] === ATLAS_LAYER_SIZE;

/** Shelves of one height share rows; freed rows merge and return to the layer once empty. */
export class ShelfPacker {
    readonly layers: number;
    private readonly state: Layer[];

    constructor(layers: number) {
        this.layers = layers;
        this.state = Array.from({ length: layers }, () => ({ shelves: [], top: 0 }));
    }

    alloc(width: number, height: number): AtlasRect | null {
        const w = align(width);
        const h = align(height);
        if (w > ATLAS_LAYER_SIZE || h > ATLAS_LAYER_SIZE) return null;
        const fits = (shelf: Shelf): boolean => shelf.h >= h && shelf.spans.some(([a, b]) => b - a >= w);

        let best: { layer: number; shelf: Shelf } | null = null;
        const tolerance = Math.max(ALIGN, Math.floor(h / 4));
        this.state.forEach((layer, index) => {
            for (const shelf of layer.shelves) {
                if (isEmpty(shelf) || !fits(shelf) || shelf.h - h > tolerance) continue;
                if (!best || shelf.h < best.shelf.h) best = { layer: index, shelf };
            }
        });
        if (best) return this.take(best, w, h);

        for (let index = 0; index < this.layers; index++) {
            const layer = this.state[index];
            if (layer.top + h > ATLAS_LAYER_SIZE) continue;
            const shelf: Shelf = { y: layer.top, h, spans: [[0, ATLAS_LAYER_SIZE]] };
            layer.shelves.push(shelf);
            layer.top += h;
            return this.take({ layer: index, shelf }, w, h);
        }

        let empty: { layer: number; shelf: Shelf } | null = null;
        this.state.forEach((layer, index) => {
            for (const shelf of layer.shelves) {
                if (isEmpty(shelf) && shelf.h >= h && (!empty || shelf.h < empty.shelf.h)) empty = { layer: index, shelf };
            }
        });
        if (empty) {
            const { layer, shelf } = empty as { layer: number; shelf: Shelf };
            if (shelf.h > h) {
                const rest: Shelf = { y: shelf.y + h, h: shelf.h - h, spans: [[0, ATLAS_LAYER_SIZE]] };
                const shelves = this.state[layer].shelves;
                shelves.splice(shelves.indexOf(shelf) + 1, 0, rest);
                shelf.h = h;
            }
            return this.take({ layer, shelf }, w, h);
        }

        for (let index = 0; index < this.layers; index++) {
            for (const shelf of this.state[index].shelves) {
                if (fits(shelf)) return this.take({ layer: index, shelf }, w, h);
            }
        }
        return null;
    }

    free(rect: AtlasRect): void {
        const layer = this.state[rect.layer];
        const index = layer.shelves.findIndex((shelf) => shelf.y === rect.y);
        if (index === -1) return;
        const shelf = layer.shelves[index];
        shelf.spans.push([rect.x, rect.x + rect.w]);
        shelf.spans.sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [];
        for (const span of shelf.spans) {
            const last = merged[merged.length - 1];
            if (last && last[1] >= span[0]) last[1] = Math.max(last[1], span[1]);
            else merged.push([span[0], span[1]]);
        }
        shelf.spans = merged;
        if (!isEmpty(shelf)) return;

        const shelves = layer.shelves;
        for (let i = 0; i < shelves.length - 1; i++) {
            if (isEmpty(shelves[i]) && isEmpty(shelves[i + 1])) {
                shelves[i].h += shelves[i + 1].h;
                shelves.splice(i + 1, 1);
                i--;
            }
        }
        const last = shelves[shelves.length - 1];
        if (last && isEmpty(last)) {
            shelves.pop();
            layer.top = last.y;
        }
    }

    private take({ layer, shelf }: { layer: number; shelf: Shelf }, w: number, h: number): AtlasRect {
        const span = shelf.spans.find(([a, b]) => b - a >= w)!;
        const x = span[0];
        span[0] += w;
        if (span[0] === span[1]) shelf.spans.splice(shelf.spans.indexOf(span), 1);
        return { layer, x, y: shelf.y, w, h };
    }
}

export class AtlasTooLargeError extends Error {
    readonly largest: SlotSize;

    constructor(largest: SlotSize) {
        super(`Halo slots don't fit in ${MAX_LAYERS} atlas layers; the largest is ${largest.w}×${largest.h}`);
        this.name = 'AtlasTooLargeError';
        this.largest = largest;
    }
}

export interface AtlasPlan {
    layers: number;
    packer: ShelfPacker;
    slots: Map<number, AtlasRect>;
    scratch: SlotSize;
    bytes: number;
}

const tallestFirst = (a: { id: number } & SlotSize, b: { id: number } & SlotSize): number => b.h - a.h || a.id - b.id;

function pack(
    slots: readonly ({ id: number } & SlotSize)[],
    layers: number,
): { packer: ShelfPacker; rects: Map<number, AtlasRect> } | null {
    const packer = new ShelfPacker(layers);
    const rects = new Map<number, AtlasRect>();
    for (const slot of [...slots].sort(tallestFirst)) {
        const rect = packer.alloc(slot.w, slot.h);
        if (!rect) return null;
        rects.set(slot.id, rect);
    }
    return { packer, rects };
}

/**
 * The layer count is fixed here for every group at its largest state, plus
 * room for one completed-puzzle slot so merges have space to land; the atlas
 * never grows afterwards. `scratch` is the slot size of the completed puzzle,
 * the largest halo any merge can produce.
 */
export function planAtlas(
    groups: readonly ({ id: number } & SlotSize)[],
    scratch: SlotSize,
    minLayers = 1,
): AtlasPlan {
    const headroom = { id: -1, ...scratch };
    for (let layers = minLayers; layers <= MAX_LAYERS; layers++) {
        const packed = pack([...groups, headroom], layers);
        if (!packed) continue;
        packed.packer.free(packed.rects.get(headroom.id)!);
        packed.rects.delete(headroom.id);
        return {
            layers,
            packer: packed.packer,
            slots: packed.rects,
            scratch,
            bytes: layers * ATLAS_LAYER_BYTES + scratchBytes(scratch),
        };
    }
    const largest = [...groups, headroom].reduce((a, b) => (Math.max(b.w, b.h) > Math.max(a.w, a.h) ? b : a));
    throw new AtlasTooLargeError({ w: largest.w, h: largest.h });
}

/** `move` copies the slot's halo to `to`; `evict` drops it, to be rebuilt at its target. */
export type RepackStep = { id: number; kind: 'move'; to: AtlasRect } | { id: number; kind: 'evict' };

export interface RepackPlan {
    packer: ShelfPacker;
    targets: Map<number, AtlasRect>;
    /** Each move lands clear of every other slot's halo at its turn; `added` slots are clear after the last step. */
    steps: RepackStep[];
}

const CELLS = ATLAS_LAYER_SIZE / ALIGN;
const LAYER_CELLS = CELLS * CELLS;
/** The most grid cells one planning item visits: one layer of a free-space search. */
export const REPACK_ITEM_MAX_WORK = 2 * LAYER_CELLS;

/** Runs a repack plan in steps of bounded work, so it can spread over frames. */
export class RepackPlanner {
    /** Grid cells visited by the last `step`. */
    lastWork = 0;
    private readonly run: Generator<number, RepackPlan | null>;

    constructor(live: ReadonlyMap<number, AtlasRect>, added: readonly ({ id: number } & SlotSize)[], layers: number) {
        this.run = repackSteps(live, added, layers);
    }

    /** Undefined while unfinished; may overrun `maxWork` by up to `REPACK_ITEM_MAX_WORK`. */
    step(maxWork: number): RepackPlan | null | undefined {
        this.lastWork = 0;
        while (this.lastWork < maxWork) {
            const next = this.run.next();
            if (next.done) return next.value;
            this.lastWork += next.value;
        }
        return undefined;
    }
}

export function planRepack(
    live: ReadonlyMap<number, AtlasRect>,
    added: readonly ({ id: number } & SlotSize)[],
    layers: number,
): RepackPlan | null {
    const planner = new RepackPlanner(live, added, layers);
    let plan: RepackPlan | null | undefined;
    while ((plan = planner.step(Infinity)) === undefined);
    return plan;
}

/**
 * Yields the cells each item visits. Moves are re-checked only when cells of
 * their target are vacated; a cycle is broken by parking one slot in free
 * space, and eviction is the last resort.
 */
function* repackSteps(
    live: ReadonlyMap<number, AtlasRect>,
    added: readonly ({ id: number } & SlotSize)[],
    layers: number,
): Generator<number, RepackPlan | null> {
    const sizes = [...Array.from(live, ([id, rect]) => ({ id, w: rect.w, h: rect.h })), ...added];
    const packed = pack(sizes, layers);
    yield sizes.length;
    if (!packed) return null;
    const targets = packed.rects;

    const owner = new Int32Array(layers * LAYER_CELLS).fill(-1);
    const targetOwner = new Int32Array(layers * LAYER_CELLS).fill(-1);
    const pendingTarget = new Int32Array(layers * LAYER_CELLS).fill(-1);
    yield layers * CELLS;
    for (const [id, rect] of live) yield paint(owner, rect, id);
    for (const [id, rect] of targets) {
        yield paint(targetOwner, rect, id);
        if (!live.has(id) || !sameRect(live.get(id)!, rect)) paint(pendingTarget, rect, id);
    }

    const current = new Map(live);
    const pending = new Set([...live.keys()].filter((id) => !sameRect(live.get(id)!, targets.get(id)!)));
    const queue = [...pending];
    const queued = new Set(queue);
    let head = 0;
    const parked = new Set<number>();
    const steps: RepackStep[] = [];

    const vacate = (id: number, r: AtlasRect): number => {
        const base = r.layer * LAYER_CELLS;
        for (let y = r.y / ALIGN; y < (r.y + r.h) / ALIGN; y++) {
            for (let c = base + y * CELLS + r.x / ALIGN, end = c + r.w / ALIGN; c < end; c++) {
                if (owner[c] !== id) continue;
                owner[c] = -1;
                const t = targetOwner[c];
                if (t !== -1 && pending.has(t) && !queued.has(t)) {
                    queue.push(t);
                    queued.add(t);
                }
            }
        }
        return area(r) / (ALIGN * ALIGN);
    };
    const move = (id: number, to: AtlasRect): number => {
        const work = vacate(id, current.get(id)!) + paint(owner, to, id);
        current.set(id, to);
        steps.push({ id, kind: 'move', to });
        return work;
    };
    const clear = (id: number, r: AtlasRect): boolean => {
        const base = r.layer * LAYER_CELLS;
        for (let y = r.y / ALIGN; y < (r.y + r.h) / ALIGN; y++) {
            for (let c = base + y * CELLS + r.x / ALIGN, end = c + r.w / ALIGN; c < end; c++) {
                if (owner[c] !== -1 && owner[c] !== id) return false;
            }
        }
        return true;
    };

    while (pending.size > 0) {
        while (head < queue.length) {
            const id = queue[head++];
            queued.delete(id);
            if (!pending.has(id)) continue;
            const to = targets.get(id)!;
            let work = area(to) / (ALIGN * ALIGN);
            if (clear(id, to)) {
                work += move(id, to);
                pending.delete(id);
                work += paint(pendingTarget, to, -1);
            }
            yield work;
        }
        if (pending.size === 0) break;

        const candidates = [...pending].filter((id) => !parked.has(id)).sort((a, b) => area(current.get(a)!) - area(current.get(b)!));
        let parkedOne = false;
        for (const id of candidates) {
            const { w, h } = current.get(id)!;
            const to = (yield* findFree(owner, pendingTarget, id, w, h, layers))
                ?? (yield* findFree(owner, null, id, w, h, layers));
            if (!to) continue;
            yield move(id, to);
            parked.add(id);
            queue.push(id);
            queued.add(id);
            parkedOne = true;
            break;
        }
        if (parkedOne) continue;

        let victim = -1;
        for (const id of pending) {
            if (victim === -1 || area(current.get(id)!) < area(current.get(victim)!)) victim = id;
        }
        yield vacate(victim, current.get(victim)!);
        steps.push({ id: victim, kind: 'evict' });
        pending.delete(victim);
        current.delete(victim);
    }
    return { packer: packed.packer, targets, steps };
}

function paint(grid: Int32Array, r: AtlasRect, id: number): number {
    const base = r.layer * LAYER_CELLS;
    for (let y = r.y / ALIGN; y < (r.y + r.h) / ALIGN; y++) {
        grid.fill(id, base + y * CELLS + r.x / ALIGN, base + y * CELLS + (r.x + r.w) / ALIGN);
    }
    return r.h / ALIGN;
}

const summed = new Int32Array((CELLS + 1) * (CELLS + 1));

/**
 * First fit on the alignment grid via a summed-area table, one layer per item.
 * Cells held by `owner`, or by `avoid` for another slot, are blocked.
 */
function* findFree(
    owner: Int32Array,
    avoid: Int32Array | null,
    id: number,
    w: number,
    h: number,
    layers: number,
): Generator<number, AtlasRect | null> {
    const cw = w / ALIGN;
    const ch = h / ALIGN;
    const stride = CELLS + 1;
    for (let layer = 0; layer < layers; layer++) {
        const base = layer * LAYER_CELLS;
        for (let y = 0; y < CELLS; y++) {
            let row = 0;
            for (let x = 0; x < CELLS; x++) {
                const c = base + y * CELLS + x;
                if (owner[c] !== -1 || (avoid !== null && avoid[c] !== -1 && avoid[c] !== id)) row++;
                summed[(y + 1) * stride + x + 1] = summed[y * stride + x + 1] + row;
            }
        }
        let found: AtlasRect | null = null;
        for (let y = 0; y + ch <= CELLS && !found; y++) {
            for (let x = 0; x + cw <= CELLS; x++) {
                const used = summed[(y + ch) * stride + x + cw] - summed[y * stride + x + cw]
                    - summed[(y + ch) * stride + x] + summed[y * stride + x];
                if (used === 0) {
                    found = { layer, x: x * ALIGN, y: y * ALIGN, w, h };
                    break;
                }
            }
        }
        yield 2 * LAYER_CELLS;
        if (found) return found;
    }
    return null;
}

const area = (r: AtlasRect): number => r.w * r.h;

function sameRect(a: AtlasRect, b: AtlasRect): boolean {
    return a.layer === b.layer && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
