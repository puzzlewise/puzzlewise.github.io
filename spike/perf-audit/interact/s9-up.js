const L = require('./lib.js');
const S = require('./scenarios.js');
const P = require('./prof-lib.js');
(async () => {
    const { browser, page, cdp } = await L.launch();
    await L.loadPuzzle(page, 12, 16, 'free');
    const { st, pr } = await S.readSave(page);
    const prog = S.buildProgress(st, pr, {
        singlesOverride: (i) => ({ x: (i % 12) * 130, y: Math.floor(i / 12) * 160 }),
        selection: (groups) => groups.slice(0, 100).map((gr) => gr.id),
    });
    await S.installProgress(page, prog);
    const c = await L.pieceCenter(page, prog.groups[5].pieces[0][0]);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // drag without profiling, then profile only the release
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...c, id: 1 }] });
    for (let i = 1; i <= 20; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + i * 2, y: c.y + i * 3, id: 1 }] }); await L.sleep(16); }
    await L.sleep(300);
    const prof = await P.withProfile(cdp, async () => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await L.sleep(300); }, 50);
    const a = P.analyze(prof, 25);
    console.log(a.total.split('\n').filter((l) => !/\(root\)|\(idle\)|\(program\)/.test(l)).join('\n'));
    await browser.close();
})();
