const L = require('./lib.js');
const S = require('./scenarios.js');
const T = require('./trace-lib.js');
const P = require('./prof-lib.js');

const RATE = Number(process.env.RATE || 4);

async function measure(name, browser, page, cdp, fn) {
    await L.resetPerf(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
    let prof;
    const ev = await T.withTrace(browser, page, async () => {
        prof = await P.withProfile(cdp, fn, 100);
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const perf = await page.evaluate(() => window.__perf);
    require('fs').writeFileSync('/tmp/perf-audit/interact/trace-' + name.split(':')[0] + '.json', JSON.stringify({ traceEvents: ev }));
    const s = T.summarize(ev);
    const a = P.analyze(prof, 18);
    console.log(`\n##### ${name} (rate ${RATE}x)`);
    console.log('pointermove handler (in-page)', L.stats(perf.events.filter((e) => e.type === 'pointermove').map((e) => e.ms)));
    console.log('pointerup handler (in-page)', perf.events.filter((e) => e.type === 'pointerup').map((e) => e.ms.toFixed(1)));
    console.log('renderState', L.stats(perf.render), 'flash', perf.flash.map((x) => x.toFixed(1)), 'bringToFront calls', perf.bring);
    console.log('setItem', perf.setItem.map((x) => `${x.k}:${x.len}B/${x.ms.toFixed(1)}ms`));
    for (const k of ['EventDispatch pointermove', 'EventDispatch pointerup', 'EventDispatch pointerdown', 'UpdateLayoutTree', 'elementCount', 'Layout', 'layoutDirtyObjects', 'Layerize', 'Commit', 'PrePaint', 'Paint', 'GC', 'longTasks', 'forcedLayouts', 'forcedStyle', 'mainBusyMs']) console.log(`  ${k}: ${JSON.stringify(s[k])}`);
    console.log('--- profile total (top) ---\n' + a.total.split('\n').filter((l) => !/\(root\)|\(idle\)|\(program\)/.test(l)).slice(0, 16).join('\n'));
    return { perf, s };
}

(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.loadPuzzle(page, 12, 16, 'free');
    const { st, pr } = await S.readSave(page);
    const g = S.gridOf(st);
    const ids = st.pieces.map((p) => p.id);
    const byRow = (maxRow) => ids.filter((id) => g.map.get(id).row <= maxRow);

    // A: big group of 168 (rows 0..13) + 24 singles
    const scen = process.env.SCEN || 'ABCD';
    if (scen.includes('A')) {
        await S.installProgress(page, S.buildProgress(st, pr, { bigIds: byRow(13) }));
        await L.instrument(page);
        await page.screenshot({ path: '/tmp/perf-audit/interact/s4-A.png' });
        const pid = byRow(13)[30];
        const c = await L.pieceCenter(page, pid); console.log('A grab point', c);
        await measure('A: drag 168-piece group', browser, page, cdp, async () => {
            await L.touchDrag(cdp, c, { x: c.x + 40, y: c.y + 60 }, 60);
            await L.sleep(800);
        });
    }

    // B: 192 singles laid out in grid, 100 selected; drag one selected.
    if (scen.includes('B')) {
        const prog = S.buildProgress(st, pr, {
            singlesOverride: (i) => ({ x: (i % 12) * 130, y: Math.floor(i / 12) * 160 }),
            selection: (groups) => groups.slice(0, 100).map((gr) => gr.id),
        });
        await S.installProgress(page, prog);
        await L.instrument(page);
        await page.screenshot({ path: '/tmp/perf-audit/interact/s4-B.png' });
        const selPiece = prog.groups[5].pieces[0][0];
        const c = await L.pieceCenter(page, selPiece);
        await measure('B: drag multi-selection of 100 singles (192 groups)', browser, page, cdp, async () => {
            await L.touchDrag(cdp, c, { x: c.x + 40, y: c.y + 60 }, 60);
            await L.sleep(800);
        });
        // Also a tap to toggle selection (selection onChange → setGroupSelected over all groups + autosave)
        const other = prog.groups[150].pieces[0][0];
        const c2 = await L.pieceCenter(page, other);
        await measure('B2: tap-toggle selection', browser, page, cdp, async () => {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c2.x, y: c2.y, id: 1 }] });
            await L.sleep(30);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await L.sleep(800);
        });
    }

    // C: merge last piece into 191-piece group → win.
    if (scen.includes('C') || scen.includes('D')) {
        const X = ids.find((id) => g.map.get(id).row === 8 && g.map.get(id).col === 6);
        const others = ids.filter((id) => id !== X);
        const D = scen.includes('D') && !scen.includes('C');
        const bigIds = D ? byRow(13) : others;
        const extra = D ? ids.find((id) => g.map.get(id).row === 14 && g.map.get(id).col === 5) : X;
        const prog = S.buildProgress(st, pr, {
            bigIds,
            singlesOverride: (i, id) => (id === extra ? { x: 1250, y: 700 } : { x: 1150 + (i % 3) * 150, y: 1000 + Math.floor(i / 3) * 200 }),
        });
        await S.installProgress(page, prog);
        await L.instrument(page);
        const cur = await S.pieceOriginScreen(page, extra);
        const im = g.map.get(extra).imageOffset;
        const targetScreen = { x: 10 + cur.scale * (-im.x), y: 120 + cur.scale * (-im.y) };
        const delta = { x: targetScreen.x - cur.x, y: targetScreen.y - cur.y };
        const c = await L.pieceCenter(page, extra);
        await page.screenshot({ path: `/tmp/perf-audit/interact/s4-${D ? 'D' : 'C'}-before.png` });
        await measure(D ? 'D: drop single onto 168-group (merge, no win)' : 'C: drop last piece (merge into 191 + win)', browser, page, cdp, async () => {
            await S.preciseDrag(cdp, c, delta, 40);
            await L.sleep(1500);
        });
        await page.screenshot({ path: `/tmp/perf-audit/interact/s4-${D ? 'D' : 'C'}-after.png` });
        console.log('groups after:', await page.evaluate(() => document.querySelectorAll('[data-group-id]').length));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
