import {
    ATLAS_GUTTER,
    ATLAS_LAYER_SIZE,
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
} from './halo-atlas-plan.js';
import type { HaloQuad } from './geometry-store.js';
import type { HaloState, HaloStep } from './halo-recipe.js';

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

export interface HaloBuild {
    readonly groupId: number;
    readonly silhouette: HaloSilhouette;
    readonly steps: readonly HaloStep[];
    readonly layout: HaloLayout;
    /** The atlas texels the build writes; the scratch targets use its size from the origin. */
    readonly region: AtlasRect;
    readonly slot: Slot;
    readonly want: Want;
}

export interface HaloMove {
    from: AtlasRect;
    to: AtlasRect;
}

const sameWant = (content: Content | null, want: Want | null | undefined): boolean =>
    !!content && !!want && content.state === want.state && content.key === want.key;

export class HaloSlots {
    readonly layers: number;
    /** Bumped whenever some group's `slotsOf` changes. */
    layoutRevision = 0;
    private readonly source: HaloSource;
    private packer: ShelfPacker;
    private readonly slots = new Map<number, Slot>();
    private readonly freeIndices: number[];
    private readonly groups = new Map<number, Group>();
    private readonly queue = new Set<number>();
    private readonly changed = new Set<number>();
    private readonly needSlots = new Map<number, SlotSize>();
    private planning: Planning | null = null;
    private repackSteps: { slot: Slot; step: RepackStep }[] = [];

    /** `capacity` is the number of slot indices available for halo quads in the vertex buffer. */
    constructor(plan: AtlasPlan, capacity: number, source: HaloSource) {
        this.source = source;
        this.layers = plan.layers;
        this.packer = plan.packer;
        this.freeIndices = Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
        for (const [groupId, rect] of plan.slots) {
            const slot = this.addSlot(rect);
            if (!slot) continue;
            this.groups.set(groupId, { refPiece: -1, slot, want: undefined, retiring: [], failedSize: null });
        }
    }

    get pending(): boolean {
        return this.queue.size > 0 || this.repacking || this.needSlots.size > 0;
    }

    get repacking(): boolean {
        return this.planning !== null || this.repackSteps.length > 0;
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

    placeWaitingSlots(): void {
        if (this.repacking || this.needSlots.size === 0) return;
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

    /** False when no plan is in progress. */
    planStep(maxWork: number): boolean {
        if (!this.planning) return false;
        const plan = this.planning.planner.step(maxWork);
        if (plan !== undefined) this.adoptRepack(plan);
        return true;
    }

    /** The next halo to copy to its repacked place; evictions on the way are applied here. */
    nextMove(): HaloMove | null {
        for (let next = this.repackSteps.shift(); next; next = this.repackSteps.shift()) {
            const { slot, step } = next;
            if (this.slots.get(slot.index) !== slot) continue;
            if (step.kind === 'evict') {
                this.evict(slot);
                continue;
            }
            const from = slot.rect;
            slot.rect = step.to;
            this.changed.add(slot.index);
            return { from, to: step.to };
        }
        return null;
    }

    nextBuild(): HaloBuild | null {
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
            return { groupId, silhouette, steps, layout, region: { ...slot.rect, ...size }, slot, want };
        }
        return null;
    }

    isCurrent(build: HaloBuild): boolean {
        const group = this.groups.get(build.groupId);
        return !!group && group.slot === build.slot && group.want === build.want;
    }

    /** Call once the build's pixels are in its region. */
    commit(build: HaloBuild): void {
        const { slot, want, layout, silhouette } = build;
        slot.content = { ...want, layout, refSlot: silhouette.refSlot };
        this.changed.add(slot.index);
        const group = this.groups.get(build.groupId)!;
        this.setShown(group, true);
        this.freeRetiring(group);
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

    private setShown(group: Group, shown: boolean): void {
        const slot = group.slot;
        if (!slot || slot.visible === shown) return;
        slot.visible = shown;
        this.changed.add(slot.index);
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
        console.warn(`No room for group ${groupId}'s ${size.w}×${size.h} halo slot`);
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
        this.changed.add(index);
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
            this.changed.add(index);
            this.layoutRevision++;
            group.slot = slot;
            this.queue.add(groupId);
        }
        this.repackSteps = plan.steps.flatMap((step) => {
            const slot = this.slots.get(step.id);
            return slot && !freed.has(step.id) ? [{ slot, step }] : [];
        });
    }

    private evict(slot: Slot): void {
        slot.content = null;
        slot.rect = slot.reserved;
        this.changed.add(slot.index);
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
    }
}
