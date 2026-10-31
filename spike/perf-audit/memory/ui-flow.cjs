const { launch, metrics, sleep, BASE, heapSnapshot, analyzeSnapshot } = require('./lib.cjs');
const SIZES = ['24', '48', '96', '192'];
(async () => {
    const { page, cdp, browser } = await launch();
    await page.route('http://localhost:8787/**', (r) => r.abort());
    await page.route('https://api.unsplash.com/**', (r) => r.abort());
    await page.addInitScript({ path: '/tmp/perf-audit/memory/timer-probe.js' });
    await page.goto(BASE);
    await page.waitForFunction(() => !!document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(2000);
    console.log('boot', JSON.stringify(await metrics(page, cdp)));
    const clickSel = async (sel) => { const r = await page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel); await page.mouse.click(r.x, r.y); };
    for (let i = 1; i <= 14; i++) {
        await clickSel('.new-game-button');
        await page.waitForFunction(() => !!document.querySelector('[data-testid="size-select"]'));
        await sleep(400);
        await page.evaluate((v) => { const s = document.querySelector('[data-testid="size-select"]'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, SIZES[i % 4]);
        await clickSel(i % 3 === 0 ? '[data-testid="image-picker-blank"]' : '[data-testid="image-picker-surprise"]');
        await page.waitForFunction(() => !document.querySelector('.loading-overlay') && !!document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
        await sleep(1500);
        // tap a few pieces to spawn rotate handles
        for (let t = 0; t < 6; t++) {
            const pt = await page.evaluate(() => { const s = [...document.querySelectorAll('svg[data-piece-id]')]; const e = s[Math.floor(Math.random() * s.length)]; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
            await page.mouse.click(pt.x, pt.y); await sleep(120);
        }
        await page.mouse.click(5, 400); // background tap
        await sleep(300);
        const m = await metrics(page, cdp);
        const ts = await page.evaluate(() => window.__timerStats());
        console.log(i, SIZES[i % 4], JSON.stringify({ heap: m.heapMB, nodes: m.nodes, attached: m.attachedEls, listeners: m.listeners, workers: m.workers, liveTimeouts: ts.liveTimeouts.length, intervals: ts.liveIntervals }));
    }
    await sleep(6000);
    const ts = await page.evaluate(() => window.__timerStats());
    console.log('final live timeouts', JSON.stringify(ts.liveTimeouts), 'intervals', ts.liveIntervals, JSON.stringify(ts.intervalStacks));
    await heapSnapshot(cdp, '/tmp/perf-audit/memory/ui-last.heapsnapshot');
    const a = analyzeSnapshot('/tmp/perf-audit/memory/ui-last.heapsnapshot');
    console.log('detached', a.detached, JSON.stringify([...a.detByName.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
