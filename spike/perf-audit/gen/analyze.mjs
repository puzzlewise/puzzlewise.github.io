import fs from 'node:fs';
import { SourceMap } from 'node:module';
const [file, mapFile, topN = 40] = process.argv.slice(2);
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const sm = new SourceMap(JSON.parse(fs.readFileSync(mapFile, 'utf8')));
const nodes = new Map(prof.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const counts = new Map();
for (const s of prof.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
const total = prof.samples.length;
function label(n) {
  const cf = n.callFrame;
  let loc = '';
  if (cf.url.includes('prof-fast.mjs') || cf.url.includes('bench-')) {
    const e = sm.findEntry(cf.lineNumber, cf.columnNumber);
    if (e && e.originalSource) loc = e.originalSource.replace(/.*\/puzzle\//, '') + ':' + (e.originalLine + 1);
  } else loc = cf.url.split('/').pop() + ':' + (cf.lineNumber + 1);
  return (cf.functionName || '(anon)') + ' ' + loc;
}
const self = new Map(), incl = new Map();
for (const [id, c] of counts) {
  const n = nodes.get(id);
  const l = label(n);
  self.set(l, (self.get(l) ?? 0) + c);
  const seen = new Set();
  let cur = id;
  while (cur !== undefined) {
    const lb = label(nodes.get(cur));
    if (!seen.has(lb)) { seen.add(lb); incl.set(lb, (incl.get(lb) ?? 0) + c); }
    cur = parent.get(cur);
  }
}
const pr = (m, t) => { console.log('== ' + t); [...m].sort((a, b) => b[1] - a[1]).slice(0, topN).forEach(([l, c]) => console.log((100 * c / total).toFixed(1).padStart(5) + '%  ' + l)); };
pr(self, 'SELF'); pr(incl, 'INCLUSIVE');
