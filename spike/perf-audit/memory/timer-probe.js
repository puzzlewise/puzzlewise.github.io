(() => {
    const live = new Map();
    let nextIntervals = new Set();
    const stats = { timeoutsSet: 0, intervalsSet: 0, rafSet: 0, liveTimeouts: live, liveIntervals: nextIntervals, rafByStack: new Map(), timeoutByStack: new Map() };
    const oST = window.setTimeout, oCT = window.clearTimeout, oSI = window.setInterval, oCI = window.clearInterval, oRAF = window.requestAnimationFrame;
    const where = () => (new Error().stack || '').split('\n').slice(3, 5).map((s) => s.trim().replace(/https?:\/\/[^/]+/, '')).join(' <- ');
    window.setTimeout = function (fn, ms, ...rest) {
        stats.timeoutsSet++;
        const w = where();
        stats.timeoutByStack.set(w, (stats.timeoutByStack.get(w) || 0) + 1);
        const id = oST.call(window, function () { live.delete(id); return typeof fn === 'function' ? fn.apply(this, arguments) : undefined; }, ms, ...rest);
        live.set(id, { ms, w });
        return id;
    };
    window.clearTimeout = function (id) { live.delete(id); return oCT.call(window, id); };
    window.setInterval = function (fn, ms, ...rest) {
        stats.intervalsSet++;
        const id = oSI.call(window, fn, ms, ...rest);
        nextIntervals.add(id);
        stats.intervalStacks = stats.intervalStacks || [];
        stats.intervalStacks.push(where());
        return id;
    };
    window.clearInterval = function (id) { nextIntervals.delete(id); return oCI.call(window, id); };
    window.requestAnimationFrame = function (fn) {
        stats.rafSet++;
        const w = where();
        stats.rafByStack.set(w, (stats.rafByStack.get(w) || 0) + 1);
        return oRAF.call(window, fn);
    };
    window.__timerStats = () => ({
        timeoutsSet: stats.timeoutsSet, intervalsSet: stats.intervalsSet, rafSet: stats.rafSet,
        liveTimeouts: [...live.values()].map((v) => `${v.ms}ms ${v.w}`),
        liveIntervals: nextIntervals.size, intervalStacks: stats.intervalStacks || [],
        rafTop: [...stats.rafByStack.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        timeoutTop: [...stats.timeoutByStack.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    });
    window.__timerReset = () => { stats.timeoutsSet = 0; stats.rafSet = 0; stats.rafByStack.clear(); stats.timeoutByStack.clear(); };
})();
