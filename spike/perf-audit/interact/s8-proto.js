// Prototype fixes in-page (monkeypatch) to estimate expected gains. No repo edits.
const L = require('./lib.js');
const S = require('./scenarios.js');
const T = require('./trace-lib.js');

const RATE = Number(process.env.RATE || 4);

async function patch(page, { zIndex, dirty }) {
    await page.evaluate(async ({ zIndex, dirty }) => {
        const mod = await import('/src/renderer/svg-dom-renderer.ts');
        const P = mod.SvgDomRenderer.prototype;
        if (zIndex) {
            let z = 0;
            P.bringGroupToFront = function (id) {
                const el = this.groupElements.get(id);
                if (el) el.style.zIndex = String(++z);
                window.__perf && window.__perf.bring++;
            };
        }
        if (dirty) {
            const inner = P.renderState; // already instrumented wrapper → calls original
            P.renderState = function (s) {
                const t = performance.now();
                const memo = this.__memo || (this.__memo = new Map());
                let structural = s.groups.length !== memo.size || s.pieces.length !== this.currentPieceCount || s.imageUrl !== this.currentImageUrl;
                if (!structural) {
                    for (const g of s.groups) {
                        const m = memo.get(g.id);
                        if (!m || m.size !== g.pieces.size) { structural = true; break; }
                    }
                }
                if (structural) {
                    inner.call(this, s);
                    memo.clear();
                    for (const g of s.groups) memo.set(g.id, { pos: g.position, rot: g.rotation, size: g.pieces.size });
                    return;
                }
                for (const g of s.groups) {
                    const m = memo.get(g.id);
                    if (m.pos === g.position && m.rot === g.rotation) continue;
                    mod.applyGroupTransform(this.groupElements.get(g.id), g.position, g.rotation);
                    m.pos = g.position; m.rot = g.rotation;
                }
                window.__perf.render.push(performance.now() - t);
            };
        }
    }, { zIndex, dirty });
}

async function run(label, opts) {
    const { browser, page, cdp } = await L.launch();
    await L.loadPuzzle(page, 12, 16, 'free');
    const { st, pr } = await S.readSave(page);
    const prog = S.buildProgress(st, pr, {
        singlesOverride: (i) => ({ x: (i % 12) * 130, y: Math.floor(i / 12) * 160 }),
        selection: (groups) => groups.slice(0, 100).map((gr) => gr.id),
    });
    await S.installProgress(page, prog);
    await L.instrument(page);
    await patch(page, opts);
    const results = {};
    for (const [name, gi] of [['multi100', 5], ['single', 150]]) {
        const c = await L.pieceCenter(page, prog.groups[gi].pieces[0][0]);
        await L.resetPerf(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
        const ev = await T.withTrace(browser, page, async () => {
            await L.touchDrag(cdp, c, { x: c.x + 40, y: c.y + 60 }, 60);
            await L.sleep(600);
        });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        const perf = await page.evaluate(() => window.__perf);
        const s = T.summarize(ev);
        const moves = perf.events.filter((e) => e.type === 'pointermove').map((e) => e.ms);
        // drag-start frame: largest RunTask excluding the first 200ms (trace-start artifact)
        const main = ev.find((e) => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
        const tasks = ev.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && e.name === 'RunTask').sort((a, b) => a.ts - b.ts);
        const t0 = tasks[0].ts;
        const late = tasks.filter((t) => t.ts - t0 > 300000).map((t) => t.dur / 1000).sort((a, b) => b - a);
        results[name] = {
            moveMean: L.stats(moves).mean, moveP95: L.stats(moves).p95, renderMean: L.stats(perf.render).mean,
            pointerup: perf.events.filter((e) => e.type === 'pointerup').map((e) => +e.ms.toFixed(1)),
            worstTasks: late.slice(0, 3).map((x) => +x.toFixed(1)), styleElems: s.elementCount, gc: s.GC,
        };
        // Reselect state: page reload to keep scenarios independent
        await S.installProgress(page, prog);
        await L.instrument(page);
        await patch(page, opts);
    }
    console.log(label, JSON.stringify(results, null, 1));
    await browser.close();
}

(async () => {
    await run(`BASELINE @${RATE}x`, {});
    if (process.env.ONLYBASE) return;
    await run(`zIndex bringToFront @${RATE}x`, { zIndex: true });
    await run(`dirty-only renderState @${RATE}x`, { dirty: true });
    await run(`both @${RATE}x`, { zIndex: true, dirty: true });
})().catch((e) => { console.error(e); process.exit(1); });
