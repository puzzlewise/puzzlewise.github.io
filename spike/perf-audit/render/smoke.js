const L = require('./lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 200)); });
    await L.boot(page, L.params(+(process.argv[2] || 96)));
    const info = await page.evaluate(() => ({
        groups: document.querySelectorAll('[data-group-id]').length,
        pieces: document.querySelectorAll('svg[data-piece-id]').length,
        nodes: document.getElementsByTagName('*').length,
        svgNodes: document.querySelector('[data-puzzle-table]').getElementsByTagName('*').length,
        table: document.querySelector('[data-puzzle-table]').style.transform,
        gpu: (() => { const c = document.createElement('canvas').getContext('webgl'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })(),
        outline: getComputedStyle(document.documentElement).getPropertyValue('--piece-edge-filter'),
        imgDecoding: document.querySelector('[data-piece-id] image').getAttribute('decoding'),
    }));
    console.log(info);
    console.log(JSON.stringify(await L.layers(cdp)).slice(0, 600));
    await page.screenshot({ path: '/tmp/perf-audit/render/smoke.png' });
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
