const { chromium, devices } = require('/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5202/';
const OUT = '/tmp/perf-audit/load/out';
fs.mkdirSync(OUT, { recursive: true });
const proxyUrl = (fs.readFileSync('/Users/bot/src/puzzle/.env.local', 'utf8').match(/VITE_IMAGE_PROXY_URL=(\S+)/) || [])[1];
const proxyHost = process.env.NOSTUB ? 'nope.invalid' : (proxyUrl ? new URL(proxyUrl).host : 'none');
const pool = JSON.parse(fs.readFileSync('/Users/bot/src/puzzle/src/images/backup-pool.json', 'utf8'));

const NET = {
  slow4g: { offline: false, latency: 562.5, downloadThroughput: 1.6 * 1024 * 1024 / 8 * 0.9, uploadThroughput: 750 * 1024 / 8 * 0.9 },
  fast4g: { offline: false, latency: 150, downloadThroughput: 9 * 1024 * 1024 / 8 * 0.9, uploadThroughput: 1.5 * 1024 * 1024 / 8 * 0.9 },
  none: null,
};

const INIT = () => {
  window.__m = {}; window.__ev = []; window.__lt = [];
  const t = (k) => { if (!(k in window.__m)) window.__m[k] = Math.round(performance.now()); };
  window.umami = { track: (n, d) => { window.__ev.push({ t: Math.round(performance.now()), n, d }); } };
  const check = () => {
    if (document.querySelector('.loading-overlay')) t('overlayPresent');
    else if ('overlayPresent' in window.__m) t('overlayGone');
    if (document.querySelector('svg[data-piece-id]')) t('firstPieceSvg');
    if (document.querySelector('svg[data-piece-id] image')) t('firstSvgImage');
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true });
  document.addEventListener('load', (e) => { if (e.target instanceof SVGImageElement) t('svgImageLoad'); if (e.target instanceof HTMLImageElement) t('imgLoad'); }, true);
  document.addEventListener('DOMContentLoaded', () => t('DCL'));
  window.addEventListener('load', () => t('windowLoad'));
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m['lcp'] = Math.round(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
};

function topicPage(orientation) {
  const photos = pool.filter((p) => p.orientation === orientation).slice(0, 30).map((p) => ({
    urls: { regular: p.imageUrl, full: p.imageUrl, small: p.thumbUrl },
    width: p.width, height: p.height,
    user: { name: p.photographerName, links: { html: p.photographerUrl.split('?')[0] } },
    links: { html: p.photoUrl.split('?')[0], download_location: p.downloadLocation },
    alt_description: p.description ?? null,
  }));
  return photos;
}

async function run({ name, net = 'slow4g', cpu = 4, userDataDir, setup, steps, mobile = true, blockSw = false, shot = false }) {
  const ctxOpts = mobile ? { ...devices['Pixel 5'] } : { viewport: { width: 1440, height: 900 } };
  if (blockSw) ctxOpts.serviceWorkers = 'block';
  const context = await chromium.launchPersistentContext(userDataDir, { headless: true, ...ctxOpts });
  const reqs = [];
  const t0wall = { v: 0 };
  context.on('request', (r) => { r.__start = Date.now(); });
  context.on('requestfinished', async (r) => {
    let size = null; try { size = (await r.sizes()).responseBodySize; } catch {}
    const resp = await r.response().catch(() => null);
    reqs.push({ url: r.url().slice(0, 140), type: r.resourceType(), start: r.__start - t0wall.v, end: Date.now() - t0wall.v, body: size, sw: resp ? resp.fromServiceWorker() : null, status: resp ? resp.status() : null, frame: (() => { try { return r.frame() ? 'page' : 'other'; } catch { return 'worker/sw'; } })() });
  });
  context.on('requestfailed', (r) => reqs.push({ url: r.url().slice(0, 140), failed: r.failure()?.errorText, start: r.__start - t0wall.v }));
  if (!process.env.NOROUTE) await context.route((u) => u.host === proxyHost, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/download')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: { 'access-control-allow-origin': '*' } });
    const orientation = u.searchParams.get('orientation') || 'landscape';
    const body = u.pathname.includes('/search') ? { results: topicPage(orientation), total_pages: 50 } : topicPage(orientation);
    await new Promise((r) => setTimeout(r, net === 'slow4g' ? 700 : 200));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-total', 'x-total': '1500' } });
  });
  if (!process.env.NOROUTE) await context.route(/umami|vercel\.app/, (route) => route.abort());
  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(INIT);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (NET[net]) await cdp.send('Network.emulateNetworkConditions', NET[net]);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  if (setup) await setup(page, cdp);
  t0wall.v = Date.now();
  await page.goto(BASE, { waitUntil: 'commit' });
  const results = await steps(page, t0wall);
  let data = await page.evaluate(() => ({
    m: window.__m, ev: window.__ev.map((e) => ({ t: e.t, n: e.n, gen: e.d && (e.d.generationMs ?? e.d.durationMs ?? e.d.loadMs), mode: e.d && e.d.generationMode, d: e.d && JSON.stringify(e.d).slice(0, 200) })), lt: window.__lt,
    nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n && { respStart: Math.round(n.responseStart), respEnd: Math.round(n.responseEnd), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transfer: n.transferSize }; })(),
    paint: performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]),
    res: performance.getEntriesByType('resource').map((r) => ({ n: r.name.replace(location.origin, '').slice(0, 90), s: Math.round(r.startTime), e: Math.round(r.responseEnd), tx: r.transferSize, enc: r.encodedBodySize, dec: r.decodedBodySize, it: r.initiatorType })),
    sw: navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled',
  }));
  data.server = await (await fetch(BASE + '__log')).json().catch(() => null);
  if (shot) await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await context.close();
  const out = { name, net, cpu, ...data, reqs: reqs.sort((a, b) => a.start - b.start), results };
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(out, null, 1));
  return out;
}

module.exports = { run, NET };
