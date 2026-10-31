const { run } = require('./measure.cjs');
const fs = require('fs');
const which = process.argv[2] || 'all';
const net = process.argv[3] || 'slow4g';
const cpu = +(process.argv[4] || 4);
const tag = process.argv[5] || '';

async function waitDone(page, extra = 0) {
  await page.waitForFunction(() => window.__m.svgImageLoad || window.__m.overlayGone && !document.querySelector('svg[data-piece-id] image'), null, { timeout: 120000 }).catch(() => {});
  if (extra) await page.waitForTimeout(extra);
}
async function overlayShot(page, name) {
  await page.waitForFunction(() => window.__m.overlayGone, null, { timeout: 120000 }).catch(() => {});
  await page.screenshot({ path: `/tmp/perf-audit/load/out/${name}-at-overlay-gone.png` });
}

(async () => {
  const dir = `/tmp/perf-audit/load/profile-${net}-${cpu}${tag}`;
  fs.rmSync(dir, { recursive: true, force: true });
  const summary = [];
  // 1. cold first visit
  summary.push(await run({ name: `cold-first-${net}-${cpu}${tag}`, net, cpu, userDataDir: dir, steps: async (page) => {
    await overlayShot(page, `cold-first-${net}-${cpu}${tag}`);
    await waitDone(page);
    const t = Date.now();
    await page.evaluate(() => navigator.serviceWorker.ready.then(r => new Promise(res => { const a = r.active; if (a && a.state === 'activated') res(); else a.addEventListener('statechange', () => a.state === 'activated' && res()); })));
    await page.waitForTimeout(500);
    return { swReadyAt: await page.evaluate(() => Math.round(performance.now())) };
  }}));
  // 2. warm reload: resume
  summary.push(await run({ name: `warm-resume-${net}-${cpu}${tag}`, net, cpu, userDataDir: dir, steps: async (page) => { await waitDone(page, 1000); return {}; } }));
  // 3. warm, no save, returning user -> Unsplash path (API stubbed, real CDN image)
  summary.push(await run({ name: `warm-unsplash-${net}-${cpu}${tag}`, net, cpu, userDataDir: dir,
    setup: async (page) => { await page.addInitScript(() => { if (!sessionStorage.__done) { localStorage.removeItem('puzzle-game-state'); localStorage.removeItem('puzzle-progress'); localStorage.setItem('puzzle-image-category', 'any'); sessionStorage.__done = 1; } }); },
    steps: async (page) => { await overlayShot(page, `warm-unsplash-${net}-${cpu}${tag}`); await waitDone(page, 1000); return {}; } }));
  for (const s of summary) {
    console.log(`\n===== ${s.name}  sw=${s.sw}`);
    console.log('nav', JSON.stringify(s.nav), 'paint', JSON.stringify(s.paint));
    console.log('marks', JSON.stringify(s.m));
    console.log('events', s.ev.map(e => `${e.t}:${e.n}${e.gen != null ? '(' + e.gen + ')' : ''}${e.mode ? '[' + e.mode + ']' : ''}`).join(' '));
    console.log('longtasks', JSON.stringify(s.lt));
    console.log('results', JSON.stringify(s.results));
    console.log('server log (url start end bytes):'); for (const r of (s.server||[])) console.log('   S', r[1], r[2], r[3], r[0]);
    for (const r of s.reqs) console.log(`  ${String(r.start).padStart(6)}-${String(r.end ?? '').padStart(6)} ${String(r.body ?? '').padStart(7)} sw=${r.sw} ${r.status ?? r.failed} ${r.type ?? ''} ${r.url}`);
  }
})();
