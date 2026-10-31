const L = require('./lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(96), process.argv[2]);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const { events } = await L.trace(cdp, async () => {
        await page.evaluate(() => { const g = document.querySelectorAll('[data-group-id]')[10]; g.classList.add('merge-pulse'); });
        await page.waitForTimeout(600);
    });
    const anim = events.filter((e) => e.name === 'Animation' || /compositeFailed|CompositorAnimation/.test(JSON.stringify(e.args || {})));
    for (const e of anim.slice(0, 6)) console.log(e.ph, e.name, JSON.stringify(e.args).slice(0, 300));
    const r = L.analyze(events); console.log(JSON.stringify(r.stages));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
