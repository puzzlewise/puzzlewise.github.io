import { describe, expect, test } from 'vitest';
import type { RendererAppearance } from '../appearance.js';
import { ATLAS_GUTTER, ATLAS_LAYER_SIZE, type AtlasRect, type Bounds, planAtlas, slotSize } from './halo-atlas-plan.js';
import { ShaderBuildError } from './gl-context.js';
import { createHaloPrograms, HaloAtlas, type HaloAtlasOptions } from './halo-gl.js';
import type { HaloSource } from './halo-slots.js';
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
                if (name === 'getUniformLocation') return args[1];
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

function setup(
    groups: Map<number, FakeGroup>,
    layers = 1,
    options: Partial<HaloAtlasOptions> = {},
    outline: RendererAppearance['outline'] = 'outline',
) {
    const { gl, calls, count } = fakeGl();
    const pieceGroup = new Map<number, number>();
    for (const [id, group] of groups) pieceGroup.set(group.refPiece, id);
    const source: HaloSource = {
        layout: (id) => groups.get(id) ?? null,
        silhouette: (id) => {
            const group = groups.get(id);
            return group ? { refSlot: group.refPiece, bounds: group.fills, indices: new Uint32Array(3) } : null;
        },
        steps: (state) => haloSteps(state, outline, [1, 0, 0, 1]),
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
    atlas.slots.slotsOf(groupId).filter((index) => atlas.slots.quad(index) !== null);

const finish = (atlas: HaloAtlas): void => {
    for (let i = 0; i < 100 && atlas.pending; i++) atlas.buildPending(1000);
};

describe('HaloAtlas', () => {
    test('a requested halo is drawn only once its build is copied into the atlas', () => {
        const { atlas, count, calls } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        atlas.slots.request(1, 'selected', 'k');
        expect(drawnSlots(atlas, 1)).toEqual([]);

        finish(atlas);
        atlas.slots.request(1, 'selected', 'k');
        expect(drawnSlots(atlas, 1)).toHaveLength(1);
        expect(count('copyTexSubImage3D')).toBe(1);
        expect(count('generateMipmap')).toBe(0);
        const levels = calls.filter((c) => c.name === 'framebufferTextureLayer').map((c) => c.args[3]);
        expect(levels).toEqual([1, 2, 3]);
        expect(atlas.pending).toBe(false);
    });

    test('a build covers its own halo region, not the slot it may share with larger states', () => {
        const { atlas, calls } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        const [slot] = atlas.slots.slotsOf(1);
        expect(slotSize(square(100))).toEqual({ w: 96, h: 96 });
        for (const [state, side] of [['selected', 88], ['dragging', 40]] as const) {
            const start = calls.length;
            atlas.slots.request(1, state, 'k');
            finish(atlas);
            const build = calls.slice(start);
            const rect = atlas.slots['slots'].get(slot)!.rect;
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
            expect(sizes).not.toContainEqual([96, 96]);
        }
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
        for (const id of groups.keys()) atlas.slots.request(id, 'selected', 'k');
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

    test('a call of many tiny builds stops after a bounded number of render passes', () => {
        const groups = new Map(Array.from({ length: 64 }, (_, i) => [i, { refPiece: i, fills: square(1) }] as const));
        const { atlas, calls } = setup(groups, 1, { now: () => 0 }, 'shadow');
        for (const id of groups.keys()) atlas.slots.request(id, 'idle', 'k');
        const passes = new Set(['drawArrays', 'drawElements', 'copyTexSubImage2D', 'copyTexSubImage3D']);
        const start = calls.length;
        atlas.buildPending(1000);
        expect(calls.slice(start).filter((c) => passes.has(c.name)).length).toBeLessThanOrEqual(200);
        const built = [...groups.keys()].filter((id) => drawnSlots(atlas, id).length > 0).length;
        expect(built).toBeGreaterThan(0);
        expect(built).toBeLessThan(groups.size);
    });

    test('a group hidden while its halo builds does not draw it', () => {
        let clock = 0;
        const { atlas } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]), 1, { now: () => (clock += 10) });
        atlas.slots.request(1, 'selected', 'k');
        atlas.buildPending(15);
        expect(atlas.pending).toBe(true);
        atlas.slots.hide(1);
        finish(atlas);
        expect(drawnSlots(atlas, 1)).toEqual([]);
    });

    test('a group released while its halo builds lets the build end cleanly', () => {
        let clock = 0;
        const groups = new Map([[1, { refPiece: 10, fills: square(100) }]]);
        const { atlas, pieceGroup } = setup(groups, 1, { now: () => (clock += 10) });
        atlas.slots.request(1, 'selected', 'k');
        atlas.buildPending(15);
        expect(atlas.pending).toBe(true);
        groups.delete(1);
        pieceGroup.delete(10);
        atlas.slots.release(1);
        expect(() => finish(atlas)).not.toThrow();
        expect(atlas.pending).toBe(false);
    });

    test('a slot that no longer fits anywhere is placed by a repack that keeps the other halos', () => {
        const groups = new Map(Array.from({ length: 17 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        const { atlas, calls, pieceGroup } = setup(groups, 2);
        for (const id of groups.keys()) atlas.slots.request(id, 'selected', 'k');
        finish(atlas);

        // Groups 1, 3, 5 leave; 0 grows into a slot only a repack can make room for.
        for (const id of [1, 3, 5]) {
            groups.delete(id);
            pieceGroup.delete(id);
            atlas.slots.release(id);
        }
        const stay = [...groups.keys()].filter((id) => id !== 0);
        const rectOf = (id: number): AtlasRect => ({ ...atlas.slots['slots'].get(drawnSlots(atlas, id)[0])!.rect });
        const quads = new Map(stay.map((id) => [id, atlas.slots.quad(drawnSlots(atlas, id)[0])!]));
        const where = new Map(stay.map((id) => [id, rectOf(id)]));
        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.slots.request(0, 'selected', 'big');
        expect(atlas.pending).toBe(true);
        const start = calls.length;
        finish(atlas);

        const repack = calls.slice(start);
        let readLayer: unknown;
        const layerMoves = new Set<string>();
        repack.forEach((call, i) => {
            if (call.name === 'framebufferTextureLayer' && call.args[0] === 'READ_FRAMEBUFFER') readLayer = call.args[4];
            if (call.name !== 'copyTexSubImage2D') return;
            const [x, y, w, h] = call.args.slice(4);
            const from = { layer: readLayer, x, y, w, h };
            const id = stay.find((g) => JSON.stringify(where.get(g)) === JSON.stringify(from));
            expect(id, JSON.stringify(from)).toBeDefined();
            const store = repack.slice(i).find((c) => c.name === 'copyTexSubImage3D')!;
            const [toX, toY, layer] = store.args.slice(2, 5) as number[];
            expect(store.args.slice(7)).toEqual([w, h]);
            where.set(id!, { layer, x: toX, y: toY, w: w as number, h: h as number });
            layerMoves.add(`${String(from.layer)}→${layer}`);
        });
        expect(layerMoves).toContain('1→0');
        expect(layerMoves).toContain('1→1');
        expect(atlas.slots.quad(drawnSlots(atlas, 0)[0])!.x1).toBe(3000 + 88);
        for (const id of stay) {
            expect(where.get(id)).toEqual(rectOf(id));
            const quad = atlas.slots.quad(drawnSlots(atlas, id)[0])!;
            expect({ x0: quad.x0, x1: quad.x1 }).toEqual({ x0: quads.get(id)!.x0, x1: quads.get(id)!.x1 });
        }
    });

    test('a build under way when a repack is needed lands where its slot is when it commits', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        let clock = 0;
        const { atlas, calls, pieceGroup } = setup(groups, 1, { now: () => (clock += 10) });
        for (const id of groups.keys()) atlas.slots.request(id, 'selected', 'k');
        finish(atlas);
        for (const id of [1, 3, 5]) {
            groups.delete(id);
            pieceGroup.delete(id);
            atlas.slots.release(id);
        }
        const rectOf = (id: number) => ({ ...atlas.slots['slots'].get(atlas.slots.slotsOf(id).at(-1)!)!.rect });
        const start = rectOf(2);
        const stores: { groupId: number; at: unknown[]; rect: AtlasRect }[] = [];
        const commit = atlas.slots.commit.bind(atlas.slots);
        atlas.slots.commit = (build) => {
            const store = calls.findLast((c) => c.name === 'copyTexSubImage3D')!;
            stores.push({ groupId: build.groupId, at: store.args.slice(2, 5), rect: { ...build.slot.rect } });
            commit(build);
        };

        atlas.slots.request(2, 'selected-dragging', 'k');
        atlas.buildPending(15);
        expect(stores).toEqual([]);
        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.slots.request(0, 'selected', 'big');
        for (let i = 0; i < 1000 && atlas.pending; i++) atlas.buildPending(15);

        expect(atlas.pending).toBe(false);
        expect(rectOf(2)).not.toEqual(start);
        expect(stores.map((s) => s.groupId)).toEqual([2, 0]);
        for (const { at, rect } of stores) expect(at).toEqual([rect.x, rect.y, rect.layer]);
    });

    test('a repack plan runs over several budgeted calls while every halo keeps drawing', () => {
        const groups = new Map(Array.from({ length: 8 }, (_, i) => [i, { refPiece: i, fills: square(1500) }] as const));
        let clock = 0;
        const { atlas, count, pieceGroup } = setup(groups, 1, { now: () => clock++, planWork: 200 });
        for (const id of groups.keys()) atlas.slots.request(id, 'selected', 'k');
        finish(atlas);
        for (const id of [1, 3, 5]) {
            groups.delete(id);
            pieceGroup.delete(id);
            atlas.slots.release(id);
        }
        const drawn = new Map([0, 2, 4, 6, 7].map((id) => [id, drawnSlots(atlas, id)]));
        const quads = new Map([...drawn].map(([id, slots]) => [id, atlas.slots.quad(slots[0])]));
        groups.set(0, { refPiece: 0, fills: { minX: 0, minY: 0, maxX: 3000, maxY: 1500 } });
        atlas.slots.request(0, 'selected', 'big');

        let calls = 0;
        while (count('copyTexSubImage2D') === 0 && calls < 1000) {
            atlas.buildPending(3);
            calls++;
            if (count('copyTexSubImage2D') > 0) break;
            for (const [id, slots] of drawn) {
                expect(drawnSlots(atlas, id)).toEqual(slots);
                expect(atlas.slots.quad(slots[0])).toEqual(quads.get(id));
            }
        }
        expect(calls).toBeGreaterThan(2);
        finish(atlas);
        expect(atlas.slots.quad(drawnSlots(atlas, 0)[0])!.x1).toBe(3000 + 88);
    });

    test('the silhouette pass draws inside the slot\'s gutter', () => {
        const { calls } = setup(new Map([[1, { refPiece: 10, fills: square(100) }]]));
        expect(calls.filter((c) => c.name === 'uniform1f' && c.args[0] === 'u_gutter').map((c) => c.args[1])).toEqual([ATLAS_GUTTER]);
    });

    test('each build pass draws on its own target under its own blend and scissor state', () => {
        const groups = new Map([[1, { refPiece: 10, fills: square(100) }], [2, { refPiece: 20, fills: square(300) }]]);
        const { atlas, calls } = setup(groups);
        for (const id of groups.keys()) atlas.slots.request(id, 'selected-dragging', 'k');
        finish(atlas);

        const targetName = (target: unknown) => Object.entries(atlas['fbo']).find(([, fbo]) => fbo === target)?.[0] ?? null;
        const enabled = new Set<unknown>();
        let program: unknown;
        let target: string | null = null;
        let equation: unknown;
        let func: unknown[] = [];
        let cleared: (string | null)[] = [];
        const draws: { program: unknown; target: string | null; blend: boolean; scissor: boolean; equation: unknown; func: unknown[]; cleared: (string | null)[] }[] = [];
        for (const { name, args } of calls) {
            if (name === 'enable') enabled.add(args[0]);
            if (name === 'disable') enabled.delete(args[0]);
            if (name === 'blendEquation') equation = args[0];
            if (name === 'blendFunc') func = args;
            if (name === 'useProgram') program = args[0];
            if (name === 'bindFramebuffer' && args[0] === 'FRAMEBUFFER') target = targetName(args[1]);
            if (name === 'clear') cleared.push(target);
            if (name === 'drawElements' || name === 'drawArrays') {
                draws.push({ program, target, blend: enabled.has('BLEND'), scissor: enabled.has('SCISSOR_TEST'), equation, func, cleared });
                cleared = [];
            }
        }
        const programs = atlas['programs'];
        const passes = (pass: WebGLProgram) => draws.filter((draw) => draw.program === pass);

        expect(passes(programs.silhouette)).toHaveLength(2);
        for (const draw of passes(programs.silhouette)) {
            expect([draw.target, draw.blend, draw.equation]).toEqual(['silhouette', true, 'MAX']);
            expect(draw.cleared).toHaveLength(2);
            expect(draw.cleared).toEqual(expect.arrayContaining(['halo', 'silhouette']));
        }
        expect(passes(programs.blurX).length).toBeGreaterThan(2);
        for (const draw of passes(programs.blurX)) expect([draw.target, draw.blend]).toEqual(['blur', false]);
        expect(passes(programs.blurY).length).toBeGreaterThan(2);
        for (const draw of passes(programs.blurY)) {
            expect([draw.target, draw.blend, draw.equation, draw.func]).toEqual(['halo', true, 'FUNC_ADD', ['ONE_MINUS_DST_ALPHA', 'ONE']]);
        }
        expect(passes(programs.mip)).toHaveLength(6);
        for (const draw of passes(programs.mip)) expect([draw.target, draw.blend, draw.scissor]).toEqual(['atlas', false, false]);
    });

    test('a halo program that fails to build throws, and the programs built before it are deleted', () => {
        const { gl, calls } = fakeGl((source) => source === BLUR_Y_FS);
        let error: unknown;
        try {
            createHaloPrograms(gl);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(ShaderBuildError);
        expect((error as ShaderBuildError).message).toBe('Halo blurY program: Fragment shader failed to compile');
        expect((error as ShaderBuildError).log).toBe('log');
        const created = calls.filter((c) => c.name === 'createProgram').length;
        expect(created).toBe(3);
        expect(calls.filter((c) => c.name === 'deleteProgram')).toHaveLength(3);
    });
});
