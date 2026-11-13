import { afterEach, describe, expect, test, vi } from 'vitest';
import { ATLAS_GUTTER, ATLAS_LAYER_SIZE, type Bounds, planAtlas, RepackPlanner, slotSize } from './halo-atlas-plan.js';
import { haloSteps } from './halo-recipe.js';
import { HaloSlots, type HaloSource } from './halo-slots.js';

interface FakeGroup {
    refPiece: number;
    fills: Bounds;
}

function square(size: number): Bounds {
    return { minX: 0, minY: 0, maxX: size, maxY: size };
}

function setup(groups: Map<number, FakeGroup>, capacity = 64) {
    const pieceGroup = new Map<number, number>();
    for (const [id, group] of groups) pieceGroup.set(group.refPiece, id);
    const source: HaloSource = {
        layout: (id) => groups.get(id) ?? null,
        silhouette: (id) => {
            const group = groups.get(id);
            return group ? { refSlot: group.refPiece, bounds: group.fills, indices: new Uint32Array(3) } : null;
        },
        steps: (state) => haloSteps(state, 'outline', [1, 0, 0, 1]),
        groupOfPiece: (piece) => pieceGroup.get(piece),
    };
    const plan = planAtlas(
        [...groups].map(([id, group]) => ({ id, ...slotSize(group.fills) })),
        slotSize(square(ATLAS_LAYER_SIZE / 2)),
    );
    const slots = new HaloSlots(plan, capacity, source);
    checkLayoutAfterChanges(slots);
    const remove = (id: number) => {
        groups.delete(id);
        pieceGroup.delete(id);
        slots.release(id);
    };
    return { slots, pieceGroup, remove };
}

function checkLayoutAfterChanges(slots: HaloSlots): void {
    const lists = () => new Map(slots.groupIds().map((id) => [id, slots.slotsOf(id)]));
    let before = lists();
    let revision = slots.layoutRevision;
    const changed: Set<number> = slots['changed'];
    const reported = new Set<number>();
    const add = changed.add.bind(changed);
    changed.add = (index) => {
        reported.add(index);
        return add(index);
    };
    const check = () => {
        const after = lists();
        const ids = new Set([...before.keys(), ...after.keys()]);
        if ([...ids].some((id) => String(before.get(id) ?? []) !== String(after.get(id) ?? []))) {
            expect(slots.layoutRevision).not.toBe(revision);
        }
        const held = new Set([...before.values()].flat());
        const added = [...after.values()].flat().filter((index) => !held.has(index));
        expect([...reported]).toEqual(expect.arrayContaining(added));
        reported.clear();
        before = after;
        revision = slots.layoutRevision;
    };
    for (const name of ['request', 'hide', 'release', 'placeWaitingSlots', 'planStep', 'nextMove', 'commit'] as const) {
        const method = slots[name] as (...args: unknown[]) => unknown;
        (slots as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
            const result = method.apply(slots, args);
            check();
            return result;
        };
    }
}

const drawnSlots = (slots: HaloSlots, groupId: number): number[] =>
    slots.slotsOf(groupId).filter((index) => slots.quad(index) !== null);

function finish(slots: HaloSlots): { builds: number; moves: number } {
    const done = { builds: 0, moves: 0 };
    for (let i = 0; i < 1000 && slots.pending; i++) {
        slots.placeWaitingSlots();
        if (slots.planStep(Infinity)) continue;
        if (slots.nextMove()) {
            done.moves++;
            continue;
        }
        const build = slots.nextBuild();
        if (!build) continue;
        expect(slots.isCurrent(build)).toBe(true);
        slots.commit(build);
        done.builds++;
    }
    return done;
}

const eightLargeGroups = () =>
    new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));

const WIDE = { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } };

