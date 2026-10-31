const L = require('./lib.js');
(async () => {
    for (const cut of ['classic', 'wavy', 'fractal', 'triangles']) {
        const { browser, page, cdp } = await L.launch();
        try {
            const extra = cut === 'triangles' ? {} : {};
            await L.boot(page, L.params(192, cut, extra));
            const d = await page.evaluate(() => {
                const svgs = [...document.querySelectorAll('svg[data-piece-id]')];
                const t = document.querySelector('[data-puzzle-table]');
                const hit = svgs.map((s) => s.querySelector('[data-hit-area]').getAttribute('d').length);
                const mateless = document.querySelectorAll('[data-mateless-edge]').length;
                return { pieces: svgs.length, groups: document.querySelectorAll('[data-group-id]').length, tableNodes: t.getElementsByTagName('*').length, perPiece: +(t.getElementsByTagName('*').length / svgs.length).toFixed(1), mateless, avgPathChars: Math.round(hit.reduce((a, b) => a + b, 0) / hit.length), maxPathChars: Math.max(...hit), totalDChars: [...t.querySelectorAll('path')].reduce((a, p) => a + (p.getAttribute('d') || '').length, 0) };
            });
            const pc = await L.pieceCenter(page);
            const r = await L.measure(page, cdp, `${cut} drag`, async () => { await L.drag(page, pc, 60, 80, 40); }, { throttle: 4 });
            const s = r.stages; const f = (k) => s[k] ? (s[k].ms / s[k].n).toFixed(2) : '-';
            console.log(cut, JSON.stringify(d), 'BMF/f', f('CrRendererMain:ProxyMain::BeginMainFrame'), 'paint/ev', f('CrRendererMain:Paint'), 'gpuWait-ish swap', s['CrGpuMain:SwapBuffers'] ? (s['CrGpuMain:SwapBuffers'].ms / s['VizCompositorThread:DrawFrame'].n).toFixed(1) : '-', 'tileMB', r.lastSnap && r.lastSnap.tileMB);
        } catch (e) { console.log(cut, 'ERR', e.message.slice(0, 200)); }
        await browser.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
