const { chromium } = require('/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:5205/';
const pool = JSON.parse(fs.readFileSync('/Users/bot/src/puzzle/src/images/backup-pool.json', 'utf8'));

function poolImage(i) {
    const p = pool[(i * 37) % pool.length];
    return {
        imageUrl: p.imageUrl,
        imageSize: { width: 1080, height: Math.round(1080 * p.height / p.width) },
        portrait: p.height > p.width,
    };
}

async function launch(opts = {}) {
    const browser = await chromium.launch({
        headless: opts.headless ?? true,
        args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
    });
    const context = await browser.newContext({ viewport: opts.viewport || { width: 1180, height: 820 }, deviceScaleFactor: opts.dpr || 1 });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page error]', m.text()); });
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    return { browser, context, page, cdp };
}

async function gc(cdp) {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
}

async function countProto(cdp, expr) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    if (!result.objectId) return -1;
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId });
    const { result: len } = await cdp.send('Runtime.callFunctionOn', {
        objectId: objects.objectId, functionDeclaration: 'function(){return this.length}', returnByValue: true,
    });
    await cdp.send('Runtime.releaseObject', { objectId: objects.objectId });
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
    return len.value;
}

async function metrics(page, cdp, { doGc = true } = {}) {
    if (doGc) await gc(cdp);
    const { metrics: m } = await cdp.send('Performance.getMetrics');
    const get = (n) => m.find((x) => x.name === n)?.value;
    const attached = await page.evaluate(() => document.getElementsByTagName('*').length);
    const out = {
        heapMB: +(get('JSHeapUsedSize') / 1048576).toFixed(2),
        heapTotalMB: +(get('JSHeapTotalSize') / 1048576).toFixed(2),
        nodes: get('Nodes'),
        attachedEls: attached,
        listeners: get('JSEventListeners'),
        documents: get('Documents'),
        frames: get('Frames'),
        layoutObjects: get('LayoutObjects'),
        svgImage: await countProto(cdp, 'SVGImageElement.prototype'),
        svgSvg: await countProto(cdp, 'SVGSVGElement.prototype'),
        div: await countProto(cdp, 'HTMLDivElement.prototype'),
        promises: await countProto(cdp, 'Promise.prototype'),
        workers: page.workers().length,
    };
    return out;
}

async function heapSnapshot(cdp, file) {
    const chunks = [];
    const onChunk = (p) => chunks.push(p.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    fs.writeFileSync(file, chunks.join(''));
    return file;
}

function analyzeSnapshot(file) {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const meta = snap.snapshot.meta;
    const nf = meta.node_fields; const nfl = nf.length;
    const types = meta.node_types[0];
    const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSize = nf.indexOf('self_size'), iDet = nf.indexOf('detachedness');
    const nodes = snap.nodes; const strings = snap.strings;
    const byName = new Map(); let detached = 0; const detByName = new Map();
    for (let i = 0; i < nodes.length; i += nfl) {
        const t = types[nodes[i + iType]];
        let name = strings[nodes[i + iName]];
        if (t === 'native' || t === 'object' || t === 'closure') {
            const key = `${t}:${name.split(' ')[0]}`;
            const e = byName.get(key) || { count: 0, size: 0 };
            e.count++; e.size += nodes[i + iSize]; byName.set(key, e);
        }
        if (iDet >= 0 && nodes[i + iDet] === 2) {
            detached++;
            const k = name.split(' ')[0];
            detByName.set(k, (detByName.get(k) || 0) + 1);
        }
        if (name.startsWith('Detached ')) {
            const k = 'name:' + name.split(' ').slice(0, 2).join(' ');
            detByName.set(k, (detByName.get(k) || 0) + 1);
        }
    }
    return { byName, detached, detByName };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { launch, gc, metrics, heapSnapshot, analyzeSnapshot, sleep, poolImage, BASE, countProto };
