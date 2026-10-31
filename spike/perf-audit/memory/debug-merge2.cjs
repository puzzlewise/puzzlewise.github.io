const { launch, sleep, poolImage, BASE } = require('./lib.cjs');
const src = require('fs').readFileSync('/tmp/perf-audit/memory/within-game.cjs','utf8');
eval(src.slice(src.indexOf('async function planMerge'), src.indexOf('(async () =>')));
(async () => {
    const { browser, page } = await launch();
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    const img = poolImage(5);
    await page.evaluate((p) => window.__reproPuzzle(p), { seed: 777, cutStyle: 'wavy', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: { cols: 16, rows: 12 }, rotationMode: 'none', wavyConfig: { borderless: false, traceSetVersion: 2 } });
    await sleep(1500);
    for (let k=0;k<6;k++){
    const plan = await planMerge(page);
    console.log(plan);
    await page.mouse.move(plan.x, plan.y); await page.mouse.down();
    for (let s = 1; s <= 8; s++) await page.mouse.move(plan.x + plan.dx * s / 8, plan.y + plan.dy * s / 8);
    await page.mouse.up();
    await sleep(300);
    console.log('groups after', await page.evaluate(() => document.querySelectorAll('[data-group-id]').length));
    }
    await browser.close();
})();
