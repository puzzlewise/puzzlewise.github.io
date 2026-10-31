const fs = require('fs');
const { launch, metrics, heapSnapshot, analyzeSnapshot, sleep, poolImage, BASE } = require('./lib.cjs');

const N = Number(process.env.N || 16);
const GRIDS = [[6, 4], [8, 6], [12, 8], [16, 12]];

(async () => {
    const { browser, page, cdp } = await launch();
    await page.addInitScript({ path: '/tmp/perf-audit/memory/timer-probe.js' });
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(3000);
    const rows = [];
    const m0 = await metrics(page, cdp);
    rows.push({ i: 0, label: 'boot', ...m0 });
    console.log(JSON.stringify(rows[0]));
    await heapSnapshot(cdp, '/tmp/perf-audit/memory/snap-first.heapsnapshot');
    for (let i = 1; i <= N; i++) {
        const [c, r] = GRIDS[i % 4 === 0 ? 3 : (i % 4)];
        const img = poolImage(i);
        const grid = img.portrait ? { cols: Math.min(c, r), rows: Math.max(c, r) } : { cols: Math.max(c, r), rows: Math.min(c, r) };
        const cut = i % 2 ? 'wavy' : 'classic';
        const params = {
            seed: 1000 + i * 7919, cutStyle: cut, imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: grid, rotationMode: i % 3 ? 'free' : 'none',
            ...(cut === 'wavy' ? { wavyConfig: { borderless: false, traceSetVersion: 2 } } : { classicConfig: { traceSetVersion: 2 } }),
        };
        const t0 = Date.now();
        const ok = await page.evaluate((p) => window.__reproPuzzle(p), params);
        const genMs = Date.now() - t0;
        await sleep(2500);
        const m = await metrics(page, cdp);
        const ls = await page.evaluate(() => {
            const o = {}; let total = 0;
            for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k); const v = localStorage.getItem(key); o[key] = v.length; total += key.length + v.length; }
            return { total, keys: o };
        });
        const row = { i, label: `${cut} ${grid.cols}x${grid.rows}`, ok, genMs, ...m, lsChars: ls.total, geomChars: ls.keys['puzzle-game-state'] };
        rows.push(row);
        console.log(JSON.stringify(row));
    }
    const ts = await page.evaluate(() => window.__timerStats());
    console.log('timers', JSON.stringify({ ...ts, liveTimeouts: ts.liveTimeouts.slice(0, 20) }, null, 1));
    await heapSnapshot(cdp, '/tmp/perf-audit/memory/snap-last.heapsnapshot');
    fs.writeFileSync('/tmp/perf-audit/memory/across-games.json', JSON.stringify(rows, null, 1));
    for (const f of ['first', 'last']) {
        const a = analyzeSnapshot(`/tmp/perf-audit/memory/snap-${f}.heapsnapshot`);
        console.log(f, 'detached', a.detached, JSON.stringify([...a.detByName.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12)));
        const top = [...a.byName.entries()].filter(([k]) => /Puzzle|Renderer|Game|Worker|Controller|Router|HTML|SVG|Map|Set|Image|Blob|Promise/.test(k)).sort((x, y) => y[1].count - x[1].count).slice(0, 30);
        console.log(f, JSON.stringify(top.map(([k, v]) => `${k}=${v.count}`)));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
