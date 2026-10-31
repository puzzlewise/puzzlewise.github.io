const { launch, sleep, poolImage, BASE } = require('./lib.cjs');
(async () => {
    const { browser, page, cdp } = await launch();
    const origin = new URL(BASE).origin;
    await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(4000);
    const show = async (label) => {
        const q = await cdp.send('Storage.getUsageAndQuota', { origin });
        const c = await page.evaluate(async () => { const o = {}; for (const n of await caches.keys()) o[n] = (await (await caches.open(n)).keys()).length; return o; });
        console.log(label, Math.round(q.usage / 1024), 'KB', JSON.stringify(c));
    };
    await show('boot');
    for (let i = 0; i < 10; i++) { await page.reload(); await page.waitForFunction(() => document.querySelector('[data-piece-id]'), null, { timeout: 60000 }); await sleep(800); }
    await show('after 10 reloads');
    for (let i = 1; i <= 10; i++) {
        const img = poolImage(i + 40);
        await page.evaluate((p) => window.__reproPuzzle(p), { seed: 50 + i, cutStyle: 'wavy', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: { cols: 8, rows: 6 }, rotationMode: 'free', wavyConfig: { borderless: false, traceSetVersion: 2 } });
        await sleep(1200);
    }
    await show('after 10 games');
    for (let i = 0; i < 10; i++) { await page.reload(); await page.waitForFunction(() => document.querySelector('[data-piece-id]'), null, { timeout: 60000 }); await sleep(800); }
    await show('after 10 more reloads');
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
