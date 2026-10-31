const L = require('./lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(96));
    console.log(await page.evaluate(() => document.getAnimations().map((a) => ({ name: a.animationName || a.transitionProperty || a.constructor.name, state: a.playState, target: a.effect && a.effect.target && (a.effect.target.className || a.effect.target.tagName), iters: a.effect && a.effect.getTiming().iterations }))));
    // paint invalidation tracking: which nodes get painted during idle
    const { events } = await L.trace(cdp, async () => { await page.waitForTimeout(1000); });
    const paints = {};
    for (const e of events) if (e.name === 'Paint' && e.args && e.args.data) { const k = (e.args.data.nodeId || '') + ' ' + JSON.stringify(e.args.data.clip).slice(0, 60); paints[k] = (paints[k] || 0) + 1; }
    console.log(Object.entries(paints).slice(0, 10));
    const inval = {};
    for (const e of events) if (/Invalidat|ScheduleStyle|StyleRecalcInvalidation|LayoutInvalidation|PaintInvalidation/.test(e.name)) { const k = e.name + ' ' + JSON.stringify(e.args && e.args.data).slice(0, 150); inval[k] = (inval[k] || 0) + 1; }
    console.log(inval);
    const nodes = await cdp.send('DOM.getDocument', { depth: -1 });
    const ids = Object.keys(paints).map((k) => +k.split(' ')[0]).filter(Boolean);
    for (const id of ids.slice(0, 5)) { try { const d = await cdp.send('DOM.describeNode', { backendNodeId: id }); console.log(id, d.node.nodeName, JSON.stringify(d.node.attributes)); } catch (e) { console.log(id, e.message); } }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
