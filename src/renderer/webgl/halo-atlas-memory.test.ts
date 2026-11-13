import { beforeAll, describe, expect, test } from 'vitest';
import { BUNDLED_IMAGE_SIZE, BUNDLED_PORTRAIT_IMAGE_SIZE } from '../../app/bundled-image.js';
import type { CutStyle } from '../../game/cut-styles.js';
import { createNewGame } from '../../game/init.js';
import type { GameState } from '../../model/types.js';
import { registerTabGenerator } from '../../puzzle/topology/generator-registry.js';
import { tracedTabGenerator } from '../../puzzle/topology/traced-tab-generator.js';
import type { RendererAppearance } from '../appearance.js';
import {
    ATLAS_LAYER_SIZE,
    type AtlasRect,
    type Bounds,
    OUTLINE_PRESETS,
    planAtlas,
    RepackPlanner,
    type ShelfPacker,
    silhouetteBounds,
    slotSize,
} from './halo-atlas-plan.js';
import { buildPieceFill } from './piece-mesh.js';

const BUDGET_BYTES = 64 * 1024 * 1024;
const PLAN_STEP_WORK = 16_000;

const CASES: { name: string; cutStyle: CutStyle; portrait: boolean }[] = [
    { name: 'portrait Fractal', cutStyle: 'fractal', portrait: true },
    { name: 'portrait Wavy', cutStyle: 'wavy', portrait: true },
    { name: 'portrait Triangles', cutStyle: 'triangles', portrait: true },
    { name: 'landscape Classic', cutStyle: 'classic', portrait: false },
];

function game(cutStyle: CutStyle, portrait: boolean): GameState {
    const image = portrait ? BUNDLED_PORTRAIT_IMAGE_SIZE : BUNDLED_IMAGE_SIZE;
    const viewport = portrait ? { width: 820, height: 1180 } : { width: 1180, height: 820 };
    const grid = portrait ? { cols: 12, rows: 16 } : { cols: 16, rows: 12 };
    return createNewGame('blank', image, viewport, grid, { cutStyle, seed: 20261113 });
}

type Offset = { x: number; y: number };

function sizer(state: GameState, presets: readonly RendererAppearance['outline'][]) {
    const bounds = new Map(state.pieces.map((piece) => [piece.id, buildPieceFill(piece, 0.1).bounds]));
    return (pieces: Iterable<[number, Offset]>) => {
        const fills: Bounds = silhouetteBounds(
            Array.from(pieces, ([id, offset]) => ({ bounds: bounds.get(id)!, ...offset })),
            false,
        );
        return slotSize(fills, presets);
    };
}

function solvedOffsets(state: GameState, ids: Iterable<number>): [number, Offset][] {
    return Array.from(ids, (id) => {
        const piece = state.pieces.find((p) => p.id === id)!;
        return [id, { x: -piece.imageOffset.x, y: -piece.imageOffset.y }];
    });
}

function plan(state: GameState, presets: readonly RendererAppearance['outline'][]) {
    const size = sizer(state, presets);
    const groups = state.groups.map((group) => ({ id: group.id, ...size(group.pieces) }));
    const scratch = size(solvedOffsets(state, state.pieces.map((p) => p.id)));
    return planAtlas(groups, scratch);
}

/**
 * Merges mated groups in a seeded random order until one group is left. Each
 * merge allocates the merged slot while the absorbed slots still hold their
 * halos, then frees them.
 */
