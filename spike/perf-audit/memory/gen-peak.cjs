const { execFileSync } = require('child_process');
const { launch, sleep, poolImage, BASE, gc } = require('./lib.cjs');

function rssOf(pid) {
    try { return +(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024).toFixed(1); } catch { return -1; }
}

(async () => {
    const { browser, page, cdp } = await launch({ dpr: 2 });
    const bcdp = await browser.newBrowserCDPSession();
    const pi = await bcdp.send('SystemInfo.getProcessInfo');
    const rpid = pi.processInfo.find((p) => p.type === 'renderer').id;
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(2000);
    for (const [label, cut, extra] of [['wavy', 'wavy', { wavyConfig: { borderless: false, traceSetVersion: 2 } }], ['classic', 'classic', { classicConfig: { traceSetVersion: 2 } }], ['wavy2', 'wavy', { wavyConfig: { borderless: false, traceSetVersion: 2 } }]]) {
        await gc(cdp);
        await sleep(500);
        const base = rssOf(rpid);
        const img = poolImage(label.length);
        let peak = base, peakHeap = 0, running = true;
        const poll = (async () => {
            while (running) {
                peak = Math.max(peak, rssOf(rpid));
                const { metrics: m } = await cdp.send('Performance.getMetrics');
                peakHeap = Math.max(peakHeap, m.find((x) => x.name === 'JSHeapUsedSize').value / 1048576);
                await sleep(20);
            }
        })();
        const t0 = Date.now();
        await page.evaluate((p) => window.__reproPuzzle(p), { seed: 31337 + label.length, cutStyle: cut, imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: img.portrait ? { cols: 12, rows: 16 } : { cols: 16, rows: 12 }, rotationMode: 'free', ...extra });
        const ms = Date.now() - t0;
        await sleep(2500);
        running = false; await poll;
        await gc(cdp); await sleep(500);
        console.log(label, `gen ${ms}ms`, `rendererRSS base ${base} peak ${peak} settled ${rssOf(rpid)} MB`, `main peak JS heap ${peakHeap.toFixed(1)} MB`);
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
