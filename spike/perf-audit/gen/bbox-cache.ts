import { Bezier } from '/Users/bot/src/puzzle/node_modules/bezier-js/src/bezier.js';
import { fastReduce } from './fast-reduce.ts';
import { preloadTracedTabGenerator } from '/Users/bot/src/puzzle/src/puzzle/topology/traced-tab-loader.ts';
import { runGeneration, type GenerationRequest } from '/Users/bot/src/puzzle/src/game/generation-core.ts';
import { createHash } from 'node:crypto';
const mode = process.env.MODE ?? '';
if (mode.includes('fast')) (Bezier.prototype as any).reduce = fastReduce;
if (mode.includes('bbox')) {
  const ob = (Bezier.prototype as any).bbox;
  (Bezier.prototype as any).bbox = function () { return this.__bb ??= ob.call(this); };
}
await preloadTracedTabGenerator();
const cases: Array<[string, Partial<GenerationRequest>]> = [
  ['triangles', { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 2 } }],
  ['wavy', { cutStyle: 'wavy', wavyConfig: { borderless: false, traceSetVersion: 2 } }],
  ['wavy-bl', { cutStyle: 'wavy', wavyConfig: { borderless: true, traceSetVersion: 2 } }],
  ['classic', { cutStyle: 'classic', classicConfig: { traceSetVersion: 2 } }],
];
for (const [name, r] of cases) for (const seed of [12345, 42]) {
  const t0 = performance.now();
  const res = runGeneration({ tabDebug: false, gridSize: { cols: 16, rows: 12 }, imageSize: { width: 1920, height: 1280 }, seed, ...r } as GenerationRequest);
  const ms = performance.now() - t0;
  const digest = createHash('sha256').update(JSON.stringify(res.pieces.map(p => [p.shape, p.edges, p.bounds, p.imageOffset]))).digest('hex').slice(0, 12);
  console.log(mode || 'orig', name, seed, 'ms', ms.toFixed(0), digest);
}
