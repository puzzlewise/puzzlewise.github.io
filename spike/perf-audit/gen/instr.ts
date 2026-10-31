import { Bezier } from '/Users/bot/src/puzzle/node_modules/bezier-js/src/bezier.js';
import { Curve } from '/Users/bot/src/puzzle/src/puzzle/topology/curve.ts';
import { preloadTracedTabGenerator } from '/Users/bot/src/puzzle/src/puzzle/topology/traced-tab-loader.ts';
import { tracedTabGenerator } from '/Users/bot/src/puzzle/src/puzzle/topology/traced-tab-generator.ts';
import { runGeneration, type GenerationRequest } from '/Users/bot/src/puzzle/src/game/generation-core.ts';

const stats: Record<string, number> = {};
const inc = (k: string, v = 1) => { stats[k] = (stats[k] ?? 0) + v; };
const origReduce = (Bezier.prototype as any).reduce;
(Bezier.prototype as any).reduce = function () { inc('reduce.calls'); const t = performance.now(); const r = origReduce.call(this); inc('reduce.ms', performance.now() - t); return r; };
const origIntersect = Curve.prototype.intersect;
Curve.prototype.intersect = function (o: Curve, tol?: number) { inc('intersect.calls'); const t = performance.now(); const r = origIntersect.call(this, o, tol); inc('intersect.ms', performance.now() - t); return r; };
const keyCounts = new Map<string, number>();
const origCI = (Bezier.prototype as any).curveintersects;
// count unique segment keys being reduced
const origReduce2 = (Bezier.prototype as any).reduce;
(Bezier.prototype as any).reduce = function () { const k = this.points.map((p: any) => p.x + ',' + p.y).join(';'); keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1); return origReduce2.call(this); };
const origGV = tracedTabGenerator.generateVariants!;
let variantYields = 0;
(tracedTabGenerator as any).generateVariants = function (...a: any[]) { const it = origGV.apply(this, a as any); inc('edges'); return (function* () { for (const v of it as any) { variantYields++; yield v; } })(); };

await preloadTracedTabGenerator();
const style = process.env.STYLE ?? 'triangles';
const reqs: Record<string, Partial<GenerationRequest>> = {
  triangles: { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 2 } },
  wavy: { cutStyle: 'wavy', wavyConfig: { borderless: false, traceSetVersion: 2 } },
  classic: { cutStyle: 'classic', classicConfig: { traceSetVersion: 2 } },
};
const t0 = performance.now();
const res = runGeneration({ tabDebug: false, gridSize: { cols: 16, rows: 12 }, imageSize: { width: 1920, height: 1280 }, seed: 12345, ...reqs[style] } as GenerationRequest);
const total = performance.now() - t0;
let dup = 0; for (const c of keyCounts.values()) if (c > 1) dup += c - 1;
console.log(style, 'pieces', res.pieces.length, 'total ms', total.toFixed(0), JSON.stringify(stats, (k, v) => typeof v === 'number' ? Math.round(v) : v), 'variantYields', variantYields, 'uniqueReduceKeys', keyCounts.size, 'dupReduces', dup);
