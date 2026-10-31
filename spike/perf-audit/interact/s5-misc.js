const L = require('./lib.js');
const S = require('./scenarios.js');
const T = require('./trace-lib.js');
const P = require('./prof-lib.js');
const fs = require('fs');

const RATE = Number(process.env.RATE || 4);

async function measure(name, browser, page, cdp, fn) {
    await L.resetPerf(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
    let prof;
    const ev = await T.withTrace(browser, page, async () => {
        prof = await P.withProfile(cdp, fn, 100);
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    fs.writeFileSync(`/tmp/perf-audit/interact/trace-${name.split(':')[0]}.json`, JSON.stringify({ traceEvents: ev }));
    const perf = await page.evaluate(() => window.__perf);
    const s = T.summarize(ev);
    const a = P.analyze(prof, 18);
    console.log(`\n##### ${name} (rate ${RATE}x)`);
    for (const t of ['pointermove', 'pointerdown', 'pointerup', 'wheel']) {
        const arr = perf.events.filter((e) => e.type === t).map((e) => e.ms);
        if (arr.length) console.log(`${t} handler (in-page)`, L.stats(arr));
    }
    console.log('renderState', L.stats(perf.render), 'flash', perf.flash.map((x) => x.toFixed(1)), 'bring', perf.bring);
    console.log('setItem', perf.setItem.map((x) => `${x.k}:${x.len}B/${x.ms.toFixed(1)}ms`));
    for (const k of Object.keys(s)) if (/EventDispatch (pointer(move|up|down)|wheel)|UpdateLayoutTree|elementCount|^Layout$|Layerize|Commit|GC|longTasks|forced|mainBusy/.test(k)) console.log(`  ${k}: ${JSON.stringify(s[k])}`);
    console.log('--- profile total (top) ---\n' + a.total.split('\n').filter((l) => !/\(root\)|\(idle\)|\(program\)/.test(l)).slice(0, 14).join('\n'));
}

(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.loadPuzzle(page, 12, 16, 'free');
    const { st, pr } = await S.readSave(page);
    const g = S.gridOf(st);
    const ids = st.pieces.map((p) => p.id);
    const scen = process.env.SCEN || 'DMWRH';

    if (scen.includes('D')) {
        const bigIds = ids.filter((id) => g.map.get(id).row <= 13);
        const extra = ids.find((id) => g.map.get(id).row === 14 && g.map.get(id).col === 5);
        const prog = S.buildProgress(st, pr, {
            bigIds,
            singlesOverride: (i, id) => (id === extra ? { x: 1250, y: 700 } : { x: 1150 + (i % 3) * 150, y: 1000 + Math.floor(i / 3) * 200 }),
        });
        await S.installProgress(page, prog);
        await L.instrument(page);
        const cur = await S.pieceOriginScreen(page, extra);
        const im = g.map.get(extra).imageOffset;
        const delta = { x: 10 + cur.scale * (-im.x) - cur.x, y: 120 + cur.scale * (-im.y) - cur.y };
        const c = await L.pieceCenter(page, extra);
        await measure('D: drop single onto 168-group (merge, no win)', browser, page, cdp, async () => {
            await S.preciseDrag(cdp, c, delta, 40);
            await L.sleep(1000);
        });
        console.log('groups after:', await page.evaluate(() => document.querySelectorAll('[data-group-id]').length));
    }

    // Fresh-ish layout: 192 singles in a grid, for marquee / wheel / rotate / probe.
    const prog = S.buildProgress(st, pr, {
        singlesOverride: (i) => ({ x: (i % 12) * 130, y: Math.floor(i / 12) * 160 }),
    });
    await S.installProgress(page, prog);
    await L.instrument(page);

    if (scen.includes('M')) {
        for (const round of [1, 2]) {
            await measure(`M${round}: marquee drag (shift) over most pieces, round ${round}`, browser, page, cdp, async () => {
                const from = { x: 3, y: 112 }, to = { x: 405, y: 500 + round * 50 };
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', modifiers: 8, touchPoints: [{ ...from, id: 1 }] });
                await L.sleep(16);
                for (let i = 1; i <= 40; i++) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', modifiers: 8, touchPoints: [{ x: from.x + (to.x - from.x) * i / 40, y: from.y + (to.y - from.y) * i / 40, id: 1 }] });
                    await L.sleep(16);
                }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', modifiers: 8, touchPoints: [] });
                await L.sleep(800);
            });
            console.log('selected count:', await page.evaluate(() => document.querySelectorAll('[data-group-id].selected').length));
        }
        // clear selection by reinstalling
        await S.installProgress(page, prog);
        await L.instrument(page);
    }

    if (scen.includes('W')) {
        await measure('W: wheel zoom 40 ticks', browser, page, cdp, async () => {
            for (let i = 0; i < 40; i++) {
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: i < 20 ? -40 : 40 });
                await L.sleep(16);
            }
            await L.sleep(500);
        });
    }

    if (scen.includes('H')) {
        // Background pointerdown with hit probe: find a gap point between pieces
        const bg = await page.evaluate(() => {
            for (let y = 130; y < 600; y += 3) for (let x = 15; x < 400; x += 3) {
                const el = document.elementFromPoint(x, y);
                if (el && el.dataset && el.dataset.puzzleTable === 'true') return { x, y };
            }
            return null;
        });
        console.log('gap point', bg);
        await measure('H: background tap (hit-probe, 24 elementFromPoint)', browser, page, cdp, async () => {
            for (let i = 0; i < 5; i++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...bg, id: 1 }] });
                await L.sleep(30);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await L.sleep(100);
            }
        });
    }

    if (scen.includes('R')) {
        const pid = prog.groups[40].pieces[0][0];
        const c = await L.pieceCenter(page, pid);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...c, id: 1 }] });
        await L.sleep(30);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await L.sleep(500);
        const h = await page.evaluate(() => {
            const b = document.querySelector('.rotate-handle');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        console.log('handle', h, 'piece', c);
        if (h) {
            await measure('R: rotate-handle drag 60 moves', browser, page, cdp, async () => {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...h, id: 1 }] });
                await L.sleep(16);
                const r = Math.hypot(h.x - c.x, h.y - c.y);
                const a0 = Math.atan2(h.y - c.y, h.x - c.x);
                for (let i = 1; i <= 60; i++) {
                    const a = a0 + (i / 60) * Math.PI;
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), id: 1 }] });
                    await L.sleep(16);
                }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await L.sleep(800);
            });
        }
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
