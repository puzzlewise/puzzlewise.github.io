const L = require('./lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(96));
    for (const cats of ['devtools.timeline', 'devtools.timeline,disabled-by-default-devtools.timeline', 'blink,cc,benchmark']) {
        const events = [];
        const onData = (d) => { for (const e of d.value) events.push(e); };
        cdp.on('Tracing.dataCollected', onData);
        await cdp.send('Tracing.start', { categories: cats, transferMode: 'ReportEvents' });
        const pc = await L.pieceCenter(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const m0 = await cdp.send('Performance.getMetrics').catch(() => null);
        await L.drag(page, pc, 30, 40, 40);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
        await cdp.send('Tracing.end'); await done; cdp.off('Tracing.dataCollected', onData);
        const cnt = {}; for (const e of events) if (e.ph === 'X' && /Layerize|PaintArtifactCompositor|UpdateLayers|Commit$|BeginMainFrame$|^Paint$|UpdateLayoutTree|HitTest/.test(e.name)) { cnt[e.name] = cnt[e.name] || [0, 0]; cnt[e.name][0]++; cnt[e.name][1] += e.dur / 1000; }
        console.log(cats, JSON.stringify(Object.fromEntries(Object.entries(cnt).map(([k, v]) => [k, `${v[0]}/${v[1].toFixed(1)}ms`]))));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
