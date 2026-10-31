const L = require('./lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(96));
    const { events } = await L.trace(cdp, async () => {
        await page.evaluate(() => { document.body.style.outline = '1px solid transparent'; });
        await page.waitForTimeout(500);
    });
    const snap = events.filter((e) => e.ph === 'O' && e.name === 'cc::LayerTreeHostImpl').pop().args.snapshot;
    console.log(Object.keys(snap));
    const at = snap.active_tree;
    console.log(Object.keys(at));
    const ly = at.active_layers || at.layers;
    console.log('layers', ly && ly.length);
    if (ly) { const l = ly.find(x => x.tilings) || ly[5]; const c = JSON.parse(JSON.stringify(l)); delete c.tiles; console.log(JSON.stringify(c).slice(0, 2500)); }
    require('fs').writeFileSync('/tmp/perf-audit/render/snap.json', JSON.stringify(snap));
    const names = {}; for (const e of events) if (e.dur) names[e.name] = (names[e.name] || 0) + e.dur / 1000;
    console.log(Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, v]) => `${k}:${v.toFixed(1)}`).join('  '));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
