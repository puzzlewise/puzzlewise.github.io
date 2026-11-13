import { describe, expect, test } from 'vitest';
import type { RendererAppearance } from '../appearance.js';
import {
    ATLAS_GUTTER,
    ATLAS_LAYER_BYTES,
    ATLAS_LAYER_SIZE,
    type AtlasRect,
    AtlasTooLargeError,
    haloLayout,
    haloRegion,
    OUTLINE_PRESETS,
    planAtlas,
    planRepack,
    REPACK_ITEM_MAX_WORK,
    RepackPlanner,
    type RepackStep,
    scratchBytes,
    ShelfPacker,
    silhouetteBounds,
    silhouetteStroke,
    slotSize,
} from './halo-atlas-plan.js';
import { gaussianKernel, HALO_STATES, haloMargin, haloSteps, haloTexelsPerUnit } from './halo-recipe.js';

const GLOW = [1, 0, 0, 1] as const;

function overlaps(a: AtlasRect, b: AtlasRect): boolean {
    return a.layer === b.layer && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function expectDisjointInside(rects: AtlasRect[], layers: number): void {
    for (const r of rects) {
        expect(r.layer).toBeLessThan(layers);
        expect(r.x + r.w).toBeLessThanOrEqual(ATLAS_LAYER_SIZE);
        expect(r.y + r.h).toBeLessThanOrEqual(ATLAS_LAYER_SIZE);
    }
    for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    }
}

describe('silhouetteStroke', () => {
    test('only the outer outline stroke widens the silhouette', () => {
        const a = { outline: 'outline', innerOutline: false } as RendererAppearance;
        expect(silhouetteStroke(a)).toBe(true);
        expect(silhouetteStroke({ ...a, innerOutline: true })).toBe(false);
        expect(silhouetteStroke({ ...a, outline: 'shadow' })).toBe(false);
        expect(silhouetteStroke({ ...a, outline: 'none' })).toBe(false);
    });
});

describe('silhouetteBounds', () => {
    test('unions piece bounds at their offsets and widens by the stroke', () => {
        const pieces = [
            { bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, x: 0, y: 0 },
            { bounds: { minX: -2, minY: 0, maxX: 10, maxY: 12 }, x: 10, y: 5 },
        ];
        expect(silhouetteBounds(pieces, false)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 17 });
        expect(silhouetteBounds(pieces, true)).toEqual({ minX: -1.5, minY: -1.5, maxX: 21.5, maxY: 18.5 });
    });
});

describe('haloLayout', () => {
    test('covers the bounds plus the margin at the chain resolution', () => {
        const steps = haloSteps('selected', 'outline', GLOW);
        const layout = haloLayout({ minX: 10, minY: 20, maxX: 110, maxY: 70 }, steps);
        expect(layout.texelsPerUnit).toBe(0.25);
        expect(layout.originX).toBe(10 - 132);
        expect(layout.originY).toBe(20 - 132);
        expect(layout.width).toBe(Math.ceil((100 + 264) * 0.25));
        expect(layout.height).toBe(Math.ceil((50 + 264) * 0.25));
    });
});

describe('slotSize', () => {
    test('is the largest state over every preset, plus gutters, aligned to 8', () => {
        const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 40 };
        const size = slotSize(bounds);
        // Shadow selected-dragging: 0.25 texel/unit, margin 3·(4+12+6+14+24).
        expect(size.w).toBe(Math.ceil((Math.ceil((100 + 360) * 0.25) + 2 * ATLAS_GUTTER) / 8) * 8);
        expect(size.h).toBe(Math.ceil((Math.ceil((40 + 360) * 0.25) + 2 * ATLAS_GUTTER) / 8) * 8);
    });

    test('a large group sizes for the Shadow idle halo at 0.375 texel per unit', () => {
        const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
        const idle = Math.ceil((1000 + 24) * 0.375);
        expect(slotSize(bounds).w).toBe(Math.ceil((idle + 2 * ATLAS_GUTTER) / 8) * 8);
    });

    test('every state layout fits inside the slot gutters', () => {
        const bounds = { minX: -30, minY: 5, maxX: 140, maxY: 260 };
        const size = slotSize(bounds);
        for (const outline of OUTLINE_PRESETS) {
            for (const state of HALO_STATES) {
                const steps = haloSteps(state, outline, GLOW);
                if (steps.length === 0) continue;
                const stroke = silhouetteStroke({ outline, innerOutline: false });
                const silhouette = silhouetteBounds([{ bounds, x: 0, y: 0 }], stroke);
                const layout = haloLayout(silhouette, steps);
                expect(layout.width + 2 * ATLAS_GUTTER).toBeLessThanOrEqual(size.w);
                expect(layout.height + 2 * ATLAS_GUTTER).toBeLessThanOrEqual(size.h);
            }
        }
    });
});

