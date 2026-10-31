const { launch, sleep, poolImage, BASE, metrics } = require('./lib.cjs');

(async () => {
    const { browser, context, page, cdp } = await launch();
    await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.getRegistration().then((r) => r?.active), null, { timeout: 30000 }).catch(() => {});
    await sleep(4000);
    const origin = new URL(BASE).origin;
    const q = await cdp.send('Storage.getUsageAndQuota', { origin });
    console.log('usageAndQuota after first boot', JSON.stringify({ usageKB: Math.round(q.usage / 1024), quotaMB: Math.round(q.quota / 1048576), breakdown: q.usageBreakdown.filter((b) => b.usage).map((b) => `${b.storageType}=${Math.round(b.usage / 1024)}KB`) }));
    const caches = await page.evaluate(async () => {
        const out = {};
        for (const name of await caches.keys()) { const c = await caches.open(name); const keys = await c.keys(); out[name] = keys.length; }
        return { out, reg: !!(await navigator.serviceWorker.getRegistration()), hasDevHook: typeof window.__reproPuzzle };
    });
    console.log('caches', JSON.stringify(caches));
    const ls = await page.evaluate(() => { const o = {}; for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k); o[key] = localStorage.getItem(key).length; } return o; });
    console.log('localStorage', JSON.stringify(ls));
    // reload a few times to see SW update churn / caches stable
    for (let i = 0; i < 3; i++) { await page.reload(); await page.waitForFunction(() => document.querySelector('[data-piece-id]'), null, { timeout: 60000 }); await sleep(1500); }
    const q2 = await cdp.send('Storage.getUsageAndQuota', { origin });
    console.log('usage after 3 reloads', Math.round(q2.usage / 1024), 'KB');
    if (caches.hasDevHook === 'function') {
        for (let i = 1; i <= 4; i++) {
            const img = poolImage(i + 20);
            await page.evaluate((p) => window.__reproPuzzle(p), { seed: 5 + i, cutStyle: 'wavy', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: img.portrait ? { cols: 12, rows: 16 } : { cols: 16, rows: 12 }, rotationMode: 'free', wavyConfig: { borderless: false, traceSetVersion: 2 } });
            await sleep(2000);
        }
        const q3 = await cdp.send('Storage.getUsageAndQuota', { origin });
        console.log('usage after 4 new unsplash games', Math.round(q3.usage / 1024), 'KB', JSON.stringify(q3.usageBreakdown.filter((b) => b.usage).map((b) => `${b.storageType}=${Math.round(b.usage / 1024)}KB`)));
        console.log('metrics prod 192', JSON.stringify(await metrics(page, cdp)));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
