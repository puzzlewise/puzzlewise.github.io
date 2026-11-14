/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameState, PieceGroup } from '../../model/types.js';
import type { RendererAppearance } from '../appearance.js';
import { FakeFrameHost } from '../../test-helpers/fake-frame-host.js';
import { makeGameState, makeRectPiece } from '../../test-helpers/fixtures.js';
import { CONTEXT_RESTORE_TIMEOUT_MS } from './context-loss.js';
import { ShaderBuildError } from './gl-context.js';
import { ATLAS_LAYER_SIZE, ATLAS_LEVELS, AtlasTooLargeError, ShelfPacker } from './halo-atlas-plan.js';
import { KIND_DEBUG_STROKE, KIND_HALO, KIND_MATELESS, MAIN_ATTRIBUTES, MAIN_VERTEX_FLOATS, SILHOUETTE_FS } from './shaders.js';
import { WebGlRenderer, type WebGlRendererOptions } from './webgl-renderer.js';

const FRAMEBUFFER = 0x8d40;
const SCISSOR_TEST = 0x0c11;

function fakeGl(host: FakeFrameHost) {
    const state = { compiles: true, lost: false, fails: (_source: string) => false };
    const sources = new Map<unknown, string>();
    const calls: { name: string; frame: number; args: unknown[]; result?: unknown }[] = [];
    const answers: Record<string, (...args: unknown[]) => unknown> = {
        getShaderParameter: (shader) => state.compiles && !state.fails(sources.get(shader) ?? ''),
        getProgramParameter: () => true,
        getShaderInfoLog: () => 'compile log',
        getProgramInfoLog: () => 'link log',
        isContextLost: () => state.lost,
        getParameter: () => 4096,
        getExtension: () => null,
    };
    const gl = new Proxy({
        drawingBufferWidth: 100,
        drawingBufferHeight: 100,
        FRAMEBUFFER,
        SCISSOR_TEST,
    } as Record<string | symbol, unknown>, {
        get(target, name) {
            if (name in target) return target[name];
            if (typeof name !== 'string' || /^[A-Z0-9_]+$/.test(name)) return 0;
            return (...args: unknown[]) => {
                if (name === 'shaderSource') sources.set(args[0], args[1] as string);
                const result = answers[name]?.(...args) ?? {};
                const recorded = args.map((arg) => (ArrayBuffer.isView(arg) && 'slice' in arg ? (arg as Float32Array).slice() : arg));
                calls.push({ name, frame: host.frame, args: recorded, result });
                return result;
            };
        },
    });
    return { gl, state, calls };
}

function group(id: number, x: number): PieceGroup {
    return { id, pieces: new Map([[id, { x: 0, y: 0 }]]), position: { x, y: 0 }, rotation: 0 };
}

function twoPieceGame(): GameState {
    const pieces = [makeRectPiece({ id: 0, col: 0 }), makeRectPiece({ id: 1, col: 1 })];
    return makeGameState({ pieces, groups: [group(0, 0), group(1, 200)], imageUrl: null });
}

