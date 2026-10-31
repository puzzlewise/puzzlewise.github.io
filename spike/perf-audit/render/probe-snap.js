const L = require('./lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(96));
    const { events } = await L.trace(cdp, async () => {
        await page.evaluate(() => { document.body.style.outline = '1px solid transparent'; });
        await page.waitForTimeout(500);
    });
    const names = {};
    for (const e of events) if (e.ph === 'O') names[e.name] = (names[e.name] || 0) + 1;
    console.log(names);
    const snap = events.filter((e) => e.ph === 'O' && e.name === 'cc::LayerTreeHostImpl').pop();
    if (snap) {
        const s = JSON.stringify(snap.args.snapshot);
        console.log(s.length, s.slice(0, 3000));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
