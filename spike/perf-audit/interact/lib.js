const { chromium } = require('/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

const BASE = 'http://localhost:5204/';
const IMAGE_URL = 'https://images.unsplash.com/photo-1732562534798-9d7198f459d6?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3wxMDE4MDYxfDB8MXxzZWFyY2h8MzZ8fHBlcnNvbiUyMGZhY2V8ZW58MHwxfHx8MTc5MzM0NjQyMXww&ixlib=rb-4.1.0&q=80&w=1080';

function params(cols, rows, rotationMode = 'free') {
    return {
        seed: 1581784052, cutStyle: 'wavy', imageUrl: IMAGE_URL,
        imageSize: { width: 1080, height: 1919 }, gridSize: { cols, rows },
        rotationMode, wavyConfig: { borderless: false, traceSetVersion: 2 },
    };
}

async function launch({ mobile = true } = {}) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(mobile ? {
        viewport: { width: 412, height: 892 }, deviceScaleFactor: 2.625,
        isMobile: true, hasTouch: true,
    } : { viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 200)); });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    const cdp = await context.newCDPSession(page);
    return { browser, context, page, cdp };
}

async function loadPuzzle(page, cols, rows, rotationMode) {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__reproPuzzle === 'function', null, { timeout: 30000 });
    const ok = await page.evaluate((p) => window.__reproPuzzle(p), params(cols, rows, rotationMode));
    if (!ok) throw new Error('repro failed');
    await page.waitForFunction((n) => document.querySelectorAll('svg[data-piece-id]').length === n, cols * rows, { timeout: 60000 });
    await page.waitForTimeout(1500);
}

/** Install in-page instrumentation by importing the same Vite modules the app uses. */
async function instrument(page) {
    await page.evaluate(async () => {
        const mod = await import('/src/renderer/svg-dom-renderer.ts');
        const P = mod.SvgDomRenderer.prototype;
        const perf = window.__perf = { render: [], events: [], setItem: [], flash: [], bring: 0 };
        const orig = P.renderState;
        P.renderState = function (s) {
            const t = performance.now();
            orig.call(this, s);
            perf.render.push(performance.now() - t);
        };
        const origFlash = P.flashMergePulse;
        P.flashMergePulse = function (id) {
            const t = performance.now();
            origFlash.call(this, id);
            perf.flash.push(performance.now() - t);
        };
        const origBring = P.bringGroupToFront;
        P.bringGroupToFront = function (id) { perf.bring++; return origBring.call(this, id); };
        const origSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
            const t = performance.now();
            const r = origSet.call(this, k, v);
            perf.setItem.push({ k, len: v.length, ms: performance.now() - t, at: t });
            return r;
        };
        let t0 = 0;
        for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel']) {
            window.addEventListener(type, () => { t0 = performance.now(); }, { capture: true });
            window.addEventListener(type, (e) => { perf.events.push({ type, ms: performance.now() - t0, at: t0 }); }, { capture: false });
        }
    });
}

async function resetPerf(page) {
    await page.evaluate(() => { const p = window.__perf; p.render = []; p.events = []; p.setItem = []; p.flash = []; p.bring = 0; });
}

function stats(arr) {
    if (!arr.length) return { n: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, mean: +(sum / s.length).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

async function pieceCenter(page, pieceId) {
    return page.evaluate((id) => {
        const el = document.querySelector(`svg[data-piece-id="${id}"] path[data-hit-area]`);
        const r = el.getBoundingClientRect();
        // Probe for an actual hit point inside the outline.
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        for (let d = 0; d < 30; d += 2) {
            for (const [dx, dy] of [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]]) {
                const hit = document.elementFromPoint(cx + dx, cy + dy);
                const svg = hit && hit.closest('svg[data-piece-id]');
                if (svg && Number(svg.dataset.pieceId) === id) return { x: cx + dx, y: cy + dy };
            }
        }
        return { x: cx, y: cy, miss: true };
    }, pieceId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function touchDrag(cdp, from, to, steps, frameMs = 16) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    await sleep(frameMs);
    for (let i = 1; i <= steps; i++) {
        const x = from.x + (to.x - from.x) * i / steps;
        const y = from.y + (to.y - from.y) * i / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
        await sleep(frameMs);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function pinch(cdp, center, startDist, endDist, steps, frameMs = 16) {
    const pts = (d) => [{ x: center.x - d / 2, y: center.y, id: 1 }, { x: center.x + d / 2, y: center.y, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts(startDist)[0]] });
    await sleep(frameMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(startDist) });
    await sleep(frameMs);
    for (let i = 1; i <= steps; i++) {
        const d = startDist + (endDist - startDist) * i / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) });
        await sleep(frameMs);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

module.exports = { launch, loadPuzzle, instrument, resetPerf, stats, pieceCenter, touchDrag, pinch, sleep, params, BASE };
