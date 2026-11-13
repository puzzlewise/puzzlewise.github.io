import { afterEach, describe, expect, test, vi } from 'vitest';
import { ATLAS_LAYER_SIZE, type Bounds, planAtlas, RepackPlanner, slotSize } from './halo-atlas-plan.js';
import { ShaderBuildError } from './gl-context.js';
import { createHaloPrograms, HaloAtlas, type HaloAtlasOptions, type HaloSource } from './halo-gl.js';
import { BLUR_Y_FS } from './shaders.js';
import { haloSteps } from './halo-recipe.js';

function fakeGl(fails: (source: string) => boolean = () => false) {
    const calls: { name: string; args: unknown[] }[] = [];
    const sources = new Map<unknown, string>();
    const gl = new Proxy({} as Record<string | symbol, unknown>, {
        get(_target, name) {
            if (typeof name !== 'string') return undefined;
            if (/^[A-Z0-9_]+$/.test(name)) return name;
            return (...args: unknown[]) => {
                calls.push({ name, args });
                if (name === 'shaderSource') sources.set(args[0], args[1] as string);
                if (name === 'getShaderParameter') return !fails(sources.get(args[0]) ?? '');
                if (name === 'getProgramParameter') return true;
                if (name === 'isContextLost') return false;
                if (name === 'getShaderInfoLog') return 'log';
                return {};
            };
        },
    }) as unknown as WebGL2RenderingContext;
    const count = (name: string) => calls.filter((call) => call.name === name).length;
    return { gl, calls, count };
}

interface FakeGroup {
    refPiece: number;
    fills: Bounds;
}

function square(size: number): Bounds {
    return { minX: 0, minY: 0, maxX: size, maxY: size };
}

function setup(groups: Map<number, FakeGroup>, layers = 1, options: Partial<HaloAtlasOptions> = {}) {
    const { gl, calls, count } = fakeGl();
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
        layers,
    );
    const atlas = new HaloAtlas(gl, createHaloPrograms(gl)!, source, {
        plan, capacity: 64, vertexBuffer: {} as WebGLBuffer, ...options,
    });
    return { atlas, calls, count, pieceGroup };
}

const drawnSlots = (atlas: HaloAtlas, groupId: number): number[] =>
    atlas.slotsOf(groupId).filter((index) => atlas.quad(index) !== null);

const finish = (atlas: HaloAtlas): void => {
    for (let i = 0; i < 100 && atlas.pending; i++) atlas.buildPending(1000);
};

