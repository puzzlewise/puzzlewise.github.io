const { run } = require('./measure.cjs');
const fs = require('fs');
const flagsets = { base: [], preload: ['__PROTO_PRELOAD'], defersw: ['__PROTO_DEFER_SW_ON'], both: ['__PROTO_PRELOAD', '__PROTO_DEFER_SW_ON'] };
const reps = +(process.argv[2] || 2);
(async () => {
  const rows = [];
  for (let rep = 0; rep < reps; rep++) for (const [k, flags] of Object.entries(flagsets)) {
    const dir = `/tmp/perf-audit/load/profile-var-${k}`;
    fs.rmSync(dir, { recursive: true, force: true });
    const setFlags = async (page) => { await page.addInitScript((fl) => { for (const f of fl) globalThis[f] = true; }, flags); };
    const wait = async (page) => { await page.waitForFunction(() => window.__m.svgImageLoad, null, { timeout: 120000 }); await page.waitForTimeout(300); return {}; };
    const a = await run({ name: `var-${k}-cold-${rep}`, net: 'none', cpu: 4, userDataDir: dir, setup: setFlags, steps: wait });
    const b = await run({ name: `var-${k}-unsplash-${rep}`, net: 'none', cpu: 4, userDataDir: dir,
      setup: async (page) => { await setFlags(page); await page.addInitScript(() => { if (!sessionStorage.__done) { localStorage.removeItem('puzzle-game-state'); localStorage.removeItem('puzzle-progress'); localStorage.setItem('puzzle-image-category', 'any'); sessionStorage.__done = 1; } }); }, steps: wait });
    for (const r of [a, b]) { const row = `${r.name.padEnd(26)} sw=${r.sw.padEnd(12)} overlayGone=${r.m.overlayGone} imgLoad=${r.m.svgImageLoad} lcp=${r.m.lcp} swPrecacheEnd=${Math.max(0,...r.reqs.filter(q=>q.frame!=="page"||q.type==="fetch").map(q=>q.end||0))} imgReqs=${r.reqs.filter(q => /first-puzzle|cdn\//.test(q.url) && !q.sw).map(q => q.start + '-' + q.end).join(',')}`; console.log(row); rows.push(row); }
  }
})();