function simulateMerges(state: GameState, seed: number) {
    const size = sizer(state, OUTLINE_PRESETS);
    const solved = size(solvedOffsets(state, state.pieces.map((p) => p.id)));
    const initial = planAtlas(state.groups.map((g) => ({ id: g.id, ...size(g.pieces) })), solved);
    let packer: ShelfPacker = initial.packer;
    const live = new Map<number, AtlasRect>(initial.slots);
    const members = new Map(state.groups.map((g) => [g.id, [...g.pieces.keys()]]));
    const groupOf = new Map<number, number>();
    for (const [id, pieces] of members) for (const p of pieces) groupOf.set(p, id);
    const mates = state.pieces.flatMap((piece) =>
        piece.edges.filter((e) => e.matePieceId > piece.id).map((e) => [piece.id, e.matePieceId] as const));
    let s = seed;
    const random = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = mates.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [mates[i], mates[j]] = [mates[j], mates[i]];
    }
    let failures = 0;
    let repacks = 0;
    let moves = 0;
    let evictions = 0;
    let planMs = 0;
    let stepMs = 0;
    let nextId = 100_000;
    for (const [a, b] of mates) {
        const ga = groupOf.get(a)!;
        const gb = groupOf.get(b)!;
        if (ga === gb) continue;
        const pieces = [...members.get(ga)!, ...members.get(gb)!];
        const id = nextId++;
        const want = size(solvedOffsets(state, pieces));
        let rect = packer.alloc(want.w, want.h);
        if (!rect) {
            const planner = new RepackPlanner(live, [{ id, ...want }], packer.layers);
            let repack: ReturnType<RepackPlanner['step']>;
            const t0 = performance.now();
            for (;;) {
                const t = performance.now();
                repack = planner.step(PLAN_STEP_WORK);
                stepMs = Math.max(stepMs, performance.now() - t);
                if (repack !== undefined) break;
            }
            planMs = Math.max(planMs, performance.now() - t0);
            if (repack) {
                repacks++;
                for (const step of repack.steps) {
                    if (step.kind === 'move') moves++;
                    else evictions++;
                }
                packer = repack.packer;
                for (const [slot, target] of repack.targets) live.set(slot, target);
                rect = live.get(id)!;
            } else {
                failures++;
            }
        }
        for (const old of [ga, gb]) {
            const oldRect = live.get(old);
            if (oldRect) packer.free(oldRect);
            live.delete(old);
            members.delete(old);
        }
        if (rect) live.set(id, rect);
        members.set(id, pieces);
        for (const p of pieces) groupOf.set(p, id);
    }
    return { failures, repacks, moves, evictions, planMs, stepMs };
}

describe('halo atlas memory on 192-piece games', { timeout: 120_000 }, () => {
    beforeAll(() => {
        registerTabGenerator(tracedTabGenerator);
    });

    for (const { name, cutStyle, portrait } of CASES) {
        test(`${name}: at most 2 layers and 64 MiB under every preset`, () => {
            const state = game(cutStyle, portrait);
            expect(state.pieces.length).toBeGreaterThanOrEqual(180);
            const rows = [...OUTLINE_PRESETS.map((preset) => [preset, plan(state, [preset])] as const), ['all', plan(state, OUTLINE_PRESETS)] as const];
            for (const [preset, result] of rows) {
                const used = [...result.slots.values()].reduce((sum, r) => sum + r.w * r.h, 0);
                console.info(
                    `${name} ${preset}: ${result.layers} layers, ${(result.bytes / 2 ** 20).toFixed(1)} MiB`
                    + ` (scratch ${result.scratch.w}×${result.scratch.h},`
                    + ` slots fill ${(used / (result.layers * ATLAS_LAYER_SIZE ** 2) * 100).toFixed(0)}%)`,
                );
                expect(result.layers).toBeLessThanOrEqual(2);
                expect(result.bytes).toBeLessThanOrEqual(BUDGET_BYTES);
            }
        });

        test(`${name}: merging piece by piece to completion always finds a slot without dropping a halo`, () => {
            const state = game(cutStyle, portrait);
            for (const seed of [1, 2, 3]) {
                const { failures, repacks, moves, evictions, planMs, stepMs } = simulateMerges(state, seed);
                console.info(
                    `${name} merge order ${seed}: ${repacks} repacks (${moves} moves, ${evictions} evictions),`
                    + ` ${failures} failures; slowest plan ${planMs.toFixed(2)} ms, slowest step ${stepMs.toFixed(2)} ms`,
                );
                expect(failures).toBe(0);
                expect(evictions).toBe(0);
            }
        });
    }
});
