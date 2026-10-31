const L = require('./lib.js');

(async () => {
    const { browser, page, cdp } = await L.launch();
    const t = Date.now();
    await L.loadPuzzle(page, 12, 16, 'free');
    console.log('loaded in', Date.now() - t, 'ms');
    await page.screenshot({ path: '/tmp/perf-audit/interact/s1-loaded.png' });
    await L.instrument(page);
    const info = await page.evaluate(() => ({
        groups: document.querySelectorAll('[data-group-id]').length,
        pieces: document.querySelectorAll('svg[data-piece-id]').length,
        domNodes: document.getElementsByTagName('*').length,
    }));
    console.log(info);

    for (const rate of [1, 4, 6]) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        const pid = 40 + rate;
        const c = await L.pieceCenter(page, pid);
        await L.resetPerf(page);
        await L.touchDrag(cdp, c, { x: 206, y: 446 }, 60);
        await L.sleep(800);
        const p = await page.evaluate(() => window.__perf);
        const moves = p.events.filter((e) => e.type === 'pointermove').map((e) => e.ms);
        console.log(`rate ${rate}x piece ${pid} ${c.miss ? '(MISS)' : ''}`);
        console.log('  pointermove handler ms', L.stats(moves));
        console.log('  renderState ms', L.stats(p.render));
        console.log('  pointerup', p.events.filter((e) => e.type === 'pointerup').map((e) => e.ms.toFixed(2)));
        console.log('  setItem', p.setItem.map((s) => `${s.k}:${s.len}B/${s.ms.toFixed(2)}ms`));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
