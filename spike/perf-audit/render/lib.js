const { chromium } = require('/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

const URL = 'http://localhost:5201/';
const IMG = 'https://images.unsplash.com/photo-1732562534798-9d7198f459d6?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3wxMDE4MDYxfDB8MXxzZWFyY2h8MzZ8fHBlcnNvbiUyMGZhY2V8ZW58MHwxfHx8MTc5MzM0NjQyMXww&ixlib=rb-4.1.0&q=80&w=1080';

function params(pieces, cutStyle = 'wavy', extra = {}) {
    const grid = pieces === 192 ? { cols: 12, rows: 16 } : pieces === 96 ? { cols: 8, rows: 12 } : { cols: 6, rows: 8 };
    const p = {
        seed: 1581784052, cutStyle, imageUrl: IMG,
        imageSize: { width: 1080, height: 1919 }, gridSize: grid, rotationMode: 'free',
    };
    if (cutStyle === 'wavy') p.wavyConfig = { borderless: false, traceSetVersion: 2 };
    return Object.assign(p, extra);
}

async function launch({ dsf = 2.625, width = 412, height = 892 } = {}) {
    const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--force-device-scale-factor=" + dsf] });
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
    const cdp = await context.newCDPSession(page);
    return { browser, context, page, cdp };
}

async function boot(page, p, outline) {
    await page.goto(URL);
    if (outline) {
        await page.evaluate((o) => localStorage.setItem('puzzle-piece-outline', o), outline);
        await page.reload();
    }
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function', null, { timeout: 30000 });
    const ok = await page.evaluate(async (pp) => window.__reproPuzzle(pp), p);
    if (!ok) throw new Error('repro failed');
    await page.waitForFunction(() => {
        const img = document.querySelector('[data-piece-id] image');
        return img && document.querySelectorAll('[data-group-id]').length > 0;
    }, null, { timeout: 30000 });
    // wait for image decode & idle
    await page.waitForTimeout(2500);
}

const CATS = [
    'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
    'cc', 'disabled-by-default-cc.debug', 'viz', 'gpu', 'blink', 'benchmark', 'toplevel', 'rail',
].join(',');

async function trace(cdp, fn) {
    const events = [];
    const onData = (d) => { for (const e of d.value) events.push(e); };
    cdp.on('Tracing.dataCollected', onData);
    await cdp.send('Tracing.start', { categories: CATS, transferMode: 'ReportEvents' });
    const t0 = Date.now();
    const result = await fn();
    const wall = Date.now() - t0;
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    return { events, wall, result };
}

const SUM_NAMES = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'UpdateLayer', 'Commit',
    'RasterTask', 'ImageDecodeTask', 'Decode Image', 'FunctionCall', 'EventDispatch', 'HitTest', 'ParseHTML',
    'ProxyMain::BeginMainFrame::commit', 'ImageDecode', 'PaintImage', 'CompositeLayers', 'UpdateLayerTree',
    'TimerFire', 'FireAnimationFrame', 'Graphics.Pipeline', 'DrawFrame', 'BeginFrame'];

