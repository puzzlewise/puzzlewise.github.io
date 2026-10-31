const { launch, sleep, poolImage, BASE } = require('./lib.cjs');
(async () => {
    const { browser, page } = await launch();
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    const img = poolImage(5);
    await page.evaluate((p) => window.__reproPuzzle(p), { seed: 777, cutStyle: 'wavy', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: { cols: 6, rows: 4 }, rotationMode: 'none', wavyConfig: { borderless: false, traceSetVersion: 2 } });
    await sleep(1500);
    const snap = () => page.evaluate(() => {
        const table = document.querySelector('[data-puzzle-table]');
        return { t: table.style.transform, g: [...table.querySelectorAll('[data-group-id]')].slice(0, 3).map((g) => g.style.transform + ' ' + [...g.children].map((s) => s.dataset.pieceId + '@' + s.style.left + ',' + s.style.top + ' img ' + s.querySelector('image').getAttribute('x') + ',' + s.querySelector('image').getAttribute('y')).join('|')) };
    });
    console.log(JSON.stringify(snap ? await snap() : null, null, 1));
    const box = await page.evaluate(() => { const r = document.querySelector('svg[data-piece-id="0"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    console.log(box);
    const x = box.x + box.w / 2, y = box.y + box.h / 2;
    const el = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e.tagName + ' ' + e.closest('svg[data-piece-id]')?.dataset.pieceId; }, [x, y]);
    console.log('hit', el);
    await page.mouse.move(x, y); await page.mouse.down();
    for (let s = 1; s <= 8; s++) await page.mouse.move(x + 100 * s / 8, y + 50 * s / 8);
    await page.mouse.up();
    await sleep(200);
    console.log(JSON.stringify(await snap(), null, 1));
    await browser.close();
})();
