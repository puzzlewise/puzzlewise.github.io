const L = require('./lib.js');
const pieces = +(process.argv[2] || 96);
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(pieces));
    await page.evaluate(() => window.__solvePuzzle());
    await page.waitForTimeout(3000);
    const s = await L.rawSnap(page, cdp); if (!s) { console.log("no snap"); return browser.close(); }
    const memBy = {}; for (const t of s.active_tiles) memBy[t.layer_id] = (memBy[t.layer_id] || 0) + t.gpu_memory_usage;
    const top = s.active_tree.layers.filter((l) => memBy[l.layer_id]).sort((a, b) => memBy[b.layer_id] - memBy[a.layer_id]).slice(0, 5);
    console.log(pieces, 'total MB', (Object.values(memBy).reduce((a, b) => a + b, 0) / 1048576).toFixed(1), 'table', await L.tableScale(page));
    for (const l of top) console.log((memBy[l.layer_id] / 1048576).toFixed(1) + 'MB', JSON.stringify(l.bounds), 'scale', l.tilings.map((t) => t.content_scale.toFixed(3)).join('/'), 'ideal', l.ideal_contents_scale.toFixed(3), l.compositing_reason_ids.join(','));
    // dismiss overlay -> glow removed
    await page.mouse.click(10, 880); await page.waitForTimeout(2000);
    console.log('after dismiss', JSON.stringify(await L.snapNow(page, cdp)));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