describe('HaloSlots', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a requested halo is drawn only once its build is committed', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        slots.request(1, 'selected', 'k');
        expect(drawnSlots(slots, 1)).toEqual([]);
        expect(slots.pending).toBe(true);

        expect(finish(slots).builds).toBe(1);
        slots.request(1, 'selected', 'k');
        expect(drawnSlots(slots, 1)).toHaveLength(1);
        expect(slots.pending).toBe(false);
    });

    test('a build covers its own halo region at the slot origin, not the whole slot', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        expect(slotSize(square(100))).toEqual({ w: 96, h: 96 });
        for (const [state, side] of [['selected', 88], ['dragging', 40]] as const) {
            slots.request(1, state, 'k');
            const build = slots.nextBuild()!;
            const quad = () => slots.quad(slots.slotsOf(1)[0]);
            expect(build.region).toMatchObject({ w: side, h: side });
            slots.commit(build);
            const { u0, v0 } = quad()!;
            expect(build.region.x).toBe(u0 * ATLAS_LAYER_SIZE - ATLAS_GUTTER);
            expect(build.region.y).toBe(v0 * ATLAS_LAYER_SIZE - ATLAS_GUTTER);
        }
    });

    test('a build no longer wanted is not current', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        slots.request(1, 'selected', 'k');
        const build = slots.nextBuild()!;
        slots.request(1, 'dragging', 'k');
        expect(slots.isCurrent(build)).toBe(false);
    });

    test('the quad covers the halo image in the reference frame and its atlas texels', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        slots.request(1, 'selected', 'k');
        finish(slots);
        const quad = slots.quad(drawnSlots(slots, 1)[0])!;
        expect(quad.refSlot).toBe(10);
        expect(quad.x0).toBe(-88);
        expect(quad.x1).toBe(188);
        expect((quad.u1 - quad.u0) * ATLAS_LAYER_SIZE).toBe(69);
    });

    test('a state change keeps drawing the previous halo until the new one is committed', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        slots.request(1, 'selected', 'k');
        finish(slots);
        const slot = drawnSlots(slots, 1)[0];
        const selected = slots.quad(slot);

        slots.request(1, 'selected-dragging', 'k');
        expect(slots.pending).toBe(true);
        expect(drawnSlots(slots, 1)).toEqual([slot]);
        expect(slots.quad(slot)).toEqual(selected);

        finish(slots);
        expect(drawnSlots(slots, 1)).toEqual([slot]);
        expect(slots.quad(slot)!.x0).toBeLessThan(selected!.x0);
    });

    test('hiding stops drawing at once, and the same halo comes back without a rebuild', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        slots.request(1, 'selected', 'k');
        finish(slots);
        const [slot] = slots.slotsOf(1);
        slots.takeChangedSlots();
        const layout = slots.layoutRevision;

        slots.hide(1);
        expect(drawnSlots(slots, 1)).toEqual([]);
        expect(slots.takeChangedSlots()).toEqual([slot]);
        expect(slots.layoutRevision).toBe(layout);
        slots.request(1, 'selected', 'k');
        expect(drawnSlots(slots, 1)).toHaveLength(1);
        expect(slots.pending).toBe(false);
    });

    test('hiding a group whose earlier halo is retiring stops drawing it and frees it', () => {
        const groups = new Map([[1, { refPiece: 10, fills: square(100) }]]);
        const { slots } = setup(groups);
        slots.request(1, 'selected', 'a');
        finish(slots);
        const [old] = drawnSlots(slots, 1);
        groups.set(1, { refPiece: 10, fills: square(300) });
        slots.request(1, 'selected', 'b');
        expect(slots.slotsOf(1)).toHaveLength(2);
        expect(drawnSlots(slots, 1)).toEqual([old]);

        slots.hide(1);
        expect(drawnSlots(slots, 1)).toEqual([]);
        expect(slots.slotsOf(1)).toHaveLength(1);
        expect(slots['slots'].has(old)).toBe(false);
    });

    test('a hidden group does not show its stale halo while a new state builds', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        slots.request(1, 'selected', 'k');
        finish(slots);
        slots.hide(1);
        slots.request(1, 'dragging', 'k');
        expect(drawnSlots(slots, 1)).toEqual([]);
    });

    test('on a merge the absorbed halos draw under the merged group until its halo lands, then free', () => {
        const groups = new Map([
            [1, { refPiece: 10, fills: square(100) }],
            [2, { refPiece: 20, fills: square(100) }],
        ]);
        const { slots, pieceGroup } = setup(groups);
        slots.request(1, 'selected', 'a');
        slots.request(2, 'selected', 'b');
        finish(slots);
        const [old1] = drawnSlots(slots, 1);
        const [old2] = drawnSlots(slots, 2);

        groups.delete(2);
        groups.set(1, { refPiece: 10, fills: square(220) });
        pieceGroup.set(20, 1);
        slots.release(2);
        slots.request(1, 'selected', 'ab');
        expect(new Set(drawnSlots(slots, 1))).toEqual(new Set([old1, old2]));
        expect(drawnSlots(slots, 2)).toEqual([]);

        finish(slots);
        const drawn = drawnSlots(slots, 1);
        expect(drawn).toHaveLength(1);
        expect(slots.quad(old2)).toBeNull();
        expect(slots.quad(drawn[0])!.x1).toBe(220 + 88);
    });

    test('a released group whose pieces left the table frees its slot', () => {
        const groups = new Map([[1, { refPiece: 10, fills: square(100) }]]);
        const { slots, remove } = setup(groups);
        slots.request(1, 'selected', 'a');
        finish(slots);
        const [slot] = drawnSlots(slots, 1);
        remove(1);
        expect(slots.quad(slot)).toBeNull();
    });

    test('a slot that no longer fits anywhere is placed by a repack that keeps the other halos', () => {
        const groups = eightLargeGroups();
        const { slots, remove } = setup(groups);
        for (const id of groups.keys()) slots.request(id, 'selected', 'k');
        finish(slots);
        const before = new Map([...groups.keys()].map((id) => [id, slots.quad(drawnSlots(slots, id)[0])]));

        for (const id of [1, 3, 5]) remove(id);
        groups.set(0, WIDE);
        slots.request(0, 'selected', 'big');
        expect(slots.pending).toBe(true);
        const { moves } = finish(slots);

        expect(moves).toBeGreaterThan(0);
        expect(slots.quad(drawnSlots(slots, 0)[0])!.x1).toBe(3000 + 88);
        for (const id of [2, 4, 6, 7]) {
            const quad = slots.quad(drawnSlots(slots, id)[0])!;
            expect({ x0: quad.x0, x1: quad.x1 }).toEqual({ x0: before.get(id)!.x0, x1: before.get(id)!.x1 });
        }
    });

    test('a group released while a repack is planned leaves its region free afterwards', () => {
        const roomAfter = (releaseWhilePlanning: boolean): number => {
            const groups = eightLargeGroups();
            const { slots, remove } = setup(groups);
            for (const id of groups.keys()) slots.request(id, 'selected', 'k');
            finish(slots);
            for (const id of [1, 3, 5]) remove(id);
            groups.set(0, WIDE);
            slots.request(0, 'selected', 'big');
            slots.placeWaitingSlots();
            slots.planStep(200);
            expect(slots['planning']).not.toBeNull();
            if (releaseWhilePlanning) remove(7);
            finish(slots);
            if (!releaseWhilePlanning) remove(7);

            let placed = 0;
            for (let id = 100; ; id++) {
                groups.set(id, { refPiece: id, fills: square(1500) });
                slots.request(id, 'selected', 'k');
                if (slots.slotsOf(id).length === 0) return placed;
                placed++;
            }
        };
        expect(roomAfter(false)).toBeGreaterThan(0);
        expect(roomAfter(true)).toBe(roomAfter(false));
    });

    test('groups requested while a repack is planned get one slot each once it is adopted', () => {
        const groups = eightLargeGroups();
        const { slots, remove } = setup(groups);
        for (const id of groups.keys()) slots.request(id, 'selected', 'k');
        finish(slots);
        for (const id of [1, 3, 5]) remove(id);
        groups.set(0, WIDE);
        slots.request(0, 'selected', 'big');
        slots.placeWaitingSlots();
        slots.planStep(200);
        expect(slots['planning']).not.toBeNull();
        slots.request(0, 'selected', 'big');
        groups.set(100, { refPiece: 100, fills: square(100) });
        slots.request(100, 'selected', 'k');
        finish(slots);

        const held = slots.groupIds().flatMap((id) => slots.slotsOf(id));
        expect([...slots['slots'].keys()].sort((a, b) => a - b)).toEqual(held.sort((a, b) => a - b));
        expect(drawnSlots(slots, 0)).toHaveLength(1);
        expect(slots.quad(drawnSlots(slots, 0)[0])!.x1).toBe(3000 + 88);
        expect(drawnSlots(slots, 100)).toHaveLength(1);
    });

    test('an evicted halo is rebuilt for its group, and an evicted retiring halo is freed', () => {
        const groups = eightLargeGroups();
        const { slots, remove } = setup(groups);
        for (const id of groups.keys()) slots.request(id, 'selected', 'k');
        finish(slots);
        const [retiring] = slots.slotsOf(0);
        const [own] = slots.slotsOf(2);
        const step = RepackPlanner.prototype.step;
        vi.spyOn(RepackPlanner.prototype, 'step').mockImplementation(function (this: RepackPlanner, maxWork) {
            const plan = step.call(this, maxWork);
            if (!plan) return plan;
            const evicted = [retiring, own];
            const steps = plan.steps.filter((s) => !evicted.includes(s.id));
            return { ...plan, steps: [...evicted.map((id) => ({ id, kind: 'evict' as const })), ...steps] };
        });

        for (const id of [1, 3, 5]) remove(id);
        groups.set(0, WIDE);
        slots.request(0, 'selected', 'big');
        expect(slots.slotsOf(0)[0]).toBe(retiring);
        finish(slots);

        expect(slots['slots'].has(retiring)).toBe(false);
        const evicted = slots['slots'].get(own)!;
        expect(evicted.rect).toEqual(evicted.reserved);
        expect(drawnSlots(slots, 2)).toEqual([own]);
        expect(slots.quad(own)!.x1).toBe(1500 + 88);
        expect(slots.pending).toBe(false);
    });

    test('a group whose new slot finds no free slot index keeps the old halo for its state and stops retrying', () => {
        const groups = eightLargeGroups();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { slots } = setup(groups, 8);
        for (const id of groups.keys()) slots.request(id, 'selected', 'k');
        finish(slots);
        const [old] = drawnSlots(slots, 0);

        groups.set(0, WIDE);
        slots.request(0, 'selected', 'big');
        finish(slots);
        expect(slots.pending).toBe(false);
        expect(drawnSlots(slots, 0)).toEqual([old]);

        slots.request(0, 'selected', 'big');
        expect(slots.pending).toBe(false);
        slots.request(0, 'dragging', 'big');
        expect(drawnSlots(slots, 0)).toEqual([]);
        expect(slots.pending).toBe(false);
        expect(warn.mock.calls).toEqual([['No room for group 0\'s 1152×592 halo slot']]);
    });

    test('a group that finds space before its waiting slot is placed gets one slot, not two', () => {
        const groups = eightLargeGroups();
        const { slots, remove } = setup(groups);
        for (const id of groups.keys()) slots.request(id, 'selected', 'k');
        finish(slots);
        groups.set(0, WIDE);
        slots.request(0, 'selected', 'big');
        for (const id of [1, 2, 3, 4, 5]) remove(id);
        slots.request(0, 'selected', 'big');
        finish(slots);
        expect(slots['slots'].size).toBe(3);
    });

    test('when the wanted halo cannot be placed, the old one draws only while it shows the same state', () => {
        const groups = eightLargeGroups();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { slots } = setup(groups);
        for (const id of groups.keys()) slots.request(id, 'selected', 'k');
        finish(slots);
        const [old] = drawnSlots(slots, 0);

        groups.set(0, { refPiece: 0, fills: square(5000) });
        slots.request(0, 'selected', 'huge');
        finish(slots);
        expect(drawnSlots(slots, 0)).toEqual([old]);

        slots.request(0, 'dragging', 'huge');
        expect(drawnSlots(slots, 0)).toEqual([]);
        expect(slots.pending).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('group 0\'s');
    });

    test('a state change rewrites only that slot and keeps every slot list', () => {
        const groups = new Map(Array.from({ length: 4 }, (_, i) => [i, { refPiece: i, fills: square(100) }] as const));
        const { slots } = setup(groups);
        for (const id of groups.keys()) slots.request(id, 'selected', 'k');
        finish(slots);
        const lists = [...groups.keys()].map((id) => slots.slotsOf(id));
        slots.takeChangedSlots();
        const layout = slots.layoutRevision;

        slots.request(2, 'selected-dragging', 'k');
        finish(slots);
        expect(slots.takeChangedSlots()).toEqual(slots.slotsOf(2));
        expect(slots.layoutRevision).toBe(layout);
        expect([...groups.keys()].map((id) => slots.slotsOf(id))).toEqual(lists);
    });

    test('a slot that is held but not drawn has no quad', () => {
        const { slots } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        const [slot] = slots.slotsOf(1);
        expect(slot).toBeDefined();
        expect(slots.quad(slot)).toBeNull();
        slots.request(1, 'selected', 'k');
        finish(slots);
        slots.hide(1);
        expect(slots.slotsOf(1)).toEqual([slot]);
        expect(slots.quad(slot)).toBeNull();
    });
});
