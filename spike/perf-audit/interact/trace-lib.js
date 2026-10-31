const CATS = [
    'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing',
    'v8.execute', 'disabled-by-default-devtools.timeline.frame', 'toplevel', 'blink',
    'disabled-by-default-devtools.timeline.invalidationTracking',
];

async function withTrace(browser, page, fn) {
    await browser.startTracing(page, { categories: CATS });
    await fn();
    const buf = await browser.stopTracing();
    return JSON.parse(buf.toString()).traceEvents;
}

/** Summarize renderer main-thread work. */
function summarize(events) {
    const main = events.find((e) => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
    const pid = main.pid, tid = main.tid;
    const ev = events.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X');
    const by = (name) => ev.filter((e) => e.name === name);
    const sumDur = (arr) => arr.reduce((a, e) => a + (e.dur || 0), 0) / 1000;
    const dispatches = by('EventDispatch');
    const byType = {};
    for (const d of dispatches) {
        const t = d.args && d.args.data && d.args.data.type;
        (byType[t] = byType[t] || []).push(d.dur / 1000);
    }
    const ult = by('UpdateLayoutTree');
    const layouts = by('Layout');
    const tasks = by('RunTask').filter((e) => e.dur > 50000);
    const elementCounts = ult.map((e) => (e.args && e.args.elementCount) || (e.args && e.args.data && e.args.data.elementCount) || (e.args && e.args.endData && e.args.endData.elementCount)).filter((x) => x != null);
    const gc = ev.filter((e) => /^(MinorGC|MajorGC|V8.GC_SCAVENGER|ScavengeGC|V8.GCScavenger|BlinkGC)/.test(e.name) || e.name === 'MinorGC' || e.name === 'MajorGC');
    const paint = by('Paint');
    const prePaint = by('PrePaint');
    const commit = by('Commit');
    const layerize = by('Layerize');
    const fmt = (arr) => {
        if (!arr.length) return '0';
        const s = arr.map((e) => (typeof e === 'number' ? e : e.dur / 1000)).sort((a, b) => a - b);
        const sum = s.reduce((a, b) => a + b, 0);
        return `n=${s.length} sum=${sum.toFixed(1)}ms mean=${(sum / s.length).toFixed(2)} p95=${s[Math.floor(0.95 * (s.length - 1))].toFixed(2)} max=${s[s.length - 1].toFixed(2)}`;
    };
    const out = {};
    for (const [t, arr] of Object.entries(byType)) out[`EventDispatch ${t}`] = fmt(arr);
    out.UpdateLayoutTree = fmt(ult);
    out.elementCount = elementCounts.length ? `mean=${(elementCounts.reduce((a, b) => a + b, 0) / elementCounts.length).toFixed(0)} max=${Math.max(...elementCounts)}` : 'n/a';
    out.Layout = fmt(layouts);
    out.PrePaint = fmt(prePaint);
    out.Paint = fmt(paint);
    out.Layerize = fmt(layerize);
    out.Commit = fmt(commit);
    out.GC = fmt(gc);
    out.longTasks = tasks.map((t) => (t.dur / 1000).toFixed(1));
    const layoutDirty = layouts.map((l) => l.args && l.args.beginData && l.args.beginData.dirtyObjects).filter((x) => x != null);
    out.layoutDirtyObjects = layoutDirty.length ? `mean=${(layoutDirty.reduce((a, b) => a + b, 0) / layoutDirty.length).toFixed(0)} max=${Math.max(...layoutDirty)}` : 'n/a';
    // Forced (sync) layouts/styles: those nested inside a FunctionCall/EventDispatch.
    const scripts = ev.filter((e) => e.name === 'FunctionCall' || e.name === 'EventDispatch' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame');
    const nested = (arr) => arr.filter((l) => scripts.some((s) => l.ts >= s.ts && l.ts + l.dur <= s.ts + s.dur));
    out.forcedLayouts = fmt(nested(layouts));
    out.forcedStyle = fmt(nested(ult));
    out.mainBusyMs = sumDur(by('RunTask')).toFixed(1);
    return out;
}

module.exports = { withTrace, summarize };
