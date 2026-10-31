const { chromium } = require('/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5203/', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const cdp = await page.context().newCDPSession(page);
  const run = async (label) => page.evaluate(async (label) => {
    const ga = await import('/src/game/generate-async.ts');
    const gc = await import('/src/game/generation-core.ts');
    const loader = await import('/src/puzzle/topology/traced-tab-loader.ts');
    await loader.preloadTracedTabGenerator();
    const out = [];
    for (const [name, extra] of [
      ['triangles', { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 2 } }],
      ['wavy', { cutStyle: 'wavy', wavyConfig: { borderless: false, traceSetVersion: 2 } }],
      ['classic', { cutStyle: 'classic', classicConfig: { traceSetVersion: 2 } }],
    ]) {
      const req = { tabDebug: false, gridSize: { cols: 16, rows: 12 }, imageSize: { width: 1920, height: 1280 }, seed: 12345, ...extra };
      let t = performance.now();
      const r = await ga.generatePiecesOffThread(req);
      const wms = performance.now() - t;
      t = performance.now();
      gc.runGeneration(req);
      const mms = performance.now() - t;
      out.push(`${label} ${name}: worker(total incl spawn+load+clone) ${wms.toFixed(0)}ms mode=${r.mode}; main-thread sync ${mms.toFixed(0)}ms`);
    }
    return out.join('\n');
  }, label);
  console.log(await run('1x'));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  console.log(await run('4x-throttle'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
