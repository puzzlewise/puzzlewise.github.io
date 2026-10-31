const L = require('./lib.js');
const pieces = +(process.argv[2] || 96);
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(pieces));
    if (process.argv[3] !== 'nosolve') { await page.evaluate(() => window.__solvePuzzle()); await page.waitForTimeout(3000); await page.mouse.click(10, 880); await page.waitForTimeout(1500); }
    await cdp.send('DOM.getDocument', { depth: -1 });
    let layers = null;
    cdp.on('LayerTree.layerTreeDidChange', (e) => { if (e.layers) layers = e.layers; });
    await cdp.send('LayerTree.enable');
    for (let i = 0; i < 10 && !layers; i++) { await page.evaluate(() => { document.body.appendChild(document.createElement('i')); }); await page.waitForTimeout(200); }
    const reasonsFor = async (id) => { try { return (await cdp.send('LayerTree.compositingReasons', { layerId: id })).compositingReasonIds.join(','); } catch { return '?'; } };
    const rows = [];
    for (const l of layers || []) {
        if (!l.drawsContent) continue;
        let desc = '';
        if (l.backendNodeId) { try { const d = await cdp.send('DOM.describeNode', { backendNodeId: l.backendNodeId }); desc = `${d.node.nodeName}${(d.node.attributes || []).join(' ').slice(0, 80)}`; } catch (e) { desc = 'n/a'; } }
        rows.push(`${Math.round(l.width)}x${Math.round(l.height)} ${await reasonsFor(l.layerId)} ${desc}`);
    }
    console.log(rows.length, '\n' + rows.slice(0, 40).join('\n'));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
