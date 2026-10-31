const { chromium, devices } = require('/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/perf-audit/load/profile-live', { headless: true, ...devices['Pixel 5'] });
  const blocked = [];
  await ctx.route(/adrianschmidt-hub\.vercel\.app\/api\//, (r) => { blocked.push(r.request().url()); r.abort(); });
  await ctx.route(/workers\.dev/, (r) => { blocked.push(r.request().url()); r.abort(); });
  const page = ctx.pages()[0];
  await page.addInitScript(() => {
    window.__m = {};
    const t = (k) => { if (!(k in window.__m)) window.__m[k] = Math.round(performance.now()); };
    const iv = setInterval(() => { if (window.umami) { t('umamiReady'); clearInterval(iv); } }, 20);
    new MutationObserver(() => { if (!document.querySelector('.loading-overlay') && document.querySelector('svg[data-piece-id]')) t('overlayGone'); }).observe(document, { subtree: true, childList: true });
    document.addEventListener('load', (e) => { if (e.target instanceof SVGImageElement) t('svgImageLoad'); }, true);
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.lcp = Math.round(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 562.5, downloadThroughput: 188743, uploadThroughput: 86400 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('https://puzzlewise.github.io/', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__m.svgImageLoad, null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({ m: window.__m, res: performance.getEntriesByType('resource').map(e => [e.name.slice(0, 70), Math.round(e.startTime), Math.round(e.responseEnd), e.transferSize]) }));
  console.log(JSON.stringify(r.m)); for (const x of r.res) console.log(' ', x.join(' '));
  console.log('blocked', blocked.map(u => u.slice(0, 70)));
  await ctx.close();
})();
