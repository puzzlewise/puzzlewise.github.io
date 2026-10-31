const fs = require('fs');
const { SourceMapConsumer } = require('/Users/bot/src/puzzle/node_modules/source-map-js');
function attrib(file) {
  const code = fs.readFileSync(file, 'utf8'); const c = new SourceMapConsumer(JSON.parse(fs.readFileSync(file + '.map', 'utf8')));
  const ls = []; let o = 0; for (const l of code.split('\n')) { ls.push(o); o += l.length + 1; }
  const m = []; c.eachMapping(x => m.push(x)); m.sort((a, b) => a.generatedLine - b.generatedLine || a.generatedColumn - b.generatedColumn);
  const by = {}; const ranges = {};
  for (let i = 0; i < m.length; i++) { const s = ls[m[i].generatedLine - 1] + m[i].generatedColumn; const e = m[i + 1] ? ls[m[i + 1].generatedLine - 1] + m[i + 1].generatedColumn : code.length; const k = (m[i].source || '').replace(/^.*\/src\//, 'src/').replace(/^.*node_modules\//, 'nm/'); by[k] = (by[k] || 0) + e - s; (ranges[k] ||= []).push([s, e]); }
  return { by, code, ranges };
}
const d = '/tmp/perf-audit/load/dist-map/assets/';
const main = attrib(d + fs.readdirSync(d).find(f => /^index-.*\.js$/.test(f)));
const w = attrib(d + fs.readdirSync(d).find(f => /^generation-worker-.*\.js$/.test(f)));
let shared = 0; const ks = []; let sharedCode = '';
for (const k of Object.keys(main.by)) if (w.by[k]) { shared += main.by[k]; ks.push(k); for (const [s, e] of main.ranges[k]) sharedCode += main.code.slice(s, e); }
const zlib = require('zlib');
console.log('main total', main.code.length, 'gz', zlib.gzipSync(main.code).length);
console.log('bytes in main from modules also in worker:', shared, 'gz~', zlib.gzipSync(sharedCode).length, 'modules', ks.length);
console.log(ks.filter(k => !k.startsWith('src/puzzle') && !k.startsWith('nm/')).join(' '));
