const { launch, sleep, poolImage, BASE, gc } = require('./lib.cjs');

async function memDump(cdp) {
    const events = [];
    const onData = (p) => events.push(...p.value);
    cdp.on('Tracing.dataCollected', onData);
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { memoryDumpConfig: { triggers: [] }, includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'] } });
    await sleep(300);
    const r = await cdp.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
    await sleep(300);
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    const procName = {};
    for (const e of events) if (e.name === 'process_name') procName[e.pid] = e.args.name;
    const out = {};
    for (const e of events) {
        if (e.ph !== 'v') continue;
        const dumps = e.args?.dumps; if (!dumps) continue;
        const pname = procName[e.pid] || e.pid;
        const alloc = dumps.allocators || {};
        const pick = {};
        for (const [k, v] of Object.entries(alloc)) {
            if (k.split('/').length > 1 && !/^(cc\/tile_memory|cc\/resource_memory|skia\/sk_glyph_cache|skia\/sk_resource_cache|gpu\/gl|gpu\/shared_images|blink_objects\/Node|partition_alloc\/partitions\/(layout|buffer|fast_malloc|array_buffer)|discardable\/child_0|cc\/frame_memory)$/.test(k)) continue;
            const sz = v.attrs?.size?.value ?? v.attrs?.effective_size?.value;
            if (!sz) continue;
            const mb = parseInt(sz, 16) / 1048576;
            if (mb >= 0.5) pick[k] = +mb.toFixed(1);
        }
        const totals = dumps.process_totals || {};
        out[pname] = { residentMB: totals.resident_set_bytes ? +(parseInt(totals.resident_set_bytes, 16) / 1048576).toFixed(1) : undefined, ...pick };
    }
    return out;
}

(async () => {
    const dpr = Number(process.env.DPR || 2);
    const variant = process.env.VARIANT || 'default';
    const size = process.env.SIZE || '192';
    const grids = { '24': [6, 4], '48': [8, 6], '96': [12, 8], '192': [16, 12] };
    const [c, r] = grids[size];
    const { browser, page, cdp } = await launch({ dpr, viewport: { width: 1180, height: 820 } });
    const bcdp = await browser.newBrowserCDPSession();
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    const css = { default: '', nowillchange: '[data-group-id]{will-change:auto !important}', nofilter: '[data-group-id]{filter:none !important}', neither: '[data-group-id]{will-change:auto !important;filter:none !important}' }[variant];
    if (css) await page.addStyleTag({ content: css });
    const img = poolImage(5);
    await page.evaluate((p) => window.__reproPuzzle(p), { seed: 99, cutStyle: 'wavy', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: img.portrait ? { cols: r, rows: c } : { cols: c, rows: r }, rotationMode: 'free', wavyConfig: { borderless: false, traceSetVersion: 2 } });
    await sleep(4000);
    if (process.env.REMOVE_DEBUG) { const n = await page.evaluate(() => { const els = document.querySelectorAll('[data-piece-fill],[data-piece-label],[data-piece-up],[data-mateless-edge]'); els.forEach((e) => e.remove()); return els.length; }); console.log('removed', n); }
    await gc(cdp);
    await sleep(500);
    const { metrics: pm } = await cdp.send('Performance.getMetrics'); console.log('nodes', pm.find((x)=>x.name==='Nodes').value, 'heap', (pm.find((x)=>x.name==='JSHeapUsedSize').value/1048576).toFixed(2));
    const d = await memDump(bcdp);
    console.log(`DPR=${dpr} SIZE=${size} VARIANT=${variant} img=${JSON.stringify(img.imageSize)}`);
    for (const [p, v] of Object.entries(d)) if (/Renderer|GPU/i.test(p)) console.log('  ', p, JSON.stringify(v));
    if (process.env.ZOOM) {
        for (let z = 0; z < 8; z++) { await page.mouse.move(590, 410); await page.mouse.wheel(0, -400); await sleep(60); }
        await sleep(2500);
        const d2 = await memDump(bcdp);
        for (const [p, v] of Object.entries(d2)) if (/Renderer|GPU/i.test(p)) console.log('  zoomed', p, JSON.stringify(v));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
