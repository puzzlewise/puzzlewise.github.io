const fs = require('fs');
const { SourceMapConsumer } = require('/Users/bot/src/puzzle/node_modules/source-map-js');
const file = process.argv[2];
const code = fs.readFileSync(file, 'utf8');
const map = JSON.parse(fs.readFileSync(file + '.map', 'utf8'));
const c = new SourceMapConsumer(map);
const lines = code.split('\n');
const lineStart = []; let off = 0; for (const l of lines) { lineStart.push(off); off += l.length + 1; }
const maps = []; c.eachMapping(m => maps.push(m));
maps.sort((a,b)=> a.generatedLine-b.generatedLine || a.generatedColumn-b.generatedColumn);
const bySrc = {};
for (let i = 0; i < maps.length; i++) {
  const m = maps[i], n = maps[i+1];
  const s = lineStart[m.generatedLine-1] + m.generatedColumn;
  const e = n ? lineStart[n.generatedLine-1] + n.generatedColumn : code.length;
  const k = (m.source || '(none)').replace(/^.*\/puzzle\/src\//,'src/').replace(/^.*node_modules\//,'nm/');
  bySrc[k] = (bySrc[k]||0) + (e - s);
}
const dirs = {};
for (const [k,v] of Object.entries(bySrc)) { const p=k.split('/'); const d = k.startsWith('nm/') ? p.slice(0,2).join('/') : (p[1]==='puzzle' ? p.slice(0,3).join('/') : p.slice(0,2).join('/')); dirs[d]=(dirs[d]||0)+v; }
console.log('--- by dir'); Object.entries(dirs).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(String(v).padStart(8), k));
console.log('--- top files'); Object.entries(bySrc).sort((a,b)=>b[1]-a[1]).slice(0, +process.argv[3]||25).forEach(([k,v])=>console.log(String(v).padStart(8), k));
