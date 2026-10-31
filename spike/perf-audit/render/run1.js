const L = require('./lib.js');
const pieces = +(process.argv[2] || 96), outline = process.argv[3] || 'shadow', thr = +(process.argv[4] || 4), cut = process.argv[5] || 'wavy';
const only = (process.argv[6] || 'all').split(',');
const want = (k) => only.includes('all') || only.includes(k);
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(pieces, cut), outline);
    const P = (r) => console.log(L.fmt(r));
    console.log(`=== pieces=${pieces} outline=${outline} cut=${cut} throttle=${thr}`);
    console.log('initial', JSON.stringify(await L.snapNow(page, cdp)), await L.tableScale(page), 'domNodes', await page.evaluate(() => document.getElementsByTagName('*').length));
    const opt = { throttle: thr };
    const bg = await L.findEmpty(page);
    if (want('pan')) {
        if (!bg) console.log('no empty bg'); else P(await L.measure(page, cdp, 'pan(zoomed-out)', async () => { await L.drag(page, bg, 0, -120, 40); await L.drag(page, { x: bg.x, y: bg.y - 120 }, 0, 120, 40); }, opt));
    }
    if (want('drag')) {
        const pc = await L.pieceCenter(page);
        P(await L.measure(page, cdp, 'drag single piece', async () => { await L.drag(page, pc, 60, 80, 60); await page.waitForTimeout(300); }, opt));
    }
    if (want('wheel')) {
        const c = { x: 206, y: 446 };
        P(await L.measure(page, cdp, 'wheel zoom in x8', async () => { await L.wheel(page, c, -50, 8); await page.waitForTimeout(500); }, opt));
        console.log('  after zoom-in', await L.tableScale(page), JSON.stringify(await L.snapNow(page, cdp)));
        const bg2 = await L.findEmpty(page);
        if (bg2) P(await L.measure(page, cdp, 'pan(zoomed-in)', async () => { await L.drag(page, bg2, 0, -120, 40); }, opt));
        else P(await L.measure(page, cdp, 'pan(zoomed-in, via piece-free? none found; 2-finger)', async () => {}, opt));
        P(await L.measure(page, cdp, 'wheel zoom out x8 (+relayer)', async () => { await L.wheel(page, c, 50, 8); await page.waitForTimeout(900); }, opt));
        console.log('  after zoom-out+relayer', await L.tableScale(page), JSON.stringify(await L.snapNow(page, cdp)));
    }
    if (want('pinch')) {
        const c = { x: 206, y: 446 };
        P(await L.measure(page, cdp, 'pinch in', async () => { await L.pinch(cdp, page, c, 80, 300, 30); await page.waitForTimeout(400); }, opt));
        console.log('  after pinch-in', await L.tableScale(page), JSON.stringify(await L.snapNow(page, cdp)));
        P(await L.measure(page, cdp, 'pinch out (+relayer)', async () => { await L.pinch(cdp, page, c, 300, 80, 30); await page.waitForTimeout(900); }, opt));
        console.log('  after pinch-out', await L.tableScale(page), JSON.stringify(await L.snapNow(page, cdp)));
    }
    if (want('rotate')) {
        const pc = await L.pieceCenter(page);
        await page.mouse.click(pc.x, pc.y);
        await page.waitForTimeout(400);
        const has = await page.$('.rotate-button--cw');
        if (has) P(await L.measure(page, cdp, 'rotate button x4', async () => { for (let i = 0; i < 4; i++) { await page.click('.rotate-button--cw', { force: true }); await page.waitForTimeout(150); } }, opt));
        else console.log('no rotate button');
        await page.waitForTimeout(300);
        await page.mouse.click(pc.x, pc.y);
        await page.waitForTimeout(400);
        const h = await page.$('.rotate-handle');
        if (h) {
            const bb = await h.boundingBox();
            if (bb) P(await L.measure(page, cdp, 'rotate handle drag', async () => {
                const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
                await page.mouse.move(cx, cy); await page.mouse.down();
                for (let i = 1; i <= 40; i++) { const a = i / 40 * Math.PI; await page.mouse.move(pc.x + (cx - pc.x) * Math.cos(a) - (cy - pc.y) * Math.sin(a), pc.y + (cx - pc.x) * Math.sin(a) + (cy - pc.y) * Math.cos(a)); await page.waitForTimeout(16); }
                await page.mouse.up(); await page.waitForTimeout(300);
            }, opt));
        } else console.log('no rotate handle');
    }
    if (want('gather')) {
        P(await L.measure(page, cdp, 'gather pieces', async () => { await page.click('.gather-pieces-button'); await page.waitForTimeout(1200); }, opt));
        console.log('  after gather', await L.tableScale(page), JSON.stringify(await L.snapNow(page, cdp)));
    }
    if (want('solve')) {
        P(await L.measure(page, cdp, 'solve (+completion zoom/glow)', async () => { await page.evaluate(() => window.__solvePuzzle()); await page.waitForTimeout(2500); }, opt));
        console.log('  after solve', await L.tableScale(page), JSON.stringify(await L.snapNow(page, cdp)));
        P(await L.measure(page, cdp, 'idle w/ completion overlay 1s', async () => { await page.waitForTimeout(1000); }, opt));
        await page.mouse.click(10, 880); await page.waitForTimeout(1500);
        const pc = await L.pieceCenter(page);
        P(await L.measure(page, cdp, 'drag solved group (all pieces)', async () => { await L.drag(page, pc, 40, 60, 60); await page.waitForTimeout(300); }, opt));
        P(await L.measure(page, cdp, 'spin proxy: rotate solved group 90deg + table zoom transition', async () => {
            await page.evaluate(() => {
                const g = document.querySelector('[data-group-id]'); const t = document.querySelector('[data-puzzle-table]');
                const tr = 'transform 0.8s ease-in-out';
                g.style.transition = tr; t.style.transition = tr;
                g.style.transform = g.style.transform.replace(/rotate\([^)]*\)/, 'rotate(90deg)');
                t.style.transform = t.style.transform.replace(/scale\(([^)]*)\)/, (m, s) => `scale(${s * 0.8})`);
            });
            await page.waitForTimeout(1200);
        }, opt));
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
