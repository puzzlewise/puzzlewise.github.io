const L = require('./lib.js');

async function listenerCounts(cdp) {
    const out = {};
    for (const [name, expr] of [['window', 'window'], ['document', 'document'], ['#app', "document.querySelector('#app')"], ['table', "document.querySelector('[data-puzzle-table]')"]]) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
        if (!result.objectId) { out[name] = 'n/a'; continue; }
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
        const byType = {};
        for (const l of listeners) byType[l.type] = (byType[l.type] || 0) + 1;
        out[name] = byType;
    }
    return out;
}

(async () => {
    const { browser, page, cdp } = await L.launch();
    await cdp.send('Performance.enable');
    await L.loadPuzzle(page, 12, 16, 'free');
    const sizes = await page.evaluate(() => {
        const o = {};
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k);
            o[k] = v.length;
            total += k.length + v.length;
        }
        o.__totalChars = total;
        return o;
    });
    console.log('localStorage sizes (UTF-16 code units):', sizes);

    // Serialization timing using the app's own modules on the restored save.
    const ser = await page.evaluate(async () => {
        const storage = await import('/src/persistence/storage.ts');
        const serial = await import('/src/persistence/serialization.ts');
        const outcome = storage.loadSavedGame();
        const state = outcome.state;
        const N = 50;
        let t = performance.now();
        let s = '';
        for (let i = 0; i < N; i++) s = JSON.stringify(serial.serializeProgress(state, [], { scale: 1, offset: { x: 0, y: 0 } }));
        const progMs = (performance.now() - t) / N;
        t = performance.now();
        let g = '';
        for (let i = 0; i < 5; i++) g = JSON.stringify(serial.serializeStatic(state));
        const statMs = (performance.now() - t) / 5;
        t = performance.now();
        for (let i = 0; i < N; i++) localStorage.setItem('__perf_probe', s);
        const setMs = (performance.now() - t) / N;
        localStorage.removeItem('__perf_probe');
        t = performance.now();
        for (let i = 0; i < N; i++) storage.saveProgress(state, [], { scale: 1, offset: { x: 0, y: 0 } });
        const saveProgressMs = (performance.now() - t) / N;
        return { progressChars: s.length, progMs, staticChars: g.length, statMs, setMs, saveProgressMs };
    });
    console.log('serialization (unthrottled, ms per call):', ser);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const ser4 = await page.evaluate(async () => {
        const storage = await import('/src/persistence/storage.ts');
        const outcome = storage.loadSavedGame();
        const N = 20; const t = performance.now();
        for (let i = 0; i < N; i++) storage.saveProgress(outcome.state, [], { scale: 1, offset: { x: 0, y: 0 } });
        const t2 = performance.now();
        for (let i = 0; i < 3; i++) storage.loadSavedGame();
        return { saveProgressMs: (t2 - t) / N, loadSavedGameMs: (performance.now() - t2) / 3 };
    });
    console.log('serialization @4x:', ser4);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    // Listener / leak check across new games.
    const snap = async (label) => {
        await cdp.send('HeapProfiler.collectGarbage');
        const dom = await cdp.send('Memory.getDOMCounters');
        const { metrics } = await cdp.send('Performance.getMetrics');
        const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
        const lc = await listenerCounts(cdp);
        console.log(`[${label}] DOM nodes=${dom.nodes} docs=${dom.documents} jsEventListeners=${dom.jsEventListeners} heap=${(m.JSHeapUsedSize / 1e6).toFixed(1)}MB`);
        console.log('   listeners:', JSON.stringify(lc));
    };
    await snap('after game 1');
    for (let i = 2; i <= 5; i++) {
        const p = L.params(12, 16, i % 2 ? 'free' : 'quarter-turn');
        p.seed = 1000 + i;
        await page.evaluate((pp) => window.__reproPuzzle(pp), p);
        await page.waitForTimeout(1500);
        // interact: tap a piece (rotation focus) and a short drag
        const c = await L.pieceCenter(page, 10);
        await L.touchDrag(cdp, c, { x: c.x + 30, y: c.y + 30 }, 10);
        await page.waitForTimeout(300);
        const c2 = await L.pieceCenter(page, 20);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...c2, id: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(300);
        await snap(`after game ${i}`);
    }
    await page.waitForTimeout(6500);
    await snap('after idle 6.5s');
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
