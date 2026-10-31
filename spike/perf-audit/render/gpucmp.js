// node gpucmp.js pieces scenario reps variant...   variant: outline:<id> or css:<k>
const L = require('./lib.js');
const [pieces, scenario, reps, ...variants] = [+process.argv[2], process.argv[3], +process.argv[4], ...process.argv.slice(5)];
const CSS = {
    base: '', nofilter: '[data-group-id] { filter: none !important; }',
    nowc: '[data-group-id] { will-change: auto !important; } [data-group-id].dragging { will-change: transform !important; }',
    nobackdrop: '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
};
(async () => {
    for (const v of variants) for (let r = 0; r < reps; r++) {
        const [kind, name] = v.split(':');
        const { browser, page, cdp } = await L.launch();
        await L.boot(page, L.params(pieces, process.env.CUT || 'wavy'), kind === 'outline' ? name : undefined);
        if (kind === 'css') for (const p of name.split('+')) if (CSS[p]) await page.addStyleTag({ content: CSS[p] });
        if (kind === 'js' && name === 'selectall') await page.evaluate(() => document.querySelectorAll('[data-group-id]').forEach((g) => g.classList.add('selected')));
        await page.waitForTimeout(500);
        const c = { x: 206, y: 446 };
        if (scenario === 'panin') { await L.wheel(page, c, -50, 8); await page.waitForTimeout(1000); }
        const bg = scenario.startsWith('pan') ? await L.findEmpty(page) : null;
        const pc = scenario === 'drag' ? await L.pieceCenter(page) : null;
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const { events } = await L.trace(cdp, async () => {
            if (scenario === 'drag') { await L.drag(page, pc, 60, 80, 60); }
            if (scenario.startsWith('pan')) { await L.drag(page, bg, 0, -120, 40); await L.drag(page, { x: bg.x, y: bg.y - 120 }, 0, 120, 40); }
            if (scenario === 'wheel') { await L.wheel(page, c, -50, 8); await page.waitForTimeout(300); await L.wheel(page, c, 50, 8); await page.waitForTimeout(800); }
        });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        const threads = {}, procs = {};
        for (const e of events) { if (e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args.name; if (e.name === 'process_name') procs[e.pid] = e.args.name; }
        let swap = 0, frames = 0, raster = 0, gpu = 0, bmf = 0, commit = 0, layerize = 0, passes = 0;
        for (const e of events) {
            if (e.ph !== 'X' || !e.dur) continue;
            const t = `${procs[e.pid]}/${threads[`${e.pid}:${e.tid}`]}`; const d = e.dur / 1000;
            if (t === 'GPU Process/CrGpuMain') { if (e.name === 'IOSurfaceImageBacking::WaitForCommandsToBeScheduled') swap += d; if (e.name === 'RendererRasterWorker') raster += d; if (e.name === 'RunTask') gpu += d; }
            if (t === 'GPU Process/VizCompositorThread') { if (e.name === 'DirectRenderer::DrawFrame') frames++; if (e.name === 'DirectRenderer::DrawRenderPass') passes++; }
            if (t === 'Renderer/CrRendererMain') { if (e.name === 'ProxyMain::BeginMainFrame') bmf += d; if (e.name === 'Commit') commit += d; if (e.name === 'Layerize') layerize += d; }
        }
        const snap = await L.snapNow(page, cdp);
        console.log(`${pieces} ${scenario} ${v} #${r}: frames=${frames} passes/f=${(passes / frames).toFixed(1)} gpuWait/f=${(swap / frames).toFixed(2)}ms gpuBusy/f=${(gpu / frames).toFixed(2)} gpuRaster=${raster.toFixed(0)}ms | main BMF/f=${(bmf / frames).toFixed(2)} layerize=${layerize.toFixed(0)} commit=${commit.toFixed(0)} | tileMB=${snap && snap.tileMB} layers=${snap && snap.drawing}`);
        await browser.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
