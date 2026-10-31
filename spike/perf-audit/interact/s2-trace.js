const L = require('./lib.js');
const T = require('./trace-lib.js');
const fs = require('fs');

const RATE = Number(process.env.RATE || 4);

(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.loadPuzzle(page, 12, 16, 'free');
    await L.instrument(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
    const out = {};

    // Single piece drag
    let c = await L.pieceCenter(page, 50);
    let ev = await T.withTrace(browser, page, async () => {
        await L.touchDrag(cdp, c, { x: 206, y: 300 }, 60);
        await L.sleep(300);
    });
    fs.writeFileSync('/tmp/perf-audit/interact/trace-drag.json', JSON.stringify({ traceEvents: ev }));
    out.drag = T.summarize(ev);

    // Pan (start on empty background: top-left corner area)
    const bg = await page.evaluate(() => {
        for (let y = 120; y < 800; y += 10) for (let x = 10; x < 400; x += 10) {
            const el = document.elementFromPoint(x, y);
            if (el && (el.id === 'app' || (el.dataset && el.dataset.puzzleTable === 'true'))) {
                // ensure probe ring is empty too
                let ok = true;
                for (let d = -10; d <= 10 && ok; d += 5) for (let e = -10; e <= 10; e += 5) {
                    const h = document.elementFromPoint(x + d, y + e);
                    if (h && h.closest && h.closest('svg[data-piece-id]')) { ok = false; break; }
                }
                if (ok) return { x, y };
            }
        }
        return null;
    });
    console.log('bg point', bg);
    ev = await T.withTrace(browser, page, async () => {
        await L.touchDrag(cdp, bg, { x: bg.x + 100, y: bg.y + 150 }, 60);
        await L.sleep(300);
    });
    out.pan = T.summarize(ev);

    // Pinch
    ev = await T.withTrace(browser, page, async () => {
        await L.pinch(cdp, { x: 206, y: 446 }, 100, 300, 60);
        await L.sleep(300);
    });
    out.pinch = T.summarize(ev);

    console.log(JSON.stringify(out, null, 2));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
