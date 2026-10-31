const L = require('./lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(96));
    const { events } = await L.trace(cdp, async () => {
        for (let i = 0; i < 15; i++) { await page.mouse.move(206, 446); await page.mouse.wheel(0, -50); await page.waitForTimeout(16); }
        await page.waitForTimeout(300);
        for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, 50); await page.waitForTimeout(16); }
        await page.waitForTimeout(800);
    });
    const threads = {}; for (const e of events) if (e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args.name;
    const procs = {}; for (const e of events) if (e.name === 'process_name') procs[e.pid] = e.args.name;
    const agg = {};
    for (const e of events) { if (e.ph !== 'X' || !e.dur) continue; const t = (procs[e.pid]||e.pid) + '/' + (threads[`${e.pid}:${e.tid}`] || e.tid); agg[t] = agg[t] || {}; agg[t][e.name] = (agg[t][e.name] || 0) + e.dur / 1000; }
    for (const [t, m] of Object.entries(agg)) { const top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 14); console.log('==', t); console.log(top.map(([k, v]) => `${k}:${v.toFixed(1)}`).join('  ')); }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
