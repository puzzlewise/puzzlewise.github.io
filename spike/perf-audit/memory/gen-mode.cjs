const { launch, sleep, poolImage, BASE, gc } = require('./lib.cjs');
(async () => {
    const { page, cdp, browser } = await launch();
    let workers = 0; page.on('worker', () => workers++);
    await page.route('http://localhost:8787/**', (r) => r.abort());
    await page.goto(BASE);
    await page.waitForFunction(() => !!document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(2000);
    for (const i of [1, 2, 3, 4]) {
        await gc(cdp);
        const img = poolImage(i);
        let peak = 0, run = true;
        const poll = (async () => { while (run) { const { metrics: m } = await cdp.send('Performance.getMetrics'); peak = Math.max(peak, m.find((x) => x.name === 'JSHeapUsedSize').value / 1048576); await sleep(10); } })();
        const w0 = workers;
        await page.evaluate((p) => window.__reproPuzzle(p), { seed: 900 + i, cutStyle: i % 2 ? 'wavy' : 'classic', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: img.portrait ? { cols: 12, rows: 16 } : { cols: 16, rows: 12 }, rotationMode: 'free', ...(i % 2 ? { wavyConfig: { borderless: false, traceSetVersion: 2 } } : { classicConfig: { traceSetVersion: 2 } }) });
        await sleep(1500); run = false; await poll;
        await gc(cdp);
        const { metrics: m } = await cdp.send('Performance.getMetrics');
        console.log(i, 'workers spawned', workers - w0, 'main heap peak', peak.toFixed(1), 'settled', (m.find((x) => x.name === 'JSHeapUsedSize').value / 1048576).toFixed(1));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