describe('haloRegion', () => {
    test('is the image plus gutters, aligned to 8', () => {
        expect(haloRegion({ width: 91, height: 33 })).toEqual({ w: 112, h: 56 });
        expect(haloRegion({ width: 96, height: 1 })).toEqual({ w: 112, h: 24 });
    });

    test('blur reach past the image plus a texel of edge antialiasing stays inside the gutter', () => {
        for (const outline of OUTLINE_PRESETS) {
            for (const state of HALO_STATES) {
                const steps = haloSteps(state, outline, GLOW);
                if (steps.length === 0) continue;
                const texelsPerUnit = haloTexelsPerUnit(steps);
                const radii = steps.map((step) => (gaussianKernel(step.sigma, texelsPerUnit).length - 1) / 2);
                const reach = radii.reduce((a, b) => a + b, 0) - haloMargin(steps) * texelsPerUnit + 1;
                expect(reach, `${outline} ${state}`).toBeLessThanOrEqual(ATLAS_GUTTER);
            }
        }
    });
});

describe('ShelfPacker', () => {
    test('allocates disjoint rects and spills into the next layer', () => {
        const packer = new ShelfPacker(2);
        const rects: AtlasRect[] = [];
        for (let i = 0; i < 200; i++) {
            const rect = packer.alloc(200, 160);
            expect(rect).not.toBeNull();
            rects.push(rect!);
        }
        expect(new Set(rects.map((r) => r.layer))).toEqual(new Set([0, 1]));
        expectDisjointInside(rects, 2);
    });

    test('returns null when nothing fits', () => {
        const packer = new ShelfPacker(1);
        expect(packer.alloc(2048, 2048)).not.toBeNull();
        expect(packer.alloc(8, 8)).toBeNull();
        expect(new ShelfPacker(1).alloc(2056, 8)).toBeNull();
    });

    test('freed space is reused, and empty shelves merge for taller rects', () => {
        const packer = new ShelfPacker(1);
        const rows: AtlasRect[] = [];
        for (let i = 0; i < 8; i++) rows.push(packer.alloc(2048, 256)!);
        expect(packer.alloc(8, 8)).toBeNull();
        packer.free(rows[3]);
        packer.free(rows[4]);
        const tall = packer.alloc(1000, 512);
        expect(tall).toMatchObject({ layer: 0, y: rows[3].y });
        packer.free(tall!);
        packer.free(rows[7]);
        expect(packer.alloc(2048, 256)).not.toBeNull();
    });

    test('rects and positions stay aligned to 8 texels', () => {
        const packer = new ShelfPacker(1);
        for (const [w, h] of [[13, 7], [100, 33], [9, 250]]) {
            const rect = packer.alloc(w, h)!;
            for (const v of [rect.x, rect.y, rect.w, rect.h]) expect(v % 8).toBe(0);
        }
    });
});

