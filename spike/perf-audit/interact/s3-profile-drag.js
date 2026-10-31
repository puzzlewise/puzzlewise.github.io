const L = require('./lib.js');
const P = require('./prof-lib.js');

const RATE = Number(process.env.RATE || 4);
const INSTR = process.env.INSTR === '1';

(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.loadPuzzle(page, 12, 16, process.env.ROT || 'free');
    if (INSTR) await L.instrument(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
    const c = await L.pieceCenter(page, 50);
    const prof = await P.withProfile(cdp, async () => {
        await L.touchDrag(cdp, c, { x: 206, y: 300 }, 120);
        await L.sleep(300);
    });
    const a = P.analyze(prof, 30);
    console.log('=== SELF ===\n' + a.self);
    console.log('=== TOTAL ===\n' + a.total);
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
