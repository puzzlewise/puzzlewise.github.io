const fs = require('fs');
const file = process.argv[2];
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const meta = snap.snapshot.meta;
const nf = meta.node_fields, nfl = nf.length, ef = meta.edge_fields, efl = ef.length;
const ntypes = meta.node_types[0], etypes = meta.edge_types[0];
const N = snap.nodes, E = snap.edges, S = snap.strings;
const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iEC = nf.indexOf('edge_count'), iDet = nf.indexOf('detachedness'), iId = nf.indexOf('id');
const eType = ef.indexOf('type'), eName = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
const count = N.length / nfl;
const firstEdge = new Uint32Array(count + 1);
for (let i = 0, e = 0; i < count; i++) { firstEdge[i] = e; e += N[i * nfl + iEC] * efl; }
firstEdge[count] = E.length;
const retainers = Array.from({ length: count }, () => []);
for (let i = 0; i < count; i++) {
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += efl) {
        const to = E[e + eTo] / nfl;
        const et = etypes[E[e + eType]];
        if (et === 'weak') continue;
        const nm = et === 'element' || et === 'hidden' ? E[e + eName] : S[E[e + eName]];
        retainers[to].push([i, et, nm]);
    }
}
const label = (i) => `${ntypes[N[i * nfl + iType]]}:${S[N[i * nfl + iName]].slice(0, 60)}`;
const targets = [];
for (let i = 0; i < count; i++) if (N[i * nfl + iDet] === 2 && /^<select/.test(S[N[i * nfl + iName]])) targets.push(i);
for (const t of targets.slice(0, 4)) {
    console.log('== target', label(t));
    // BFS up retainers, print up to 3 paths of depth 10
    const seen = new Set([t]);
    let frontier = [[t, []]];
    for (let d = 0; d < 12 && frontier.length; d++) {
        const next = [];
        for (const [n, path] of frontier) {
            for (const [r, et, nm] of retainers[n]) {
                if (seen.has(r)) continue; seen.add(r);
                const p = [...path, `${label(r)} -[${et}:${nm}]->`];
                const l = label(r);
                if (/synthetic:\(GC roots\)|Window \/|system \/ Context|^object:Window/.test(l) || d === 11) { console.log(p.reverse().join('\n   ')); }
                if (!(et === 'internal' && /Detached|<div|SVG/.test(l))) next.push([r, p]);
            }
        }
        frontier = next.slice(0, 200);
    }
    // simple: direct retainers
    console.log('direct retainers:', retainers[t].slice(0, 10).map(([r, et, nm]) => `${label(r)} [${et}:${nm}]`).join(' | '));
}
