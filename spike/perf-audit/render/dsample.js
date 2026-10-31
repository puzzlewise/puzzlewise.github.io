const L = require('./lib.js');
(async () => {
    const { browser, page } = await L.launch();
    await L.boot(page, L.params(96));
    console.log(await page.evaluate(() => { const d = document.querySelector('[data-hit-area]').getAttribute('d'); const nums = d.match(/-?\d+\.?\d*(e-?\d+)?/g); const decs = nums.map((n) => (n.split('.')[1] || '').length); return { len: d.length, nums: nums.length, avgDecimals: (decs.reduce((a, b) => a + b, 0) / decs.length).toFixed(1), cmds: (d.match(/[A-Za-z]/g) || []).length, sample: d.slice(0, 200) }; }));
    await browser.close();
})();
