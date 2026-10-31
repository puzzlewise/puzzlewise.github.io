import { Bezier } from '/Users/bot/src/puzzle/node_modules/bezier-js/src/bezier.js';
import { fastReduce } from '/tmp/perf-audit/gen/fast-reduce.ts';
(Bezier.prototype as any).reduce = fastReduce;
const ob = (Bezier.prototype as any).bbox;
(Bezier.prototype as any).bbox = function () { return this.__bb ??= ob.call(this); };
(globalThis as any).__patched = true;
