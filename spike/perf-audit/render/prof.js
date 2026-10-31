const L = require('./lib.js');
const pieces = +(process.argv[2] || 192);
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(pieces));
    const pc = await L.pieceCenter(page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Profiler.start');
    await L.drag(page, pc, 60, 80, 60);
    const { profile } = await cdp.send('Profiler.stop');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    const dt = profile.timeDeltas; let total = 0;
    profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + dt[i] / 1000); total += dt[i] / 1000; });
    // inclusive for renderState
    const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const incl = new Map();
    profile.samples.forEach((id, i) => { const seen = new Set(); let cur = id; while (cur) { const n = byId.get(cur); const f = n.callFrame.functionName; if (f && !seen.has(f)) { seen.add(f); incl.set(f, (incl.get(f) || 0) + dt[i] / 1000); } cur = parent.get(cur); } });
    console.log('pieces', pieces, 'total sampled ms', total.toFixed(0));
    console.log('inclusive:', ['renderState', 'renderGroup', 'applyGroupTransform', 'positionPiece', 'onStateChanged', 'handlePointerMove', 'save', 'autoSave', 'setGroupSelected', 'moveGroup', 'requestRender', 'onGroupMoved', 'probeNearbyPieceId'].map((f) => `${f}=${(incl.get(f) || 0).toFixed(1)}`).join(' '));
    console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}=${v.toFixed(1)}`).join('\n'));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
