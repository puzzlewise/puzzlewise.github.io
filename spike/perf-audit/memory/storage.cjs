const fs = require('fs');
const { launch, sleep, poolImage, BASE } = require('./lib.cjs');

(async () => {
    const { browser, page, cdp } = await launch();
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    const img = poolImage(3);
    const configs = [
        ['wavy', { wavyConfig: { borderless: false, traceSetVersion: 2 } }],
        ['wavy-borderless', { wavyConfig: { borderless: true, traceSetVersion: 2 } }],
        ['classic', { classicConfig: { traceSetVersion: 2 } }],
        ['triangles', { trianglesConfig: { traceSetVersion: 2 } }],
        ['fractal', { fractalConfig: { borderless: false } }],
    ];
    for (const [name, extra] of configs) {
        const cut = name.split('-')[0];
        const params = { seed: 424242, cutStyle: cut, imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: img.portrait ? { cols: 12, rows: 16 } : { cols: 16, rows: 12 }, rotationMode: 'free', ...extra };
        const ok = await page.evaluate((p) => window.__reproPuzzle(p), params);
        await sleep(1000);
        const r = await page.evaluate(() => {
            const raw = localStorage.getItem('puzzle-game-state');
            const prog = localStorage.getItem('puzzle-progress');
            const o = JSON.parse(raw);
            const pieces = o.pieces || [];
            let edgeChars = 0, edgePathChars = 0, nEdges = 0, mated = 0, shapeChars = 0, boundsChars = 0, other = 0;
            const sample = pieces[0] ? Object.keys(pieces[0]) : [];
            const edgeKeys = pieces[0]?.edges?.[0] ? Object.keys(pieces[0].edges[0]) : [];
            for (const p of pieces) {
                for (const e of p.edges) { nEdges++; const s = JSON.stringify(e).length; edgeChars += s; edgePathChars += (e.path || '').length; if (e.mateEdgeId !== -1 && e.mateEdgeId !== undefined) mated++; }
                if (p.shape) shapeChars += p.shape.length;
            }
            const piecesChars = JSON.stringify(pieces).length;
            const t0 = performance.now(); const json = JSON.stringify(o); const t1 = performance.now();
            localStorage.setItem('__perf_probe', json); const t2 = performance.now();
            const back = localStorage.getItem('__perf_probe'); JSON.parse(back); const t3 = performance.now();
            localStorage.removeItem('__perf_probe');
            const pathSample = pieces[1]?.edges?.[1]?.path?.slice(0, 160);
            return { pieces: pieces.length, total: raw.length, progress: prog.length, piecesChars, edgeChars, edgePathChars, nEdges, mated, shapeChars, sample, edgeKeys, topKeys: Object.keys(o), pathSample,
                stringifyMs: +(t1 - t0).toFixed(1), setItemMs: +(t2 - t1).toFixed(1), getParseMs: +(t3 - t2).toFixed(1) };
        });
        console.log(name, ok, JSON.stringify(r));
    }
    const all = await page.evaluate(() => { const o = {}; for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k); o[key] = localStorage.getItem(key).length; } return o; });
    console.log('localStorage keys (chars):', JSON.stringify(all, null, 1));
    const q = await cdp.send('Storage.getUsageAndQuota', { origin: new URL(BASE).origin });
    console.log('usageAndQuota', JSON.stringify(q));
    // localStorage quota probe in chars
    const quota = await page.evaluate(() => {
        let used = 0; for (let k = 0; k < localStorage.length; k++) { const key = localStorage.key(k); used += key.length + localStorage.getItem(key).length; }
        let lo = 0, hi = 20 * 1024 * 1024;
        while (hi - lo > 1024) { const mid = (lo + hi) >> 1; try { localStorage.setItem('__q', 'a'.repeat(mid)); lo = mid; } catch { hi = mid; } }
        localStorage.removeItem('__q');
        let lo2 = 0, hi2 = 20 * 1024 * 1024;
        while (hi2 - lo2 > 1024) { const mid = (lo2 + hi2) >> 1; try { localStorage.setItem('__q', '一'.repeat(mid)); lo2 = mid; } catch { hi2 = mid; } }
        localStorage.removeItem('__q');
        return { usedChars: used, extraAsciiChars: lo, extraNonLatinChars: lo2 };
    });
    console.log('ls quota probe', JSON.stringify(quota));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
