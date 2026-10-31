const fs = require('fs');
const { execSync } = require('child_process');
const { launch, metrics, sleep, poolImage, BASE } = require('./lib.cjs');

async function trace(page, cdp, ms, label) {
    const events = [];
    const onData = (p) => events.push(...p.value);
    cdp.on('Tracing.dataCollected', onData);
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink,cc,viz', transferMode: 'ReportEvents' });
    await sleep(ms);
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    console.log("  trace events", events.length, JSON.stringify(Object.entries(events.reduce((a,e)=>{a[e.name]=(a[e.name]||0)+1;return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,25)));
    const pid = events.find((e) => e.name === 'TracingStartedInBrowser')?.args?.data?.frames?.[0]?.processId;
    const count = {};
    for (const e of events) {
        if (!['FireAnimationFrame', 'TimerFire', 'Paint', 'UpdateLayoutTree', 'Layout', 'FunctionCall', 'EventDispatch', 'Animation', 'CompositeLayers', 'BeginFrame', 'DrawFrame', 'RasterTask', 'ScheduleStyleRecalculation', 'v8.compile', 'GPUTask', 'PrePaint', 'Commit'].includes(e.name)) continue;
        if (e.ph === 'E') continue;
        const k = e.name + (e.pid === pid ? '' : '@other');
        count[k] = (count[k] || 0) + 1;
    }
    const timers = events.filter((e) => e.name === 'TimerFire' && e.pid === pid).map((e) => e.args?.data?.timerId);
    console.log(label, JSON.stringify(count), 'timerFires', timers.length);
    return count;
}

let MYPIDS = null;
function rss() {
    const out = execSync("ps -axo pid,rss,command").toString();
    return out.trim().split("\n").slice(1).map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return { pid: +m[1], rssMB: +(+m[2] / 1024).toFixed(1), type: (/--type=(\S+)/.exec(m[3]) || [, "browser"])[1] }; }).filter((p) => MYPIDS && MYPIDS.has(p.pid));
}

async function layers(cdp) {
    const got = new Promise((r) => { cdp.once('LayerTree.layerTreeDidChange', r); });
    await cdp.send('LayerTree.enable'); await cdp.send('Runtime.evaluate', { expression: "document.body.style.outline=document.body.style.outline?'':'1px solid transparent'" });
    const ev = await Promise.race([got, sleep(3000).then(() => null)]);
    await cdp.send('LayerTree.disable');
    if (!ev || !ev.layers) return null;
    let n = 0, drawing = 0, px = 0;
    for (const l of ev.layers) { n++; if (l.drawsContent) { drawing++; px += l.width * l.height; } }
    return { layers: n, drawing, layerMpx: +(px / 1e6).toFixed(2) };
}

(async () => {
    const dpr = Number(process.env.DPR || 2);
    const { browser, page, cdp } = await launch({ dpr, viewport: { width: 1180, height: 820 } });
    await cdp.send('Animation.enable');
    const bcdp = await browser.newBrowserCDPSession(); const pi = await bcdp.send('SystemInfo.getProcessInfo'); MYPIDS = new Set(pi.processInfo.map((p) => p.id)); console.log('my procs', JSON.stringify(pi.processInfo.map((p)=>p.type+':'+p.id)));
    let anims = 0; cdp.on('Animation.animationStarted', () => anims++);
    await page.goto(BASE);
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function' && document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(2000);
    console.log('rss boot (48pc first-run)', JSON.stringify(rss().filter((p) => ['renderer', 'gpu-process', 'browser'].includes(p.type))));
    console.log('layers boot', JSON.stringify(await layers(cdp)));
    const img = poolImage(5);
    await page.evaluate((p) => window.__reproPuzzle(p), { seed: 99, cutStyle: 'wavy', imageUrl: img.imageUrl, imageSize: img.imageSize, gridSize: img.portrait ? { cols: 12, rows: 16 } : { cols: 16, rows: 12 }, rotationMode: 'free', wavyConfig: { borderless: false, traceSetVersion: 2 } });
    await sleep(4000);
    console.log('metrics 192', JSON.stringify(await metrics(page, cdp)));
    console.log('rss 192 fit', JSON.stringify(rss().filter((p) => ['renderer', 'gpu-process', 'browser'].includes(p.type))));
    console.log('layers 192 fit', JSON.stringify(await layers(cdp)));
    const mem = await cdp.send('Memory.getDOMCounters');
    console.log('DOMCounters', JSON.stringify(mem));
    anims = 0;
    console.log('getAnimations', await page.evaluate(() => document.getAnimations().length));
    await trace(page, cdp, 10000, 'IDLE 10s (192, fitted)');
    console.log('animationsStarted during idle', anims);
    // zoom in a lot
    for (let z = 0; z < 8; z++) { await page.mouse.move(590, 410); await page.mouse.wheel(0, -400); await sleep(60); }
    await sleep(1500);
    console.log('rss 192 zoomed', JSON.stringify(rss().filter((p) => ['renderer', 'gpu-process'].includes(p.type))));
    console.log('layers 192 zoomed', JSON.stringify(await layers(cdp)), await page.evaluate(() => document.querySelector('[data-puzzle-table]').style.transform));
    await trace(page, cdp, 5000, 'IDLE 5s (192, zoomed)');
    await page.evaluate(() => window.__solvePuzzle());
    await sleep(5000);
    anims = 0;
    console.log('getAnimations after solve', await page.evaluate(() => document.getAnimations().map((a) => `${a.animationName || a.constructor.name}:${a.playState}`)));
    await trace(page, cdp, 10000, 'IDLE 10s (completed overlay)');
    console.log('animationsStarted during completed idle', anims);
    // hidden tab
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
