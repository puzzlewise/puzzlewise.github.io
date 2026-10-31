// usage: node ab.js pieces throttle scenario variant1 variant2 ...
// variant: outline:<id> | css:<name>
const L = require('./lib.js');
const [pieces, thr, scenario, ...variants] = [+process.argv[2], +process.argv[3], process.argv[4], ...process.argv.slice(5)];
const CSS = {
    base: '',
    nobackdrop: '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
    nowillchange: '[data-group-id] { will-change: auto !important; }',
    tablewc: '[data-puzzle-table] { will-change: transform; }',
    nofilter: '[data-group-id] { filter: none !important; }',
    dragwc: "[data-group-id].dragging { will-change: transform !important; }",
    norelayer: '[data-puzzle-table].relayer [data-group-id] { will-change: transform !important; }',
};
const cut = process.env.CUT || 'wavy';
(async () => {
    for (const v of variants) {
        const [kind, name] = v.split(':');
        const { browser, page, cdp } = await L.launch();
        await L.boot(page, L.params(pieces, cut, process.env.ROT ? { rotationMode: process.env.ROT } : {}), kind === 'outline' ? name : undefined);
        for (const part of (kind === 'css' ? name.split('+') : [])) if (CSS[part]) await page.addStyleTag({ content: CSS[part] });
        await page.waitForTimeout(500);
        const opt = { throttle: thr };
        const c = { x: 206, y: 446 };
        let r;
        if (scenario === 'idle') r = await L.measure(page, cdp, `${v} idle`, async () => { await page.waitForTimeout(1500); }, opt);
        if (scenario === 'drag') { const pc = await L.pieceCenter(page); r = await L.measure(page, cdp, `${v} drag piece`, async () => { await L.drag(page, pc, 60, 80, 60); await page.waitForTimeout(300); }, opt); }
        if (scenario === 'pan') { const bg = await L.findEmpty(page); r = await L.measure(page, cdp, `${v} pan zoomed-out @${JSON.stringify(bg)}`, async () => { await L.drag(page, bg, 0, -120, 40); await L.drag(page, { x: bg.x, y: bg.y - 120 }, 0, 120, 40); }, opt); }
        if (scenario === 'panin') { await L.wheel(page, c, -50, 8); await page.waitForTimeout(1000); const bg = await L.findEmpty(page); r = await L.measure(page, cdp, `${v} pan zoomed-in @${JSON.stringify(bg)}`, async () => { await L.drag(page, bg, 0, -120, 40); await L.drag(page, { x: bg.x, y: bg.y - 120 }, 0, 120, 40); }, opt); }
        if (scenario === 'wheel') r = await L.measure(page, cdp, `${v} wheel in8/out8`, async () => { await L.wheel(page, c, -50, 8); await page.waitForTimeout(300); await L.wheel(page, c, 50, 8); await page.waitForTimeout(1000); }, opt);
        if (scenario === 'relayer') { await L.wheel(page, c, -50, 8); await page.waitForTimeout(800); await L.wheel(page, c, 50, 8); r = await L.measure(page, cdp, `${v} window covering relayer after zoom-out`, async () => { await page.waitForTimeout(1200); }, opt); }
        if (scenario === 'smallzoomin') { console.log('  before', JSON.stringify(await L.snapNow(page, cdp)), await L.tableScale(page)); await L.wheel(page, c, -20, 3); await page.waitForTimeout(1200); console.log('  after small zoom-in', JSON.stringify(await L.snapNow(page, cdp)), await L.tableScale(page)); await browser.close(); continue; }
        console.log(L.fmt(r));
        await browser.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
