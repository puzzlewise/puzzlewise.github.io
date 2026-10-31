const { chromium } = require('/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const L = require('./lib.js');
(async () => {
  for (const mode of ['emul', 'force']) {
    const browser = await chromium.launch({ channel: 'chromium', headless: true, args: mode === 'force' ? ['--force-device-scale-factor=2.625'] : [] });
    const ctx = await browser.newContext(mode === 'force'
      ? { viewport: { width: 412, height: 892 }, hasTouch: true }
      : { viewport: { width: 412, height: 892 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
    await L.boot(page, L.params(96));
    const { events } = await L.trace(cdp, async () => { await page.evaluate(() => { document.body.style.outline = '1px solid transparent'; }); await page.waitForTimeout(500); });
    const snap = events.filter((e) => e.ph === 'O' && e.name === 'cc::LayerTreeHostImpl').pop().args.snapshot;
    const l = snap.active_tree.layers.find(x => (x.compositing_reason_ids||[]).includes('WillChangeTransform'));
    const mem = snap.active_tiles.reduce((a, t) => a + (t.gpu_memory_usage || 0), 0);
    console.log(mode, 'sst', l.screen_space_transform.slice(0,2), 'bounds', JSON.stringify(l.bounds), 'tilings', JSON.stringify(l.tilings.map(t=>t.content_scale)), JSON.stringify(snap.device_viewport_size), 'dpr', await page.evaluate(() => devicePixelRatio), 'scale', await page.evaluate(() => document.querySelector('[data-puzzle-table]').style.transform), 'cs', l.ideal_contents_scale, l.raster_scales, 'tiles', snap.active_tiles.length, 'MB', (mem/1e6).toFixed(1));
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
