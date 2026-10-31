const { launch, sleep, BASE } = require('./lib.cjs');
(async () => {
    const { page, cdp, browser } = await launch();
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', (e) => console.log('BFCACHE NOT USED', JSON.stringify(e.notRestoredExplanations.map((x) => x.reason + ':' + x.type))));
    await page.route('http://localhost:8787/**', (r) => r.abort());
    await page.goto(BASE);
    await page.waitForFunction(() => !!document.querySelector('[data-piece-id]'), null, { timeout: 60000 });
    await sleep(2500);
    await page.evaluate(() => { window.__marker = 1; addEventListener('pageshow', (e) => { window.__persisted = e.persisted; }); });
    await page.goto(BASE + 'manifest.webmanifest');
    await sleep(500);
    await page.goBack();
    await sleep(1500);
    console.log('restored from bfcache:', await page.evaluate(() => ({ marker: window.__marker, persisted: window.__persisted })));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
