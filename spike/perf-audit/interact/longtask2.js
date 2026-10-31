const fs = require('fs');
const { traceEvents: events } = JSON.parse(fs.readFileSync(process.argv[2]));
const main = events.find((e) => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
const ev = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X').sort((a, b) => a.ts - b.ts);
const t0 = ev[0].ts;
for (const t of ev.filter((e) => e.name === 'RunTask' && e.dur > Number(process.argv[3]||50) * 1000)) {
  console.log(`RunTask ${(t.dur / 1000).toFixed(1)}ms at +${((t.ts-t0)/1000).toFixed(0)}ms`);
  const inside = ev.filter((c) => c !== t && c.ts >= t.ts && c.ts + c.dur <= t.ts + t.dur && c.dur > 1000);
  for (const c of inside.slice(0, 25)) console.log(`   +${((c.ts - t.ts) / 1000).toFixed(1)} ${c.name} ${(c.dur / 1000).toFixed(1)}ms ${c.args?.data?.type || ''} ${c.args?.data?.functionName || ''} ${c.args?.data?.url?.split('/').pop() || ''}`);
}
