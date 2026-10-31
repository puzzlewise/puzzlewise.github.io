const fs = require('fs');
const file = process.argv[2];
const { traceEvents: events } = JSON.parse(fs.readFileSync(file));
const main = events.find((e) => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
const ev = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X').sort((a, b) => a.ts - b.ts);
const ult = ev.filter((e) => e.name === 'UpdateLayoutTree' || e.name === 'Layout');
let shown = 0;
for (const u of ult) {
    const parents = ev.filter((p) => p !== u && p.ts <= u.ts && p.ts + p.dur >= u.ts + u.dur).map((p) => p.name + (p.args?.data?.type ? `(${p.args.data.type})` : '') + (p.args?.data?.functionName ? `[${p.args.data.functionName}]` : ''));
    const st = u.args?.beginData?.stackTrace || u.args?.data?.stackTrace;
    if (shown < 6) {
        console.log(u.name, (u.dur / 1000).toFixed(2), 'ms; elements', u.args?.elementCount, '| parents:', parents.join(' > '));
        if (st) console.log('   stack:', st.slice(0, 5).map((f) => `${f.functionName}@${(f.url || '').split('/').pop()}:${f.lineNumber}`).join(' <- '));
        shown++;
    }
}
// Breakdown of pointermove EventDispatch: children
const pm = ev.filter((e) => e.name === 'EventDispatch' && e.args?.data?.type === 'pointermove');
const childTotals = {};
for (const d of pm) {
    for (const c of ev) {
        if (c === d || c.ts < d.ts || c.ts + c.dur > d.ts + d.dur) continue;
        childTotals[c.name] = (childTotals[c.name] || 0) + c.dur / 1000;
    }
}
console.log('pointermove EventDispatch children totals (ms, nested, incl. overlap):', Object.fromEntries(Object.entries(childTotals).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => [k, +v.toFixed(1)])));
