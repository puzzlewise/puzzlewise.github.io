async function withProfile(cdp, fn, interval = 50) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval });
    await cdp.send('Profiler.start');
    await fn();
    const { profile } = await cdp.send('Profiler.stop');
    return profile;
}

function analyze(profile, top = 25) {
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const dt = profile.timeDeltas;
    const selfT = new Map();
    const totalT = new Map();
    const key = (n) => `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`;
    for (let i = 0; i < profile.samples.length; i++) {
        const d = (dt[i + 1] ?? dt[i]) / 1000;
        let id = profile.samples[i];
        const n = nodes.get(id);
        const k = key(n);
        selfT.set(k, (selfT.get(k) || 0) + d);
        const seen = new Set();
        while (id !== undefined) {
            const kk = key(nodes.get(id));
            if (!seen.has(kk)) { totalT.set(kk, (totalT.get(kk) || 0) + d); seen.add(kk); }
            id = parent.get(id);
        }
    }
    const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${v.toFixed(1).padStart(8)}ms  ${k}`).join('\n');
    return { self: fmt(selfT), total: fmt(totalT), totalMap: totalT, selfMap: selfT };
}

module.exports = { withProfile, analyze };
