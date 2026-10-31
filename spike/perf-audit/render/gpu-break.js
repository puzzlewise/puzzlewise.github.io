const L = require('./lib.js');
const variant = process.argv[2] || '';
const CSS = { nofilter: '[data-group-id] { filter: none !important; }', nodragfilter: '[data-group-id].dragging { filter: var(--piece-edge-filter) !important; }', nowc: '[data-group-id] { will-change: auto !important; } [data-group-id].dragging { will-change: transform !important; }' };
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(96));
    for (const v of variant.split('+').filter(Boolean)) await page.addStyleTag({ content: CSS[v] });
    await page.waitForTimeout(500);
    const pc = await L.pieceCenter(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const { events } = await L.trace(cdp, async () => { await L.drag(page, pc, 60, 80, 60); await page.waitForTimeout(300); });
    const threads = {}, procs = {};
    for (const e of events) { if (e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args.name; if (e.name === 'process_name') procs[e.pid] = e.args.name; }
    const agg = {};
    for (const e of events) { if (e.ph !== 'X' || !e.dur) continue; const t = threads[`${e.pid}:${e.tid}`]; if (procs[e.pid] !== 'GPU Process') continue; const k = t + ':' + e.name; agg[k] = (agg[k] || 0) + e.dur / 1000; }
    console.log(variant || 'base', Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${k}=${v.toFixed(0)}`).join('  '));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
