import { Bezier } from '/Users/bot/src/puzzle/node_modules/bezier-js/src/bezier.js';
import { fastReduce, origReduce } from './fast-reduce.ts';
import { preloadTracedTabGenerator } from '/Users/bot/src/puzzle/src/puzzle/topology/traced-tab-loader.ts';
import { runGeneration, type GenerationRequest } from '/Users/bot/src/puzzle/src/game/generation-core.ts';
import { createHash } from 'node:crypto';

const mode = process.env.MODE ?? 'verify';
let calls = 0, mismatches = 0, tOrig = 0, tFast = 0;
const same = (a: any[], b: any[]) => a.length === b.length && a.every((x, i) => Object.is(x._t1, b[i]._t1) && Object.is(x._t2, b[i]._t2) && x.points.every((p: any, k: number) => Object.is(p.x, b[i].points[k].x) && Object.is(p.y, b[i].points[k].y)));
if (mode === 'verify') {
    (Bezier.prototype as any).reduce = function () {
        calls++;
        let t = performance.now(); const a = origReduce.call(this); tOrig += performance.now() - t;
        t = performance.now(); const b = fastReduce.call(this); tFast += performance.now() - t;
        if (!same(a, b)) mismatches++;
        return a;
    };
} else if (mode === 'fast') {
    (Bezier.prototype as any).reduce = fastReduce;
}
await preloadTracedTabGenerator();
const cases: Array<[string, Partial<GenerationRequest>]> = [
  ['triangles', { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 2 } }],
  ['wavy', { cutStyle: 'wavy', wavyConfig: { borderless: false, traceSetVersion: 2 } }],
  ['wavy-bl', { cutStyle: 'wavy', wavyConfig: { borderless: true, traceSetVersion: 2 } }],
  ['wavy-legacy', { cutStyle: 'wavy', wavyConfig: { borderless: false } }],
  ['classic', { cutStyle: 'classic', classicConfig: { traceSetVersion: 2 } }],
  ['triangles-v1', { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 1 } }],
];
const sizes = (process.env.SIZES ?? '192').split(',').map(Number);
const seeds = (process.env.SEEDS ?? '12345,42').split(',').map(Number);
for (const [name, r] of cases) for (const seed of seeds) for (const n of sizes) for (const img of [{ width: 1920, height: 1280 }, { width: 3000, height: 1000 }]) {
    const grid = n === 192 ? { cols: 16, rows: 12 } : n === 96 ? { cols: 12, rows: 8 } : n === 48 ? { cols: 8, rows: 6 } : { cols: 6, rows: 4 };
    const t0 = performance.now();
    const res = runGeneration({ tabDebug: false, gridSize: grid, imageSize: img, seed, ...r } as GenerationRequest);
    const ms = performance.now() - t0;
    const digest = createHash('sha256').update(JSON.stringify(res.pieces.map(p => [p.shape, p.edges, p.bounds, p.imageOffset]))).digest('hex').slice(0, 12);
    console.log(mode, name, n, img.width + 'x' + img.height, seed, 'pieces', res.pieces.length, 'ms', ms.toFixed(0), 'digest', digest);
}
if (mode === 'verify') console.log('reduce calls', calls, 'mismatches', mismatches, 'orig ms', tOrig.toFixed(0), 'fast ms', tFast.toFixed(0));
