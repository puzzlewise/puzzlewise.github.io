const L = require('./lib.js');
const S = require('./scenarios.js');

async function sampleAlloc(cdp, fn) {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await fn();
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const totals = new Map();
    let all = 0;
    const walk = (n, stack) => {
        const cf = n.callFrame;
        const k = `${cf.functionName || '(anon)'} ${(cf.url || '').replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
        if (n.selfSize) { totals.set(k, (totals.get(k) || 0) + n.selfSize); all += n.selfSize; }
        for (const c of n.children) walk(c, stack);
    };
    walk(profile.head, []);
    return { all, top: [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14) };
}

(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.loadPuzzle(page, 12, 16, 'free');
    const MOVES = 120;
    let c = await L.pieceCenter(page, 50);
    let r = await sampleAlloc(cdp, async () => { await L.touchDrag(cdp, c, { x: 206, y: 300 }, MOVES); await L.sleep(200); });
    console.log(`single-piece drag: ${(r.all / 1024).toFixed(0)} KB sampled over ${MOVES} moves = ${(r.all / MOVES / 1024).toFixed(1)} KB/move`);
    for (const [k, v] of r.top) console.log(`  ${(v / 1024).toFixed(1).padStart(8)} KB  ${k}`);

    const { st, pr } = await S.readSave(page);
    const prog = S.buildProgress(st, pr, {
        singlesOverride: (i) => ({ x: (i % 12) * 130, y: Math.floor(i / 12) * 160 }),
        selection: (groups) => groups.slice(0, 100).map((gr) => gr.id),
    });
    await S.installProgress(page, prog);
    c = await L.pieceCenter(page, prog.groups[5].pieces[0][0]);
    r = await sampleAlloc(cdp, async () => { await L.touchDrag(cdp, c, { x: c.x + 40, y: c.y + 60 }, MOVES); await L.sleep(200); });
    console.log(`multi-select(100) drag: ${(r.all / 1024).toFixed(0)} KB over ${MOVES} moves = ${(r.all / MOVES / 1024).toFixed(1)} KB/move`);
    for (const [k, v] of r.top) console.log(`  ${(v / 1024).toFixed(1).padStart(8)} KB  ${k}`);
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
