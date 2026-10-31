import { Bezier } from '/Users/bot/src/puzzle/node_modules/bezier-js/src/bezier.js';
import { fastReduce } from './fast-reduce.ts';
import { preloadTracedTabGenerator } from '/Users/bot/src/puzzle/src/puzzle/topology/traced-tab-loader.ts';
import { runGeneration, type GenerationRequest } from '/Users/bot/src/puzzle/src/game/generation-core.ts';
(Bezier.prototype as any).reduce = fastReduce; const ob = (Bezier.prototype as any).bbox; (Bezier.prototype as any).bbox = function () { return this.__bb ??= ob.call(this); };
await preloadTracedTabGenerator();
for (const seed of [12345, 42, 777]) {
  const t0 = performance.now();
  runGeneration({ tabDebug: false, gridSize: { cols: 16, rows: 12 }, imageSize: { width: 1920, height: 1280 }, seed, cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 2 } } as GenerationRequest);
  console.log('ms', (performance.now() - t0).toFixed(0));
}