describe('HaloAtlas', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a requested halo is drawn only once its build is copied into the atlas', () => {
        const { atlas, count, calls } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        atlas.request(1, 'selected', 'k');
        expect(drawnSlots(atlas, 1)).toEqual([]);

        finish(atlas);
        atlas.request(1, 'selected', 'k');
        expect(drawnSlots(atlas, 1)).toHaveLength(1);
        expect(count('copyTexSubImage3D')).toBe(1);
        expect(count('generateMipmap')).toBe(0);
        const levels = calls.filter((c) => c.name === 'framebufferTextureLayer').map((c) => c.args[3]);
        expect(levels).toEqual([1, 2, 3]);
        expect(atlas.pending).toBe(false);
    });

    test('a build covers its own halo region, not the slot it may share with larger states', () => {
        const { atlas, calls } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        const [slot] = atlas.slotsOf(1);
        expect(slotSize(square(100))).toEqual({ w: 136, h: 136 });
        for (const [state, side] of [['selected', 112], ['dragging', 40]] as const) {
            const start = calls.length;
            atlas.request(1, state, 'k');
            finish(atlas);
            const build = calls.slice(start);
            const rect = atlas['slots'].get(slot)!.rect;
            const copy = build.filter((c) => c.name === 'copyTexSubImage3D');
            expect(copy.map((c) => c.args)).toEqual([['TEXTURE_2D_ARRAY', 0, rect.x, rect.y, rect.layer, 0, 0, side, side]]);
            const viewports = build.filter((c) => c.name === 'viewport').map((c) => c.args);
            expect(new Set(viewports.slice(0, -3).map(String))).toEqual(new Set([String([0, 0, side, side])]));
            expect(viewports.slice(-3).map((v) => v.slice(2))).toEqual([[side / 2, side / 2], [side / 4, side / 4], [side / 8, side / 8]]);
            const scissors = build.filter((c) => c.name === 'scissor').map((c) => c.args as number[]);
            for (const [x, y, w, h] of scissors) {
                expect([x, w]).toEqual([0, side]);
                expect(y + h).toBeLessThanOrEqual(side);
            }
            const sizes = build.filter((c) => c.name === 'uniform2i' || c.name === 'uniform2f').map((c) => c.args.slice(1));
            expect(sizes).toContainEqual([side, side]);
            expect(sizes).not.toContainEqual([136, 136]);
        }
    });

    test('the quad covers the halo image in the reference frame and its atlas texels', () => {
        const { atlas } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        atlas.request(1, 'selected', 'k');
        finish(atlas);
        const quad = atlas.quad(drawnSlots(atlas, 1)[0])!;
        expect(quad.refSlot).toBe(10);
        expect(quad.x0).toBe(-132);
        expect(quad.x1).toBe(232);
        expect((quad.u1 - quad.u0) * ATLAS_LAYER_SIZE).toBe(91);
    });

    test('a state change keeps drawing the previous halo until the new one is copied in', () => {
        const { atlas } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        atlas.request(1, 'selected', 'k');
        finish(atlas);
        const slot = drawnSlots(atlas, 1)[0];
        const selected = atlas.quad(slot);

        atlas.request(1, 'selected-dragging', 'k');
        expect(atlas.pending).toBe(true);
        atlas.buildPending(0);
        expect(drawnSlots(atlas, 1)).toEqual([slot]);
        expect(atlas.quad(slot)).toEqual(selected);

        finish(atlas);
        expect(drawnSlots(atlas, 1)).toEqual([slot]);
        expect(atlas.quad(slot)!.x0).toBeLessThan(selected!.x0);
    });

    test('hiding stops drawing at once, and the same halo comes back without a rebuild', () => {
        const { atlas, count } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        atlas.request(1, 'selected', 'k');
        finish(atlas);
        const [slot] = atlas.slotsOf(1);
        atlas.takeChangedSlots();
        const layout = atlas.layoutRevision;

        atlas.hide(1);
        expect(drawnSlots(atlas, 1)).toEqual([]);
        expect(atlas.takeChangedSlots()).toEqual([slot]);
        expect(atlas.layoutRevision).toBe(layout);
        atlas.request(1, 'selected', 'k');
        expect(drawnSlots(atlas, 1)).toHaveLength(1);
        expect(atlas.pending).toBe(false);
        expect(count('copyTexSubImage3D')).toBe(1);
    });

    test('a hidden group does not show its stale halo while a new state builds', () => {
        const { atlas } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        atlas.request(1, 'selected', 'k');
        finish(atlas);
        atlas.hide(1);
        atlas.request(1, 'dragging', 'k');
        expect(drawnSlots(atlas, 1)).toEqual([]);
    });

    test('on a merge the absorbed halos draw under the merged group until its halo lands, then free', () => {
        const groups = new Map([
            [1, { refPiece: 10, fills: square(100) }],
            [2, { refPiece: 20, fills: square(100) }],
        ]);
        const { atlas, pieceGroup } = setup(groups);
        atlas.request(1, 'selected', 'a');
        atlas.request(2, 'selected', 'b');
        finish(atlas);
        const [old1] = drawnSlots(atlas, 1);
        const [old2] = drawnSlots(atlas, 2);

        groups.delete(2);
        groups.set(1, { refPiece: 10, fills: square(220) });
        pieceGroup.set(20, 1);
        atlas.release(2);
        atlas.request(1, 'selected', 'ab');
        expect(new Set(drawnSlots(atlas, 1))).toEqual(new Set([old1, old2]));
        expect(drawnSlots(atlas, 2)).toEqual([]);

        finish(atlas);
        const drawn = drawnSlots(atlas, 1);
        expect(drawn).toHaveLength(1);
        expect(atlas.quad(old2)).toBeNull();
        expect(atlas.quad(drawn[0])!.x1).toBe(220 + 132);
    });

    test('a released group whose pieces left the table frees its slot', () => {
        const groups = new Map([[1, { refPiece: 10, fills: square(100) }]]);
        const { atlas, pieceGroup } = setup(groups);
        atlas.request(1, 'selected', 'a');
        finish(atlas);
        const [slot] = drawnSlots(atlas, 1);
        pieceGroup.delete(10);
        atlas.release(1);
        expect(atlas.quad(slot)).toBeNull();
    });

    test('each call stops at its time budget and resumes on the next', () => {
        const groups = new Map(Array.from({ length: 6 }, (_, i) => [i, { refPiece: i, fills: square(100) }] as const));
        const { gl } = fakeGl();
        let clock = 0;
        const source: HaloSource = {
            layout: (id) => groups.get(id) ?? null,
            silhouette: (id) => ({ refSlot: id, bounds: groups.get(id)!.fills, indices: new Uint32Array(3) }),
            steps: (state) => haloSteps(state, 'outline', [1, 0, 0, 1]),
            groupOfPiece: () => undefined,
        };
        const plan = planAtlas([...groups].map(([id, g]) => ({ id, ...slotSize(g.fills) })), { w: 512, h: 512 });
        const atlas = new HaloAtlas(gl, createHaloPrograms(gl)!, source, {
            plan, capacity: 16, vertexBuffer: {} as WebGLBuffer, now: () => clock++,
        });
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        atlas.buildPending(5);
        const built = [...groups.keys()].filter((id) => drawnSlots(atlas, id).length > 0).length;
        expect(built).toBeLessThan(groups.size);
        let calls = 1;
        while (atlas.pending && calls < 200) {
            atlas.buildPending(5);
            calls++;
        }
        expect(atlas.pending).toBe(false);
        expect(calls).toBeGreaterThan(2);
        for (const id of groups.keys()) expect(drawnSlots(atlas, id)).toHaveLength(1);
    });

    test('a slot that no longer fits anywhere is placed by a repack that keeps the other halos', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        const { atlas, count, pieceGroup } = setup(groups);
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        finish(atlas);
        const before = new Map([...groups.keys()].map((id) => [id, atlas.quad(drawnSlots(atlas, id)[0])]));

        // Groups 1, 3, 5 leave; 0 grows into a slot only a repack can make room for.
        for (const id of [1, 3, 5]) {
            groups.delete(id);
            pieceGroup.delete(id);
            atlas.release(id);
        }
        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.request(0, 'selected', 'big');
        expect(atlas.pending).toBe(true);
        finish(atlas);

        expect(count('copyTexSubImage2D')).toBeGreaterThan(0);
        expect(atlas.quad(drawnSlots(atlas, 0)[0])!.x1).toBe(3000 + 132);
        for (const id of [2, 4, 6, 7]) {
            const quad = atlas.quad(drawnSlots(atlas, id)[0])!;
            expect({ x0: quad.x0, x1: quad.x1 }).toEqual({ x0: before.get(id)!.x0, x1: before.get(id)!.x1 });
        }
    });

    test('a repack plan runs over several budgeted calls while every halo keeps drawing', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        let clock = 0;
        const { atlas, count, pieceGroup } = setup(groups, 1, { now: () => clock++, planWork: 200 });
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        finish(atlas);
        for (const id of [1, 3, 5]) {
            groups.delete(id);
            pieceGroup.delete(id);
            atlas.release(id);
        }
        const drawn = new Map([0, 2, 4, 6, 7].map((id) => [id, drawnSlots(atlas, id)]));
        const quads = new Map([...drawn].map(([id, slots]) => [id, atlas.quad(slots[0])]));
        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.request(0, 'selected', 'big');

        let calls = 0;
        while (count('copyTexSubImage2D') === 0 && calls < 1000) {
            atlas.buildPending(3);
            calls++;
            if (count('copyTexSubImage2D') > 0) break;
            for (const [id, slots] of drawn) {
                expect(drawnSlots(atlas, id)).toEqual(slots);
                expect(atlas.quad(slots[0])).toEqual(quads.get(id));
            }
        }
        expect(calls).toBeGreaterThan(2);
        finish(atlas);
        expect(atlas.quad(drawnSlots(atlas, 0)[0])!.x1).toBe(3000 + 132);
    });

    test('a group released while a repack is planned leaves its region free afterwards', () => {
        const roomAfter = (releaseWhilePlanning: boolean): number => {
            const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
            let clock = 0;
            const { atlas, pieceGroup } = setup(groups, 1, { now: () => clock++, planWork: 200 });
            const remove = (id: number) => {
                groups.delete(id);
                pieceGroup.delete(id);
                atlas.release(id);
            };
            for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
            finish(atlas);
            for (const id of [1, 3, 5]) remove(id);
            groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
            atlas.request(0, 'selected', 'big');
            atlas.buildPending(3);
            expect(atlas['planning']).not.toBeNull();
            if (releaseWhilePlanning) remove(7);
            finish(atlas);
            if (!releaseWhilePlanning) remove(7);

            let placed = 0;
            for (let id = 100; ; id++) {
                groups.set(id, { refPiece: id, fills: square(1500) });
                atlas.request(id, 'selected', 'k');
                if (atlas.slotsOf(id).length === 0) return placed;
                placed++;
            }
        };
        expect(roomAfter(false)).toBeGreaterThan(0);
        expect(roomAfter(true)).toBe(roomAfter(false));
    });

    test('an evicted halo is rebuilt for its group, and an evicted retiring halo is freed', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        const { atlas, pieceGroup } = setup(groups);
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        finish(atlas);
        const [retiring] = atlas.slotsOf(0);
        const [own] = atlas.slotsOf(2);
        const step = RepackPlanner.prototype.step;
        vi.spyOn(RepackPlanner.prototype, 'step').mockImplementation(function (this: RepackPlanner, maxWork) {
            const plan = step.call(this, maxWork);
            if (!plan) return plan;
            const evicted = [retiring, own];
            const steps = plan.steps.filter((s) => !evicted.includes(s.id));
            return { ...plan, steps: [...evicted.map((id) => ({ id, kind: 'evict' as const })), ...steps] };
        });

        for (const id of [1, 3, 5]) {
            groups.delete(id);
            pieceGroup.delete(id);
            atlas.release(id);
        }
        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.request(0, 'selected', 'big');
        expect(atlas.slotsOf(0)[0]).toBe(retiring);
        finish(atlas);

        expect(atlas['slots'].has(retiring)).toBe(false);
        expect(drawnSlots(atlas, 2)).toEqual([own]);
        expect(atlas.quad(own)!.x1).toBe(1500 + 132);
        expect(atlas.pending).toBe(false);
    });

    test('a group whose new slot finds no free slot index keeps the old halo for its state and stops retrying', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { atlas } = setup(groups, 1, { capacity: 8 });
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        finish(atlas);
        const [old] = drawnSlots(atlas, 0);

        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.request(0, 'selected', 'big');
        finish(atlas);
        expect(atlas.pending).toBe(false);
        expect(drawnSlots(atlas, 0)).toEqual([old]);

        atlas.request(0, 'selected', 'big');
        expect(atlas.pending).toBe(false);
        atlas.request(0, 'dragging', 'big');
        expect(drawnSlots(atlas, 0)).toEqual([]);
        expect(atlas.pending).toBe(false);
        expect(warn.mock.calls).toEqual([[expect.stringContaining('group 0\'s 1152×592 halo slot')]]);
    });

    test('a group that finds space before its waiting slot is placed gets one slot, not two', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        const { atlas, pieceGroup } = setup(groups);
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        finish(atlas);
        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.request(0, 'selected', 'big');
        for (const id of [1, 2, 3, 4, 5]) {
            groups.delete(id);
            pieceGroup.delete(id);
            atlas.release(id);
        }
        atlas.request(0, 'selected', 'big');
        finish(atlas);
        expect(atlas['slots'].size).toBe(3);
    });

    test('when the wanted halo cannot be placed, the old one draws only while it shows the same state', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { atlas } = setup(groups);
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        finish(atlas);
        const [old] = drawnSlots(atlas, 0);

        groups.set(0, { refPiece: 0, fills: square(5000) });
        atlas.request(0, 'selected', 'huge');
        finish(atlas);
        expect(drawnSlots(atlas, 0)).toEqual([old]);

        atlas.request(0, 'dragging', 'huge');
        expect(drawnSlots(atlas, 0)).toEqual([]);
        expect(atlas.pending).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('group 0\'s');
    });

    test('a halo program that fails to build throws, and the programs built before it are deleted', () => {
        const { gl, calls } = fakeGl((source) => source === BLUR_Y_FS);
        expect(() => createHaloPrograms(gl)).toThrow(ShaderBuildError);
        const created = calls.filter((c) => c.name === 'createProgram').length;
        expect(created).toBe(3);
        expect(calls.filter((c) => c.name === 'deleteProgram')).toHaveLength(3);
    });

    test('a state change rewrites only that slot and keeps every slot list', () => {
        const groups = new Map(Array.from({ length: 4 }, (_, i) => [i, { refPiece: i, fills: square(100) }] as const));
        const { atlas } = setup(groups);
        for (const id of groups.keys()) atlas.request(id, 'selected', 'k');
        finish(atlas);
        const lists = [...groups.keys()].map((id) => atlas.slotsOf(id));
        atlas.takeChangedSlots();
        const layout = atlas.layoutRevision;

        atlas.request(2, 'selected-dragging', 'k');
        finish(atlas);
        expect(atlas.takeChangedSlots()).toEqual(atlas.slotsOf(2));
        expect(atlas.layoutRevision).toBe(layout);
        expect([...groups.keys()].map((id) => atlas.slotsOf(id))).toEqual(lists);
    });

    test('a slot that is held but not drawn has no quad', () => {
        const { atlas } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        const [slot] = atlas.slotsOf(1);
        expect(slot).toBeDefined();
        expect(atlas.quad(slot)).toBeNull();
        atlas.request(1, 'selected', 'k');
        finish(atlas);
        atlas.hide(1);
        expect(atlas.slotsOf(1)).toEqual([slot]);
        expect(atlas.quad(slot)).toBeNull();
    });
});
