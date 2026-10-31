const { launch, sleep, BASE, gc } = require('./lib.cjs');
(async () => {
    const { page, cdp, browser } = await launch();
    await page.route('http://localhost:8787/**', (r) => r.abort());
    await page.goto(BASE);
    await page.waitForFunction(() => !!document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(2000);
    const clickSel = async (sel) => { const r = await page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel); await page.mouse.click(r.x, r.y); };
    for (let i = 1; i <= 4; i++) {
        await clickSel('.new-game-button');
        await page.waitForFunction(() => !!document.querySelector('[data-testid="size-select"]'));
        await sleep(300);
        await page.evaluate(() => { const s = document.querySelector('[data-testid="size-select"]'); s.value = '192'; s.dispatchEvent(new Event('change', { bubbles: true })); });
        await gc(cdp);
        let peak = 0, run = true;
        const poll = (async () => { while (run) { const { metrics: m } = await cdp.send('Performance.getMetrics'); peak = Math.max(peak, m.find((x) => x.name === 'JSHeapUsedSize').value / 1048576); await sleep(10); } })();
        await clickSel('[data-testid="image-picker-surprise"]');
        await page.waitForFunction(() => !document.querySelector('.loading-overlay') && document.querySelectorAll('[data-piece-id]').length > 150, null, { timeout: 60000 });
        await sleep(1000); run = false; await poll; await gc(cdp);
        const { metrics: m } = await cdp.send('Performance.getMetrics');
        console.log(i, 'UI new 192 game: main heap peak', peak.toFixed(1), 'settled', (m.find((x) => x.name === 'JSHeapUsedSize').value / 1048576).toFixed(1));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