function setup(options: Partial<WebGlRendererOptions> = {}, fails?: (source: string) => boolean) {
    const host = new FakeFrameHost();
    const fake = fakeGl(host);
    if (fails) fake.state.fails = fails;
    vi.stubGlobal('WebGL2RenderingContext', {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => host.requestAnimationFrame(callback));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => host.cancelAnimationFrame(handle));
    vi.stubGlobal('queueMicrotask', (callback: () => void) => host.queueMicrotask(callback));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake.gl as unknown as WebGL2RenderingContext);

    const renderer = new WebGlRenderer({
        runInIdle: (items, work) => {
            items.forEach(work);
            return () => {};
        },
        onRestoreFailed: vi.fn(),
        onContextEvent: vi.fn(),
        ...options,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderer.init(container);
    const canvas = container.querySelector('canvas')!;
    const drawFrames = () => fake.calls.filter((call) => call.name === 'drawElements').map((call) => call.frame);
    return { host, fake, renderer, canvas, drawFrames };
}

describe('WebGlRenderer', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.body.replaceChildren();
    });

    test('init appends the puzzle table element that input and context-menu handling key on', () => {
        const { canvas } = setup();
        expect(canvas.parentElement!.matches('[data-puzzle-table]')).toBe(true);
    });

    test('a state rendered inside a frame is drawn in that frame', () => {
        const { host, renderer, drawFrames } = setup();
        const game = twoPieceGame();
        renderer.renderState(game);
        host.runFrame();
        expect(drawFrames()).toEqual([1]);

        host.requestAnimationFrame(() => {
            renderer.renderState({ ...game, groups: [group(0, 50), group(1, 200)] });
        });
        host.runFrame();

        expect(drawFrames()).toEqual([1, 2]);
        expect(host.pendingFrames()).toBe(0);
    });

    test('a shader failure on restore is reported once, and no give-up follows', () => {
        const onRestoreFailed = vi.fn<(error: ShaderBuildError) => void>();
        const onContextEvent = vi.fn();
        const { fake, canvas } = setup({ onRestoreFailed, onContextEvent });
        const uncaught = vi.fn();
        window.addEventListener('error', uncaught);

        canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
        fake.state.compiles = false;
        canvas.dispatchEvent(new Event('webglcontextrestored'));
        vi.advanceTimersByTime(CONTEXT_RESTORE_TIMEOUT_MS);
        canvas.dispatchEvent(new Event('webglcontextrestored'));
        window.removeEventListener('error', uncaught);

        expect(uncaught).not.toHaveBeenCalled();
        expect(onRestoreFailed).toHaveBeenCalledTimes(1);
        expect(onRestoreFailed.mock.calls[0][0]).toBeInstanceOf(ShaderBuildError);
        expect(onRestoreFailed.mock.calls[0][0].log).toBe('compile log');
        expect(onContextEvent.mock.calls).toEqual([['lost']]);
    });

    describe('halos', () => {
        const runUntilIdle = (host: FakeFrameHost) => {
            for (let i = 0; i < 50 && host.pendingFrames() > 0; i++) host.runFrame();
        };
        type Call = { name: string; frame: number; args: unknown[]; result?: unknown };
        /** Calls made while the main vertex array (the first one created) was bound. */
        const withMainVao = (calls: Call[], name: string): Call[] => {
            const mainVao = calls.find((c) => c.name === 'createVertexArray')!.result;
            let bound: unknown = null;
            const out: Call[] = [];
            for (const call of calls) {
                if (call.name === 'bindVertexArray') bound = call.args[0];
                if (call.name === name && bound === mainVao) out.push(call);
            }
            return out;
        };
        const HALO_VERTICES = 4 * (2 * 2 + 16);
        /** Halo quads with area among those in the last index upload, for a two-piece game. */
        const drawnHalos = (calls: Call[]): number => {
            const indices = withMainVao(calls, 'bufferData').at(-1)!.args[1] as Uint32Array;
            const slots = new Set(Array.from(indices).filter((index) => index < HALO_VERTICES).map((index) => Math.floor(index / 4)));
            return [...slots].filter((slot) => {
                const offset = slot * 4 * MAIN_VERTEX_FLOATS * 4;
                const upload = calls.findLast((c) => c.name === 'bufferSubData' && c.args[1] === offset);
                return !!upload && Array.from(upload.args[2] as Float32Array).some((v) => v !== 0 && v !== KIND_HALO);
            }).length;
        };
        const mergedPair = (): PieceGroup => ({
            id: 0,
            pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 200, y: 0 }]]),
            position: { x: 0, y: 0 },
            rotation: 0,
        });
        const SHADOW: RendererAppearance = {
            outline: 'shadow',
            outlineColor: [0, 0, 0, 1],
            constantWidth: false,
            innerOutline: false,
            selectionGlowColor: [1, 1, 1, 1],
            backgroundColor: [0, 0, 0, 1],
            pieceOpacity: 1,
            debugPieces: false,
            matelessEdges: false,
        };

        test('selecting a group builds its glow in animation frames, then frames stop', () => {
            const { host, fake, renderer } = setup();
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            expect(fake.calls.some((c) => c.name === 'copyTexSubImage3D')).toBe(false);

            renderer.setGroupSelected(1, true);
            expect(host.pendingFrames()).toBe(1);
            runUntilIdle(host);

            expect(fake.calls.filter((c) => c.name === 'copyTexSubImage3D')).toHaveLength(1);
            expect(fake.calls.some((c) => c.name === 'generateMipmap' && c.args[0] !== 0)).toBe(false);
            expect(host.pendingFrames()).toBe(0);
        });

        test('each group\'s halo quad comes first in its group, and only drawn ones have area', () => {
            const { host, fake, renderer } = setup();
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);

            const last = Array.from(withMainVao(fake.calls, 'bufferData').at(-1)!.args[1] as Uint32Array);
            const haloAt = last.flatMap((index, at) => (index < HALO_VERTICES ? [at] : []));
            expect(haloAt).toHaveLength(12);
            expect(haloAt.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
            const second = haloAt[6];
            expect(second).toBeGreaterThan(6);
            expect(haloAt.slice(6)).toEqual([0, 1, 2, 3, 4, 5].map((i) => second + i));

            const quad = (at: number) => {
                const offset = Math.floor(last[at] / 4) * 4 * MAIN_VERTEX_FLOATS * 4;
                const upload = fake.calls.filter((c) => c.name === 'bufferSubData' && c.args[1] === offset).at(-1)!;
                return Array.from(upload.args[2] as Float32Array);
            };
            expect(quad(0).every((v) => v === 0 || v === KIND_HALO)).toBe(true);
            expect(quad(second).some((v) => v !== 0 && v !== KIND_HALO)).toBe(true);
        });

        test('each frame still issues one main draw call', () => {
            const { host, fake, renderer } = setup();
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(0, true);
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);

            const frames = withMainVao(fake.calls, 'drawElements').map((c) => c.frame);
            expect(new Set(frames).size).toBe(frames.length);
            expect(fake.calls.filter((c) => c.name === 'copyTexSubImage3D')).toHaveLength(2);
        });

        test('the main draw sets its own blend, framebuffer and scissor state after a halo build changed them', () => {
            const { host, fake, renderer } = setup();
            const game = manyGroups(40);
            renderer.renderState(game);
            for (const g of game.groups) renderer.setGroupSelected(g.id, true);
            runUntilIdle(host);

            const main = fake.calls.find((c) => c.name === 'createProgram')!.result;
            const draws = withMainVao(fake.calls, 'drawElements');
            expect(draws.length).toBeGreaterThan(0);
            for (const draw of draws) {
                const before = fake.calls.slice(0, fake.calls.indexOf(draw));
                const use = before.findLastIndex((c) => c.name === 'useProgram');
                expect(before[use].args[0]).toBe(main);
                const set = before.slice(use).map((c) => c.name);
                expect(set).toEqual(expect.arrayContaining(['enable', 'blendEquation', 'blendFunc']));
                const target = before.findLast((c) => c.name === 'bindFramebuffer' && c.args[0] === FRAMEBUFFER);
                expect(target?.args[1]).toBeNull();
                const scissor = before.findLast((c) => (c.name === 'enable' || c.name === 'disable') && c.args[0] === SCISSOR_TEST);
                expect(scissor?.name).toBe('disable');
            }
            expect(fake.calls.some((c) => c.name === 'copyTexSubImage3D')).toBe(true);
        });

        const mainSamplerUnits = (calls: Call[]): unknown[] => {
            const main = calls.find((c) => c.name === 'createProgram')!.result;
            return ['u_transforms', 'u_photo', 'u_halo'].map((name) => {
                const location = calls.find((c) => c.name === 'getUniformLocation' && c.args[0] === main && c.args[1] === name)!.result;
                return calls.findLast((c) => c.name === 'uniform1i' && c.args[0] === location)?.args[1];
            });
        };
        const texturesBoundAt = (calls: Call[], at: Call): Map<unknown, unknown> => {
            const bound = new Map<unknown, unknown>();
            let unit: unknown;
            for (const call of calls.slice(0, calls.indexOf(at))) {
                if (call.name === 'activeTexture') unit = call.args[0];
                if (call.name === 'bindTexture') bound.set(unit, call.args[1]);
            }
            return bound;
        };

        test('the main draw samples transforms, photo and halos from distinct units, the halo unit holding the current atlas', () => {
            const { host, fake, renderer } = setup();
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);

            const units = mainSamplerUnits(fake.calls);
            expect(units).not.toContain(undefined);
            expect(new Set(units).size).toBe(3);
            const draw = withMainVao(fake.calls, 'drawElements').at(-1)!;
            const atlas = renderer['res']!.halos!.texture;
            expect(atlas).not.toBe(renderer['res']!.emptyHaloTexture);
            expect(texturesBoundAt(fake.calls, draw).get(units[2])).toBe(atlas);
        });

        test('without a halo atlas, the main draw samples the empty halo texture', () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const { host, fake, renderer } = setup({}, (source) => source === SILHOUETTE_FS);
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);

            expect(renderer['res']!.halos).toBeNull();
            const draw = withMainVao(fake.calls, 'drawElements').at(-1)!;
            expect(texturesBoundAt(fake.calls, draw).get(mainSamplerUnits(fake.calls)[2])).toBe(renderer['res']!.emptyHaloTexture);
        });

        test('under the Shadow preset, a glow color change rebuilds only glowing halos', () => {
            const { host, fake, renderer } = setup();
            renderer.setAppearance(SHADOW);
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);
            const copies = () => fake.calls.filter((c) => c.name === 'copyTexSubImage3D').length;
            expect(copies()).toBe(2);

            renderer.setAppearance({ ...SHADOW, selectionGlowColor: [0, 1, 0, 1] });
            runUntilIdle(host);
            expect(copies()).toBe(3);
        });

        test('a merge keeps drawing the absorbed group\'s halo until the merged one lands, then frees its slot', () => {
            const { host, fake, renderer } = setup();
            renderer.setAppearance(SHADOW);
            const game = twoPieceGame();
            renderer.renderState(game);
            runUntilIdle(host);
            const copies = () => fake.calls.filter((c) => c.name === 'copyTexSubImage3D').length;
            expect(copies()).toBe(2);
            expect(drawnHalos(fake.calls)).toBe(2);

            const merged = mergedPair();
            host.runTask(() => renderer.renderState({ ...game, groups: [merged], groupsById: new Map([[0, merged]]) }));
            expect(copies()).toBe(2);
            expect(drawnHalos(fake.calls)).toBe(2);

            runUntilIdle(host);
            expect(copies()).toBe(3);
            expect(drawnHalos(fake.calls)).toBe(1);
            expect(renderer['res']!.halos!.slots['slots'].size).toBe(1);
        });

        test('a selected group merged into an unselected one keeps its glow drawn in every frame', () => {
            const { host, fake, renderer } = setup();
            const game = twoPieceGame();
            renderer.renderState(game);
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);
            const copies = () => fake.calls.filter((c) => c.name === 'copyTexSubImage3D').length;
            expect(copies()).toBe(1);
            const start = fake.calls.length;

            const merged = mergedPair();
            host.runTask(() => {
                renderer.renderState({ ...game, groups: [merged], groupsById: new Map([[0, merged]]) });
                renderer.setGroupSelected(0, true);
            });
            runUntilIdle(host);

            expect(copies()).toBe(2);
            const draws = withMainVao(fake.calls, 'drawElements').filter((c) => fake.calls.indexOf(c) >= start);
            expect(draws.length).toBeGreaterThan(1);
            for (const draw of draws) expect(drawnHalos(fake.calls.slice(0, fake.calls.indexOf(draw)))).toBe(1);
        });

        test('a glowing group merged into one with no halo stops drawing its glow', () => {
            const { host, fake, renderer } = setup();
            const game = twoPieceGame();
            renderer.renderState(game);
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);
            expect(drawnHalos(fake.calls)).toBe(1);

            const merged = mergedPair();
            host.runTask(() => renderer.renderState({ ...game, groups: [merged], groupsById: new Map([[0, merged]]) }));
            runUntilIdle(host);

            expect(drawnHalos(fake.calls)).toBe(0);
            expect(renderer['res']!.halos!.slots['slots'].size).toBe(1);
        });

        test('under the Shadow preset, strokes finishing after the first frames bring every idle shadow', () => {
            const idle: (() => void)[] = [];
            const { host, fake, renderer } = setup({
                runInIdle: (items, work) => {
                    idle.push(() => items.forEach(work));
                    return () => {};
                },
            });
            renderer.setAppearance(SHADOW);
            for (const compile of idle.splice(0)) compile();
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            const copies = () => fake.calls.filter((c) => c.name === 'copyTexSubImage3D').length;
            expect(copies()).toBe(0);

            for (const strokes of idle.splice(0)) strokes();
            runUntilIdle(host);
            expect(copies()).toBe(2);
            expect(drawnHalos(fake.calls)).toBe(2);
        });

        test('deselecting a group stops drawing its glow', () => {
            const { host, fake, renderer } = setup();
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);
            expect(drawnHalos(fake.calls)).toBe(1);

            renderer.setGroupSelected(1, false);
            runUntilIdle(host);
            expect(drawnHalos(fake.calls)).toBe(0);
        });

        test('under the Shadow preset, a merge that leaves the group\'s bounds unchanged rebuilds its shadow', () => {
            const { host, fake, renderer } = setup();
            renderer.setAppearance(SHADOW);
            const pieces = [0, 1, 2, 3].map((id) => makeRectPiece({ id, col: id % 2, row: Math.floor(id / 2) }));
            const at = (id: number) => ({ x: (id % 2) * 100, y: Math.floor(id / 2) * 100 });
            const lShape = (ids: number[]): PieceGroup => ({
                id: 0,
                pieces: new Map(ids.map((id) => [id, at(id)])),
                position: { x: 0, y: 0 },
                rotation: 0,
            });
            const corner: PieceGroup = { id: 3, pieces: new Map([[3, { x: 0, y: 0 }]]), position: at(3), rotation: 0 };
            const game = makeGameState({ pieces, groups: [lShape([0, 1, 2]), corner], imageUrl: null });
            renderer.renderState(game);
            runUntilIdle(host);
            const copies = () => fake.calls.filter((c) => c.name === 'copyTexSubImage3D').length;
            expect(copies()).toBe(2);

            const filled = lShape([0, 1, 2, 3]);
            host.runTask(() => renderer.renderState({ ...game, groups: [filled], groupsById: new Map([[0, filled]]) }));
            runUntilIdle(host);
            expect(copies()).toBe(3);
        });

        test('a state change that alters no halo schedules nothing', () => {
            const { host, renderer } = setup();
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            renderer.setGroupDragging(0, false);
            renderer.setGroupSelected(1, false);
            expect(host.pendingFrames()).toBe(0);
        });

        test('halo programs compile in idle time, not in the frame that first builds a halo', () => {
            const idle: (() => void)[] = [];
            const { host, fake, renderer } = setup({
                runInIdle: (items, work) => {
                    idle.push(() => items.forEach(work));
                    return () => {};
                },
            });
            const linked = () => fake.calls.filter((c) => c.name === 'linkProgram').length;
            const mainOnly = linked();
            renderer.renderState(twoPieceGame());
            for (const run of idle.splice(0)) run();
            expect(linked()).toBe(mainOnly + 4);
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);
            expect(linked()).toBe(mainOnly + 4);
            expect(fake.calls.filter((c) => c.name === 'copyTexSubImage3D')).toHaveLength(1);
        });

        test('a halo shader that fails to build leaves the table drawing without halos', () => {
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            const { host, fake, renderer } = setup({}, (source) => source === SILHOUETTE_FS);
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);
            renderer.renderState({ ...twoPieceGame(), groups: [group(0, 40), group(1, 200)] });
            runUntilIdle(host);

            expect(error).toHaveBeenCalledTimes(1);
            expect(error.mock.calls[0][1]).toBeInstanceOf(ShaderBuildError);
            expect((error.mock.calls[0][1] as ShaderBuildError).message).toBe('Halo silhouette program: Fragment shader failed to compile');
            expect(error.mock.calls[0][2]).toBe('compile log');
            expect(fake.calls.some((c) => c.name === 'copyTexSubImage3D')).toBe(false);
            expect(withMainVao(fake.calls, 'drawElements').length).toBeGreaterThan(0);
            expect(host.pendingFrames()).toBe(0);
        });

        test('a puzzle too large for the halo atlas plays on without halos', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const { host, fake, renderer } = setup();
            const pieces = [makeRectPiece({ id: 0, width: 9000, height: 9000 })];
            renderer.renderState(makeGameState({ pieces, groups: [group(0, 0)], imageUrl: null }));
            renderer.setGroupSelected(0, true);
            runUntilIdle(host);

            expect(warn).toHaveBeenCalledTimes(1);
            const error = warn.mock.calls[0][1] as AtlasTooLargeError;
            expect(error).toBeInstanceOf(AtlasTooLargeError);
            expect(error.largest.w).toBeGreaterThan(ATLAS_LAYER_SIZE);
            expect(fake.calls.some((c) => c.name === 'copyTexSubImage3D')).toBe(false);
            expect(withMainVao(fake.calls, 'drawElements').length).toBeGreaterThan(0);
            expect(host.pendingFrames()).toBe(0);
        });

        test('a planner failure other than a too-large atlas is not taken for one', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            vi.spyOn(ShelfPacker.prototype, 'alloc').mockImplementation(() => {
                throw new TypeError('packer bug');
            });
            const { host, renderer } = setup();
            renderer.renderState(twoPieceGame());
            expect(() => runUntilIdle(host)).toThrow(TypeError);
            expect(warn).not.toHaveBeenCalled();
        });

        test('a state change re-uploads that group\'s quad and no indices', () => {
            const { host, fake, renderer } = setup();
            renderer.renderState(twoPieceGame());
            renderer.setGroupSelected(1, true);
            runUntilIdle(host);
            const indexUploads = withMainVao(fake.calls, 'bufferData').length;
            const before = fake.calls.length;

            renderer.setGroupDragging(1, true);
            runUntilIdle(host);

            const after = fake.calls.slice(before);
            expect(withMainVao(fake.calls, 'bufferData')).toHaveLength(indexUploads);
            const quads = after.filter((c) => c.name === 'bufferSubData').map((c) => c.args[1]);
            expect(new Set(quads).size).toBe(1);
            expect(after.filter((c) => c.name === 'copyTexSubImage3D')).toHaveLength(1);
        });

        test('while halos build, a frame the app draws in gets no second full draw', () => {
            const { host, fake, renderer } = setup();
            const pieces = Array.from({ length: 40 }, (_, id) => makeRectPiece({ id }));
            const groups = pieces.map((piece) => group(piece.id, piece.id * 300));
            const game = makeGameState({ pieces, groups, imageUrl: null });
            renderer.renderState(game);
            runUntilIdle(host);
            for (const piece of pieces) renderer.setGroupSelected(piece.id, true);

            const start = fake.calls.length;
            let x = 0;
            const appCalls: Call[] = [];
            for (let frame = 0; frame < 30 && (frame < 2 || host.pendingFrames() > 0); frame++) {
                host.requestAnimationFrame(() => {
                    const from = fake.calls.length;
                    x += 5;
                    renderer.renderState({ ...game, groups: [group(0, x), ...groups.slice(1)] });
                    host.queueMicrotask(() => appCalls.push(...fake.calls.slice(from)));
                });
                host.runFrame();
            }
            const calls = new Set(fake.calls.slice(start));
            const mainDraws = withMainVao(fake.calls, 'drawElements');
            const draws = mainDraws.filter((c) => calls.has(c)).map((c) => c.frame);
            expect(new Set(draws).size).toBe(draws.length);
            expect(appCalls.some((c) => mainDraws.includes(c))).toBe(true);
            expect(appCalls.filter((c) => c.name === 'copyTexSubImage3D')).toEqual([]);
            const copies = [...calls].filter((c) => c.name === 'copyTexSubImage3D');
            expect(new Set(copies.map((c) => c.frame)).size).toBeGreaterThan(1);
            expect(copies).toHaveLength(40);
        });

        function manyGroups(count: number): GameState {
            const pieces = Array.from({ length: count }, (_, id) => makeRectPiece({ id }));
            return makeGameState({ pieces, groups: pieces.map((p) => group(p.id, p.id * 300)), imageUrl: null });
        }

        /** The atlas array texture of each atlas created so far, and its layer count. */
        function atlases(calls: Call[]): { texture: unknown; layers: unknown }[] {
            return calls.flatMap((call, i) => {
                if (call.name !== 'texStorage3D' || call.args[1] !== ATLAS_LEVELS) return [];
                const bind = calls.slice(0, i).findLast((c) => c.name === 'bindTexture')!;
                return [{ texture: bind.args[1], layers: call.args[5] }];
            });
        }

        test('a new game mid-build drops the old builds and draws nothing of the old halos', () => {
            const { host, fake, renderer } = setup();
            const first = manyGroups(40);
            renderer.renderState(first);
            for (const g of first.groups) renderer.setGroupSelected(g.id, true);
            host.runFrame();
            host.runFrame();
            const built = fake.calls.filter((c) => c.name === 'copyTexSubImage3D').length;
            expect(built).toBeGreaterThan(0);
            expect(built).toBeLessThan(40);
            const [old] = atlases(fake.calls);

            const start = fake.calls.length;
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            const after = fake.calls.slice(start);
            expect(after.some((c) => c.name === 'deleteTexture' && c.args[0] === old.texture)).toBe(true);
            expect(after.filter((c) => c.name === 'copyTexSubImage3D')).toHaveLength(0);
            const quads = after.filter((c) => c.name === 'bufferSubData').map((c) => Array.from(c.args[2] as Float32Array));
            expect(quads.length).toBeGreaterThan(0);
            for (const quad of quads) expect(quad.every((v) => v === 0 || v === KIND_HALO)).toBe(true);
            expect(host.pendingFrames()).toBe(0);
        });

        test('a context lost mid-build rebuilds the atlas with the same layers and every wanted halo', () => {
            const { host, fake, renderer, canvas } = setup();
            // Tall slivers: one 1152-texel shelf per layer, which 27 slots and the solved-puzzle headroom overflow.
            const pieces = Array.from({ length: 27 }, (_, id) => makeRectPiece({ id, width: 10, height: 3000 }));
            const game = makeGameState({ pieces, groups: pieces.map((p) => group(p.id, p.id * 10)), imageUrl: null });
            renderer.renderState(game);
            runUntilIdle(host);
            expect(atlases(fake.calls).map((a) => a.layers)).toEqual([2]);

            const triples: PieceGroup[] = Array.from({ length: 9 }, (_, g) => ({
                id: 3 * g,
                pieces: new Map([0, 1, 2].map((i) => [3 * g + i, { x: 10 * i, y: 0 }])),
                position: { x: 30 * g, y: 0 },
                rotation: 0,
            }));
            renderer.renderState(makeGameState({ pieces, groups: triples, imageUrl: null }));
            for (const g of triples) renderer.setGroupSelected(g.id, true);
            host.runFrame();
            expect(fake.calls.filter((c) => c.name === 'copyTexSubImage3D').length).toBeLessThan(9);

            fake.state.lost = true;
            canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
            fake.state.lost = false;
            const start = fake.calls.length;
            canvas.dispatchEvent(new Event('webglcontextrestored'));
            runUntilIdle(host);

            const after = fake.calls.slice(start);
            expect(atlases(after).map((a) => a.layers)).toEqual([2]);
            expect(after.filter((c) => c.name === 'copyTexSubImage3D')).toHaveLength(9);
            expect(host.pendingFrames()).toBe(0);
        });

        test('without halos, a selection change stops requesting frames', () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const { host, renderer } = setup({}, (source) => source === SILHOUETTE_FS);
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            renderer.setGroupSelected(1, true);
            for (let i = 0; i < 3; i++) host.runFrame();
            expect(host.pendingFrames()).toBe(0);
        });

        test('before the halo programs compile, a selection change stops requesting frames', () => {
            const idle: (() => void)[] = [];
            const { host, fake, renderer } = setup({
                runInIdle: (items, work) => {
                    idle.push(() => items.forEach(work));
                    return () => {};
                },
            });
            const game = twoPieceGame();
            renderer.renderState(game);
            const strokes = idle.splice(1);
            for (const run of strokes) run();
            runUntilIdle(host);
            renderer.setGroupSelected(1, true);
            for (let i = 0; i < 3; i++) host.runFrame();
            expect(host.pendingFrames()).toBe(0);

            for (const run of idle.splice(0)) run();
            runUntilIdle(host);
            expect(fake.calls.filter((c) => c.name === 'copyTexSubImage3D')).toHaveLength(1);
            expect(host.pendingFrames()).toBe(0);
        });
    });

    describe('debug views', () => {
        type Call = { name: string; frame: number; args: unknown[]; result?: unknown };
        const DEBUG_APPEARANCE: RendererAppearance = {
            outline: 'outline',
            outlineColor: [0, 0, 0, 1],
            constantWidth: false,
            innerOutline: false,
            selectionGlowColor: [1, 1, 1, 1],
            backgroundColor: [0, 0, 0, 1],
            pieceOpacity: 1,
            debugPieces: false,
            matelessEdges: false,
        };
        const runUntilIdle = (host: FakeFrameHost) => {
            for (let i = 0; i < 50 && host.pendingFrames() > 0; i++) host.runFrame();
        };
        const lastUpload = <T extends Float32Array | Uint32Array>(calls: Call[], type: new () => T): T =>
            calls.findLast((c) => c.name === 'bufferData' && c.args[1] instanceof type)!.args[1] as T;
        const drawnKinds = (calls: Call[]): Set<number> => {
            const vertices = lastUpload(calls, Float32Array);
            const indices = lastUpload(calls, Uint32Array);
            return new Set(Array.from(indices, (i) => vertices[i * MAIN_VERTEX_FLOATS + MAIN_ATTRIBUTES.kind.offset]));
        };
        const uploadedKinds = (calls: Call[]): Set<number> => {
            const vertices = lastUpload(calls, Float32Array);
            const kinds = new Set<number>();
            for (let i = MAIN_ATTRIBUTES.kind.offset; i < vertices.length; i += MAIN_VERTEX_FLOATS) kinds.add(vertices[i]);
            return kinds;
        };
        const debugUniform = (calls: Call[]): unknown => {
            const location = calls.findLast((c) => c.name === 'getUniformLocation' && c.args[1] === 'u_debugPieces')!.result;
            return calls.findLast((c) => c.name === 'uniform1i' && c.args[0] === location)?.args[1];
        };

        test('the mateless toggle adds and removes mateless strokes within the one draw call', () => {
            const { host, fake, renderer } = setup();
            renderer.setAppearance(DEBUG_APPEARANCE);
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            expect(drawnKinds(fake.calls).has(KIND_MATELESS)).toBe(false);

            renderer.setAppearance({ ...DEBUG_APPEARANCE, matelessEdges: true });
            runUntilIdle(host);
            expect(drawnKinds(fake.calls).has(KIND_MATELESS)).toBe(true);
            expect(drawnKinds(fake.calls).has(KIND_DEBUG_STROKE)).toBe(false);

            renderer.setAppearance(DEBUG_APPEARANCE);
            runUntilIdle(host);
            expect(drawnKinds(fake.calls).has(KIND_MATELESS)).toBe(false);
            const frames = fake.calls.filter((c) => c.name === 'drawElements').map((c) => c.frame);
            expect(new Set(frames).size).toBe(frames.length);
        });

        test('debug pieces draws debug strokes and white fills, and shows the labels until switched off', () => {
            const { host, fake, renderer, canvas } = setup();
            renderer.setAppearance(DEBUG_APPEARANCE);
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            expect(debugUniform(fake.calls)).toBe(0);

            renderer.setAppearance({ ...DEBUG_APPEARANCE, debugPieces: true });
            runUntilIdle(host);
            expect(drawnKinds(fake.calls).has(KIND_DEBUG_STROKE)).toBe(true);
            expect(debugUniform(fake.calls)).toBe(1);
            const table = canvas.parentElement!;
            expect([...table.querySelectorAll('[data-piece-label]')].map((l) => l.textContent).sort()).toEqual(['0', '1']);

            renderer.setAppearance(DEBUG_APPEARANCE);
            runUntilIdle(host);
            expect(drawnKinds(fake.calls).has(KIND_DEBUG_STROKE)).toBe(false);
            expect(debugUniform(fake.calls)).toBe(0);
            expect((table.querySelector('[data-debug-overlay]') as HTMLElement).style.display).toBe('none');
        });

        test('with both toggles off, no debug vertices, indices or overlay exist', () => {
            const { host, fake, renderer, canvas } = setup();
            renderer.setAppearance({ ...DEBUG_APPEARANCE, pieceOpacity: 0.5 });
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);

            const kinds = uploadedKinds(fake.calls);
            expect(kinds.has(KIND_MATELESS) || kinds.has(KIND_DEBUG_STROKE)).toBe(false);
            expect(canvas.parentElement!.querySelector('[data-debug-overlay]')).toBeNull();
        });

        test('debug strokes switched on before the strokes are built appear once they are', () => {
            const idle: (() => void)[] = [];
            const { host, fake, renderer } = setup({
                runInIdle: (items, work) => {
                    idle.push(() => items.forEach(work));
                    return () => {};
                },
            });
            renderer.setAppearance({ ...DEBUG_APPEARANCE, debugPieces: true, matelessEdges: true });
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);
            expect(drawnKinds(fake.calls).has(KIND_DEBUG_STROKE)).toBe(false);

            for (const run of idle.splice(0)) run();
            runUntilIdle(host);
            const kinds = drawnKinds(fake.calls);
            expect(kinds.has(KIND_DEBUG_STROKE) && kinds.has(KIND_MATELESS)).toBe(true);
        });

        test('a restored context re-uploads the debug strokes', () => {
            const { host, fake, renderer, canvas } = setup();
            renderer.setAppearance({ ...DEBUG_APPEARANCE, matelessEdges: true });
            renderer.renderState(twoPieceGame());
            runUntilIdle(host);

            fake.state.lost = true;
            canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
            fake.state.lost = false;
            const start = fake.calls.length;
            canvas.dispatchEvent(new Event('webglcontextrestored'));
            runUntilIdle(host);

            expect(drawnKinds(fake.calls.slice(start)).has(KIND_MATELESS)).toBe(true);
        });
    });
});
