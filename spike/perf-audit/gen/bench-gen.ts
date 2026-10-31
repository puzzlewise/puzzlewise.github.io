import { preloadTracedTabGenerator } from '/Users/bot/src/puzzle/src/puzzle/topology/traced-tab-loader.ts';
import { runGeneration, type GenerationRequest } from '/Users/bot/src/puzzle/src/game/generation-core.ts';
import { PUZZLE_SIZE_OPTIONS } from '/Users/bot/src/puzzle/src/game/puzzle-sizes.ts';

const only = process.env.ONLY;          // e.g. "triangles"
const onlySize = process.env.SIZE;      // e.g. "192"
const reps = Number(process.env.REPS ?? 3);
const seeds = (process.env.SEEDS ?? '12345,987654321,42,2024,777').split(',').map(Number);
const aspects: Array<[string, { width: number; height: number }]> = [
    ['3:2', { width: 1920, height: 1280 }],
    ['2:3', { width: 1280, height: 1920 }],
    ['pano3:1', { width: 3000, height: 1000 }],
    ['4:3', { width: 1600, height: 1200 }],
];
const onlyAspect = process.env.ASPECT;

type Variant = { name: string; req: Partial<GenerationRequest> };
const variants: Variant[] = [
    { name: 'classic-legacy', req: { cutStyle: 'classic' } },
    { name: 'classic-traced', req: { cutStyle: 'classic', classicConfig: { traceSetVersion: 2 } } },
    { name: 'wavy-traced', req: { cutStyle: 'wavy', wavyConfig: { borderless: false, traceSetVersion: 2 } } },
    { name: 'wavy-traced-borderless', req: { cutStyle: 'wavy', wavyConfig: { borderless: true, traceSetVersion: 2 } } },
    { name: 'wavy-legacy', req: { cutStyle: 'wavy', wavyConfig: { borderless: false } } },
    { name: 'triangles', req: { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 2 } } },
    { name: 'fractal', req: { cutStyle: 'fractal', fractalConfig: { borderless: false } } },
    { name: 'fractal-borderless', req: { cutStyle: 'fractal', fractalConfig: { borderless: true } } },
    { name: 'composable-sine-classic', req: { cutStyle: 'composable', composableConfig: { baseCutGenerator: 'sine', baseCutConfig: { ha: 0.3, hf: 3, va: 0.3, vf: 3 }, tabGenerator: 'classic', tabConfig: {}, borderless: false } as any } },
];

function orient(cols: number, rows: number, size: { width: number; height: number }) {
    return size.height > size.width ? { cols: rows, rows: cols } : { cols, rows };
}

await preloadTracedTabGenerator();
const rows: string[] = [];
console.log(['variant', 'size', 'aspect', 'pieces', 'median_ms', 'max_ms', 'clone_ms', 'json_kb'].join('\t'));
for (const v of variants) {
    if (only && !v.name.startsWith(only)) continue;
    for (const s of PUZZLE_SIZE_OPTIONS) {
        if (onlySize && s.id !== onlySize) continue;
        for (const [an, size] of aspects) {
            if (onlyAspect && an !== onlyAspect) continue;
            const times: number[] = [];
            let pieces = 0, cloneMs = 0, jsonKb = 0;
            for (const seed of seeds) {
                for (let r = 0; r < reps; r++) {
                    const req = { tabDebug: false, gridSize: orient(s.cols, s.rows, size), imageSize: size, seed, ...v.req } as GenerationRequest;
                    const t0 = performance.now();
                    const res = runGeneration(req);
                    times.push(performance.now() - t0);
                    if (r === 0 && seed === seeds[0]) {
                        pieces = res.pieces.length;
                        const c0 = performance.now();
                        structuredClone(res);
                        cloneMs = performance.now() - c0;
                        jsonKb = JSON.stringify(res).length / 1024;
                    }
                }
            }
            times.sort((a, b) => a - b);
            const med = times[Math.floor(times.length / 2)];
            console.log([v.name, s.id, an, pieces, med.toFixed(1), times[times.length - 1].toFixed(1), cloneMs.toFixed(2), jsonKb.toFixed(0)].join('\t'));
        }
    }
}
