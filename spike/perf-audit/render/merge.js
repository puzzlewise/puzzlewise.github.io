const L = require('./lib.js');
const pieces = +(process.argv[2] || 96), outline = process.argv[3] || 'shadow';
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.boot(page, L.params(pieces, 'wavy', { rotationMode: 'none' }), outline);
    const info = () => page.evaluate(() => {
        const t = document.querySelector('[data-puzzle-table]');
        const sc = +/scale\(([^)]*)\)/.exec(t.style.transform)[1];
        const out = {};
        for (const svg of document.querySelectorAll('svg[data-piece-id]')) {
            const g = svg.parentElement; const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(g.style.transform);
            const img = svg.querySelector('image');
            out[svg.dataset.pieceId] = { gid: g.dataset.groupId, px: +m[1] + parseFloat(svg.style.left) + 30, py: +m[2] + parseFloat(svg.style.top) + 30, ix: +img.getAttribute('x'), iy: +img.getAttribute('y') };
        }
        return { sc, out, groups: document.querySelectorAll('[data-group-id]').length };
    });
    let st = await info();
    const P = (r) => console.log(L.fmt(r));
    let merges = 0;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) {
        st = await info();
        const A = st.out[a], B = st.out[b];
        const dxw = (A.px - A.ix * -1 * 0 + 0) ; // placeholder
        // world target for B origin: A.origin + (B.solvedOffset - A.solvedOffset) where solvedOffset = -imageOffset
        const tx = A.px + (-B.ix) - (-A.ix), ty = A.py + (-B.iy) - (-A.iy);
        const dx = (tx - B.px) * st.sc, dy = (ty - B.py) * st.sc;
        const pc = await L.pieceCenter(page, b);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        const r = await L.measure(page, cdp, `merge ${b}->${a}`, async () => { await L.drag(page, pc, dx, dy, 30); await page.waitForTimeout(700); }, { throttle: 4 });
        const after = await info();
        console.log(`groups ${st.groups} -> ${after.groups}`);
        P(r);
    }
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
