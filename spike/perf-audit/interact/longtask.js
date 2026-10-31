const fs = require('fs');
const { traceEvents: events } = JSON.parse(fs.readFileSync(process.argv[2]));
const main = events.find((e) => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
const ev = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X').sort((a, b) => a.ts - b.ts);
const min = Number(process.argv[3] || 30) * 1000;
for (const t of ev.filter((e) => e.name === 'RunTask' && e.dur > min)) {
  console.log(`RunTask ${(t.dur / 1000).toFixed(1)}ms`);
  const inside = ev.filter((c) => c !== t && c.ts >= t.ts && c.ts + c.dur <= t.ts + t.dur && c.dur > 500);
  const interesting = ['EventDispatch','FunctionCall','TimerFire','FireAnimationFrame','UpdateLayoutTree','Layout','PrePaint','Paint','Layerize','Commit','ParseHTML','Decode Image','ImageDecodeTask','MinorGC','MajorGC','V8.GC_MARK_COMPACTOR','HitTest','IntersectionObserverController::computeIntersections','UpdateLayer','ScrollLayer','CompositeLayers','Document::UpdateStyleAndLayout','Blink.ForcedStyleAndLayout.UpdateTime','BlinkGC.AtomicPhase','ThreadState::performIdleLazySweep','v8.run','PaintImage','Animation','EventTiming','ProfileChunk','v8.callFunction','Document::recalcStyle','LocalFrameView::RunPostLifecycleSteps','CommitLoad'];
  for (const c of inside) {
    if (!interesting.includes(c.name) && !/GC|Paint|Layout|Style|Layer|Decode|Raster/.test(c.name)) continue;
    const d = c.args?.data || {};
    console.log(`   +${((c.ts - t.ts) / 1000).toFixed(1)} ${c.name} ${(c.dur / 1000).toFixed(1)}ms ${d.type || ''} ${d.functionName || ''} ${c.args?.elementCount ?? ''} ${c.args?.beginData?.dirtyObjects ?? ''}`);
  }
}
