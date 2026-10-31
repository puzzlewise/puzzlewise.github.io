const fs = require('fs');
const { launch, metrics, heapSnapshot, analyzeSnapshot, sleep, poolImage, BASE } = require('./lib.cjs');

const DRAGS = Number(process.env.DRAGS || 200);

async function planMerge(page) {
    return page.evaluate(() => {
        const table = document.querySelector('[data-puzzle-table]');
        const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(table.style.transform);
        const scale = m ? Number(m[3]) : 1;
        const groups = [...table.querySelectorAll('[data-group-id]')];
        const info = [];
        for (const g of groups) {
            const gm = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(g.style.transform);
            const gx = Number(gm[1]), gy = Number(gm[2]);
            for (const svg of g.querySelectorAll('svg[data-piece-id]')) {
                const img = svg.querySelector('image');
                info.push({ id: Number(svg.dataset.pieceId), gid: g.dataset.groupId, wx: gx + parseFloat(svg.style.left) + 30, wy: gy + parseFloat(svg.style.top) + 30,
                    ix: Number(img.getAttribute('x')), iy: Number(img.getAttribute('y')), size: g.children.length });
            }
        }
        if (groups.length <= 1) return null;
        // prefer moving small groups
        const order = info.slice().sort(() => Math.random() - 0.5).sort((a, b) => a.size - b.size);
        const W = innerWidth, H = innerHeight;
        for (const B of order.slice(0, 60)) {
        let A = null, best = Infinity;
        for (const p of info) { if (p.gid === B.gid) continue; const d = Math.hypot(p.ix - B.ix, p.iy - B.iy); if (d < best) { best = d; A = p; } }
        if (!A) continue;
        const tx = A.wx + (A.ix - B.ix) - B.wx, ty = A.wy + (A.iy - B.iy) - B.wy;
        const svg = table.querySelector(`svg[data-piece-id="${B.id}"]`);
        const r = svg.getBoundingClientRect();
        for (let fy = 0.3; fy <= 0.7; fy += 0.1) for (let fx = 0.3; fx <= 0.7; fx += 0.1) {
            const x = r.left + r.width * fx, y = r.top + r.height * fy;
            const ex = x + tx * scale, ey = y + ty * scale;
            if (ex < 90 || ey < 90 || ex > W - 110 || ey > H - 90 || x < 90 || y < 90 || x > W - 90 || y > H - 90) continue;
            const el = document.elementFromPoint(x, y);
            const hit = el?.closest?.('svg[data-piece-id]');
            if (hit && Number(hit.dataset.pieceId) === B.id) return { x, y, dx: tx * scale, dy: ty * scale, groups: groups.length };
        }
        }
        return { skip: true, groups: groups.length };
    });
}

(async () => {
    const { browser, page, cdp } = await launch();
    await page.addInitScript({ path: '/tmp/perf-audit/memory/timer-probe.js' });
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    const img = poolImage(5);
    const params = { seed: 777, cutStyle: 'wavy', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: img.portrait ? { cols: 12, rows: 16 } : { cols: 16, rows: 12 }, rotationMode: 'none', wavyConfig: { borderless: false, traceSetVersion: 2 } };
    await page.evaluate((p) => window.__reproPuzzle(p), params);
    await sleep(2500);
    const log = [];
    const m0 = await metrics(page, cdp); log.push({ step: 'start', ...m0 }); console.log(JSON.stringify(log.at(-1)));
    await heapSnapshot(cdp, '/tmp/perf-audit/memory/wg-start.heapsnapshot');
    let merges = 0, skips = 0;
    for (let i = 1; i <= DRAGS; i++) {
        const plan = await planMerge(page);
        if (!plan) break;
        if (plan.skip) { skips++; continue; }
        await page.mouse.move(plan.x, plan.y);
        await page.mouse.down();
        const steps = 8;
        await page.mouse.move(plan.x + 12, plan.y); for (let s = 1; s <= steps; s++) await page.mouse.move(plan.x + 12 + plan.dx * s / steps, plan.y + plan.dy * s / steps);
        await page.mouse.up();
        await sleep(30);
        const after = await page.evaluate(() => document.querySelectorAll('[data-group-id]').length);
        if (after < plan.groups) merges++;
        if (i % 10 === 0) {
            // zoom cycle
            for (let z = 0; z < 6; z++) { await page.mouse.move(590, 410); await page.mouse.wheel(0, z < 3 ? -300 : 300); await sleep(40); }
            await sleep(300);
        }
        if (i % 40 === 0) {
            const m = await metrics(page, cdp); log.push({ step: `drag${i}`, merges, skips, groups: after, ...m }); console.log(JSON.stringify(log.at(-1)));
        }
    }
    const mEnd = await metrics(page, cdp); log.push({ step: 'after-drags', merges, skips, ...mEnd }); console.log(JSON.stringify(log.at(-1)));
    await heapSnapshot(cdp, '/tmp/perf-audit/memory/wg-end.heapsnapshot');
    await page.evaluate(() => window.__solvePuzzle());
    await sleep(4000);
    const mS = await metrics(page, cdp); log.push({ step: 'solved', ...mS }); console.log(JSON.stringify(log.at(-1)));
    const ts = await page.evaluate(() => window.__timerStats());
    console.log('timers', JSON.stringify({ timeoutsSet: ts.timeoutsSet, rafSet: ts.rafSet, live: ts.liveTimeouts, rafTop: ts.rafTop, timeoutTop: ts.timeoutTop }));
    for (const f of ['wg-start', 'wg-end']) {
        const a = analyzeSnapshot(`/tmp/perf-audit/memory/${f}.heapsnapshot`);
        console.log(f, 'detached', a.detached, JSON.stringify([...a.detByName.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)));
    }
    fs.writeFileSync('/tmp/perf-audit/memory/within-game.json', JSON.stringify(log, null, 1));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