describe('planAtlas', () => {
    test('picks the fewest layers that hold every slot, and sizes the scratch for the whole puzzle', () => {
        const groups = Array.from({ length: 120 }, (_, id) => ({ id, w: 200, h: 200 }));
        const plan = planAtlas(groups, { w: 800, h: 600 });
        expect(plan.layers).toBe(2);
        expectDisjointInside([...plan.slots.values()], 2);
        expect(plan.slots.size).toBe(120);
        expect(plan.scratch).toEqual({ w: 800, h: 600 });
        expect(plan.bytes).toBe(2 * ATLAS_LAYER_BYTES + scratchBytes({ w: 800, h: 600 }));
    });

    test('a layer with mips is 2048² RGBA8 × 4/3', () => {
        expect(ATLAS_LAYER_BYTES).toBe((2048 * 2048 * 4 * 4) / 3);
    });

    test('keeps room for a completed-puzzle slot', () => {
        const groups = Array.from({ length: 100 }, (_, id) => ({ id, w: 200, h: 200 }));
        expect(planAtlas(groups, { w: 8, h: 8 }).layers).toBe(1);
        const plan = planAtlas(groups, { w: 1024, h: 1024 });
        expect(plan.layers).toBe(2);
        expect(plan.slots.size).toBe(100);
        expect(plan.packer.alloc(1024, 1024)).not.toBeNull();
    });

    test('holds at most 64 MiB of layers', () => {
        const layer = { w: ATLAS_LAYER_SIZE, h: ATLAS_LAYER_SIZE };
        const plan = planAtlas([{ id: 0, ...layer }, { id: 1, ...layer }], layer);
        expect(plan.layers).toBe(3);
        expect(plan.layers * ATLAS_LAYER_BYTES).toBeLessThanOrEqual(64 * 2 ** 20);
        expect(() => planAtlas([0, 1, 2].map((id) => ({ id, ...layer })), { w: 8, h: 8 })).toThrow(AtlasTooLargeError);
    });

    test('a plan that does not fit names its largest slot', () => {
        const groups = [{ id: 0, w: 64, h: 64 }, { id: 1, w: 2056, h: 16 }, { id: 2, w: 512, h: 512 }];
        let error: unknown;
        try {
            planAtlas(groups, { w: 128, h: 128 });
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(AtlasTooLargeError);
        expect((error as AtlasTooLargeError).largest).toEqual({ w: 2056, h: 16 });
    });

    test('honors a minimum layer count', () => {
        const plan = planAtlas([{ id: 0, w: 64, h: 64 }], { w: 64, h: 64 }, 3);
        expect(plan.layers).toBe(3);
    });
});

/** Replays the steps, checking no move lands on another slot's halo; returns the final positions. */
function replay(live: ReadonlyMap<number, AtlasRect>, steps: RepackStep[]): Map<number, AtlasRect> {
    const occupied = new Map(live);
    for (const step of steps) {
        if (step.kind === 'move') {
            for (const [id, rect] of occupied) {
                if (id !== step.id) expect(overlaps(rect, step.to)).toBe(false);
            }
            occupied.set(step.id, step.to);
        } else {
            occupied.delete(step.id);
        }
    }
    return occupied;
}

describe('planRepack', () => {
    test('moves only into vacated space, ends on the targets, and leaves the new slots free', () => {
        const packer = new ShelfPacker(1);
        const live = new Map<number, AtlasRect>();
        const rows: AtlasRect[] = [];
        for (let i = 0; i < 16; i++) rows.push(packer.alloc(1024, 256)!);
        rows.forEach((rect, id) => {
            if (id % 2 === 0) live.set(id, rect);
            else packer.free(rect);
        });
        expect(packer.alloc(2048, 512)).toBeNull();

        const plan = planRepack(live, [{ id: 100, w: 2048, h: 512 }], 1)!;
        expectDisjointInside([...plan.targets.values()], 1);
        expect(plan.targets.size).toBe(9);
        const final = replay(live, plan.steps);
        for (const [id, rect] of final) expect(rect).toEqual(plan.targets.get(id));
        for (const [, rect] of final) expect(overlaps(rect, plan.targets.get(100)!)).toBe(false);
        expect(plan.packer.alloc(8, 8)).not.toBeNull();
    });

    test('breaks a cycle through free space instead of dropping a halo', () => {
        const live = new Map<number, AtlasRect>([
            [0, { layer: 0, x: 0, y: 512, w: 2048, h: 512 }],
            [1, { layer: 0, x: 0, y: 0, w: 2048, h: 512 }],
        ]);
        const plan = planRepack(live, [], 1)!;
        expect(plan.targets.get(0)).toMatchObject({ y: 0 });
        expect(plan.steps.every((step) => step.kind === 'move')).toBe(true);
        const final = replay(live, plan.steps);
        for (const [id, rect] of final) expect(rect).toEqual(plan.targets.get(id));
    });

    test('evicts only when no free space can break a cycle', () => {
        const live = new Map<number, AtlasRect>([
            [0, { layer: 0, x: 0, y: 1024, w: 2048, h: 1024 }],
            [1, { layer: 0, x: 0, y: 0, w: 2048, h: 1024 }],
        ]);
        const plan = planRepack(live, [], 1)!;
        expect(plan.steps.filter((step) => step.kind === 'evict')).toHaveLength(1);
        const final = replay(live, plan.steps);
        for (const [id, rect] of final) expect(rect).toEqual(plan.targets.get(id));
    });

    test('plans in bounded steps that resume to the same plan as a single run', () => {
        const packer = new ShelfPacker(2);
        const live = new Map<number, AtlasRect>();
        for (let id = 0; id < 300; id++) {
            const rect = packer.alloc(136 + (id % 5) * 8, 120 + (id % 7) * 16)!;
            if (id % 3 === 0) packer.free(rect);
            else live.set(id, rect);
        }
        const added = [{ id: 1000, w: 512, h: 512 }, { id: 1001, w: 640, h: 256 }];

        const planner = new RepackPlanner(live, added, 2);
        let result: ReturnType<RepackPlanner['step']>;
        let calls = 0;
        while ((result = planner.step(2000)) === undefined) {
            expect(planner.lastWork).toBeLessThan(2000 + REPACK_ITEM_MAX_WORK);
            calls++;
        }
        expect(calls).toBeGreaterThan(10);
        expect(result).toEqual(planRepack(live, added, 2));
        expect(result).not.toBeNull();
        const final = replay(live, result!.steps);
        for (const [id, rect] of final) expect(rect).toEqual(result!.targets.get(id));
    });

    test('returns null when the slots cannot fit at all', () => {
        const live = new Map<number, AtlasRect>([[0, { layer: 0, x: 0, y: 0, w: 2048, h: 2048 }]]);
        expect(planRepack(live, [{ id: 1, w: 8, h: 8 }], 1)).toBeNull();
    });
});