function summarize(events) {
    const threads = {};
    for (const e of events) if (e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args.name;
    const mainTids = new Set(Object.entries(threads).filter(([, n]) => n === 'CrRendererMain').map(([k]) => k));
    const out = {};
    const add = (k, dur) => { out[k] = out[k] || { n: 0, ms: 0, max: 0 }; out[k].n++; out[k].ms += dur; out[k].max = Math.max(out[k].max, dur); };
    let drawFrames = 0;
    let firstTs = Infinity, lastTs = 0;
    const tasks = [];
    for (const e of events) {
        if (e.name === 'DrawFrame' || (e.name === 'Graphics.Pipeline.DrawAndSwap')) drawFrames++;
        if (e.ph !== 'X' || e.dur === undefined) continue;
        const key = `${e.pid}:${e.tid}`;
        const dur = e.dur / 1000;
        if (e.name === 'RunTask' && mainTids.has(key)) { tasks.push(dur); }
        if (SUM_NAMES.includes(e.name)) {
            const where = mainTids.has(key) ? 'main' : (threads[key] || 'other').replace(/\d+$/, '');
            add(`${e.name}@${where}`, dur);
        }
        firstTs = Math.min(firstTs, e.ts); lastTs = Math.max(lastTs, e.ts);
    }
    for (const k of Object.keys(out)) { out[k].ms = +out[k].ms.toFixed(1); out[k].max = +out[k].max.toFixed(1); }
    tasks.sort((a, b) => b - a);
    const long = tasks.filter((t) => t > 50);
    return { stages: out, longTasks: long.length, longTaskMs: +long.reduce((a, b) => a + b, 0).toFixed(0), topTasks: tasks.slice(0, 5).map((t) => +t.toFixed(1)) };
}

// In-page rAF frame logger
async function startFrames(page) {
    await page.evaluate(() => {
        window.__frames = [];
        window.__frameRun = true;
        const gen = window.__frameGen = (window.__frameGen || 0) + 1;
        const tick = (t) => { if (gen !== window.__frameGen) return; window.__frames.push(t); if (window.__frameRun) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
}
async function stopFrames(page) {
    return page.evaluate(() => {
        window.__frameRun = false;
        const f = window.__frames;
        const d = [];
        for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
        const total = f.length > 1 ? f[f.length - 1] - f[0] : 0;
        const sorted = [...d].sort((a, b) => a - b);
        const pct = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1) : 0;
        return { frames: f.length, fps: total ? +(1000 * (f.length - 1) / total).toFixed(1) : 0, p50: pct(0.5), p95: pct(0.95), max: pct(1), over50: d.filter((x) => x > 50).length };
    });
}

async function layers(cdp) {
    const tree = await new Promise(async (resolve) => {
        cdp.once('LayerTree.layerTreeDidChange', (e) => resolve(e.layers));
        await cdp.send('LayerTree.enable');
        setTimeout(() => resolve(null), 3000);
    });
    await cdp.send('LayerTree.disable');
    if (!tree) return null;
    let area = 0, drawn = 0;
    const sizes = [];
    for (const l of tree) {
        if (!l.drawsContent) continue;
        drawn++;
        const a = l.width * l.height;
        area += a;
        sizes.push([Math.round(l.width), Math.round(l.height)]);
    }
    return { total: tree.length, drawsContent: drawn, cssPxArea: area, sizes };
}

async function gpuMem(page, cdp) {
    // Approximate via memory dump if available
    try {
        const r = await cdp.send('Tracing.requestMemoryDump');
        return r;
    } catch (e) { return null; }
}

module.exports = { launch, boot, params, trace, summarize, startFrames, stopFrames, layers, URL };

function analyze(events) {
    const threads = {}; const procs = {};
    for (const e of events) { if (e.name === 'thread_name') threads[`${e.pid}:${e.tid}`] = e.args.name; if (e.name === 'process_name') procs[e.pid] = e.args.name; }
    const tn = (e) => `${procs[e.pid] || e.pid}/${threads[`${e.pid}:${e.tid}`] || e.tid}`;
    const want = {
        'Renderer/CrRendererMain': ['ProxyMain::BeginMainFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'FunctionCall', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'HitTest', 'RunTask'],
        'Renderer/Compositor': ['ProxyImpl::ScheduledActionDraw', 'LayerTreeHostImpl::FinishCommit', 'TileManager::PrepareTiles'],
        'Renderer/ThreadPoolForegroundWorker': ['RasterTask', 'ImageDecodeTask'],
        'GPU Process/CrGpuMain': ['RendererRasterWorker', 'SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass', 'SkiaOutputSurfaceImplOnGpu::SwapBuffers'],
        'GPU Process/VizCompositorThread': ['DirectRenderer::DrawFrame', 'DirectRenderer::DrawRenderPass'],
    };
    const out = {};
    const elementCounts = [];
    let mainTasks = [];
    for (const e of events) {
        if (e.ph !== 'X' || e.dur === undefined) continue;
        const t = tn(e);
        if (e.name === "RunTask" && (t === "GPU Process/CrGpuMain" || t === "Renderer/Compositor" || t === "GPU Process/VizCompositorThread")) { const kk = t.split("/")[1] + ":busy"; out[kk] = out[kk] || { n: 0, ms: 0, max: 0 }; out[kk].n++; out[kk].ms += e.dur / 1000; out[kk].max = Math.max(out[kk].max, e.dur / 1000); continue; }
        const list = want[t]; if (!list || !list.includes(e.name)) continue;
        const k = `${t.split('/')[1].replace('ThreadPoolForegroundWorker', 'Worker')}:${e.name.replace('SkiaOutputSurfaceImplOnGpu::', '').replace('DirectRenderer::', '')}`;
        const d = e.dur / 1000;
        if (e.name === 'RunTask') { mainTasks.push(d); continue; }
        out[k] = out[k] || { n: 0, ms: 0, max: 0 }; out[k].n++; out[k].ms += d; out[k].max = Math.max(out[k].max, d);
        if (e.name === 'UpdateLayoutTree' && e.args && e.args.elementCount !== undefined) elementCounts.push(e.args.elementCount);
    }
    for (const v of Object.values(out)) { v.ms = +v.ms.toFixed(1); v.max = +v.max.toFixed(1); }
    mainTasks.sort((a, b) => b - a);
    const snaps = events.filter((e) => e.ph === 'O' && e.name === 'cc::LayerTreeHostImpl');
    return { stages: out, styleElems: elementCounts.length ? { n: elementCounts.length, max: Math.max(...elementCounts), sum: elementCounts.reduce((a, b) => a + b, 0) } : null, longTasks: mainTasks.filter((x) => x > 50).length, topTasks: mainTasks.slice(0, 4).map((x) => +x.toFixed(1)), snaps: snaps.map((s) => ccSnap(s.args.snapshot)) };
}

function ccSnap(snap) {
    const layers = (snap.active_tree && snap.active_tree.layers) || [];
    const drawing = layers.filter((l) => l.draws_content);
    const scales = drawing.map((l) => (l.tilings && l.tilings[0] ? l.tilings[0].content_scale : 0)).filter(Boolean);
    const mem = (snap.active_tiles || []).reduce((a, t) => a + (t.gpu_memory_usage || 0), 0);
    const wc = drawing.filter((l) => (l.compositing_reason_ids || []).includes('WillChangeTransform')).length;
    const reasons = {};
    for (const l of drawing) for (const r of (l.compositing_reason_ids || ['none'])) reasons[r] = (reasons[r] || 0) + 1;
    return {
        layers: layers.length, drawing: drawing.length, willChange: wc, reasons,
        tiles: (snap.active_tiles || []).length, tileMB: +(mem / 1048576).toFixed(1),
        maxScale: scales.length ? +Math.max(...scales).toFixed(3) : 0, medScale: scales.length ? +scales.sort((a, b) => a - b)[scales.length >> 1].toFixed(3) : 0,
        surfaces: (snap.active_tree && snap.active_tree.render_surface_layer_list || []).length,
    };
}

async function snapNow(page, cdp) { const r = await rawSnap(page, cdp); return r ? ccSnap(r) : null; }
async function rawSnap(page, cdp) {
    for (let attempt = 0; attempt < 4; attempt++) {
        const { events } = await trace(cdp, async () => {
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => { let d = document.getElementById("__snapdot"); if (!d) { d = document.createElement("div"); d.id = "__snapdot"; d.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;z-index:99999"; document.body.appendChild(d); } d.style.background = d.style.background === "red" ? "blue" : "red"; });
                await page.waitForTimeout(150);
            }
        });
        const s = events.filter((e) => e.ph === "O" && e.name === "cc::LayerTreeHostImpl").pop();
        if (s) return s.args.snapshot;
    }
    return null;
}

async function measure(page, cdp, label, fn, { throttle = 4 } = {}) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await startFrames(page);
    const { events, wall } = await trace(cdp, fn);
    const frames = await stopFrames(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const a = analyze(events);
    const res = { label, throttle, wall, frames, ...a, snaps: undefined, lastSnap: a.snaps[a.snaps.length - 1] };
    return res;
}

function fmt(r) {
    const s = r.stages;
    const g = (k) => (s[k] ? `${s[k].ms}ms/${s[k].n}` : '-');
    return `[${r.label}] x${r.throttle} wall=${r.wall}ms rAF fps=${r.frames.fps} p50=${r.frames.p50} p95=${r.frames.p95} max=${r.frames.max} >50ms=${r.frames.over50} longTasks=${r.longTasks} top=${r.topTasks}\n` +
        `   main: BMF=${g('CrRendererMain:ProxyMain::BeginMainFrame')} style=${g('CrRendererMain:UpdateLayoutTree')} layout=${g('CrRendererMain:Layout')} prepaint=${g('CrRendererMain:PrePaint')} paint=${g('CrRendererMain:Paint')} layerize=${g('CrRendererMain:Layerize')} commit=${g('CrRendererMain:Commit')} js(evt)=${g('CrRendererMain:EventDispatch')} js(fn)=${g('CrRendererMain:FunctionCall')} timer=${g('CrRendererMain:TimerFire')} rAF=${g('CrRendererMain:FireAnimationFrame')}\n` +
        `   styleElems=${JSON.stringify(r.styleElems)} raster: rec=${g('Worker:RasterTask')} gpuRaster=${g('CrGpuMain:RendererRasterWorker')} decode=${g('Worker:ImageDecodeTask')} | viz: drawFrame=${g('VizCompositorThread:DrawFrame')} renderPasses=${g('VizCompositorThread:DrawRenderPass')} gpuPaintPass=${g('CrGpuMain:FinishPaintRenderPass')} gpuBusy=${g('CrGpuMain:busy')} vizBusy=${g('VizCompositorThread:busy')} implBusy=${g('Compositor:busy')}\n` +
        `   cc: ${JSON.stringify(r.lastSnap)}`;
}

async function findEmpty(page) {
    return page.evaluate(() => {
        const W = innerWidth, H = innerHeight;
        const tbl = document.querySelector("[data-puzzle-table]"); const isBg = (x, y) => { const el = document.elementFromPoint(x, y); return el === tbl || el === tbl.parentElement; };
        for (let y = H - 60; y > 100; y -= 10) for (let x = 40; x < W - 40; x += 10) {
            let ok = true;
            for (let dy = -15; dy <= 15 && ok; dy += 15) for (let dx = -15; dx <= 15 && ok; dx += 15) if (!isBg(x + dx, y + dy)) ok = false;
            if (ok) return { x, y };
        }
        return null;
    });
}

async function pieceCenter(page, pieceId) {
    return page.evaluate((id) => {
        const svg = id === undefined ? [...document.querySelectorAll('svg[data-piece-id]')][Math.floor(document.querySelectorAll('svg[data-piece-id]').length / 2)] : document.querySelector(`svg[data-piece-id="${id}"]`);
        const hit = svg.querySelector('[data-hit-area]');
        const r = hit.getBoundingClientRect();
        // walk for a point that hits this piece
        for (let fy = 0.5; fy < 0.9; fy += 0.05) for (let fx = 0.5; fx < 0.9; fx += 0.05) for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
            const x = r.left + r.width * (0.5 + sx * (fx - 0.5)), y = r.top + r.height * (0.5 + sy * (fy - 0.5));
            const el = document.elementFromPoint(x, y);
            if (el && el.closest('svg[data-piece-id]') === svg) return { x, y, id: Number(svg.dataset.pieceId) };
        }
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: Number(svg.dataset.pieceId) };
    }, pieceId);
}

async function drag(page, from, dx, dy, steps = 40, gap = 16) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + dx * i / steps, from.y + dy * i / steps); await page.waitForTimeout(gap); }
    await page.mouse.up();
}

async function wheel(page, at, dy, n, gap = 16) {
    await page.mouse.move(at.x, at.y);
    for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(gap); }
}

async function pinch(cdp, page, c, d0, d1, steps = 30, gap = 16) {
    const pts = (d) => [{ x: c.x - d / 2, y: c.y, id: 1 }, { x: c.x + d / 2, y: c.y, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
    for (let i = 1; i <= steps; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + (d1 - d0) * i / steps) }); await page.waitForTimeout(gap); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function tableScale(page) { return page.evaluate(() => document.querySelector('[data-puzzle-table]').style.transform); }

Object.assign(module.exports, { rawSnap, analyze, ccSnap, snapNow, measure, fmt, findEmpty, pieceCenter, drag, wheel, pinch, tableScale });
