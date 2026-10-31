import { preloadTracedTabGenerator } from '/Users/bot/src/puzzle/src/puzzle/topology/traced-tab-loader.ts';
import { createNewGame } from '/Users/bot/src/puzzle/src/game/init.ts';
import { processDrop } from '/Users/bot/src/puzzle/src/game/group-merging.ts';
import { detectMerges } from '/Users/bot/src/puzzle/src/game/merge-detection.ts';
import { shouldSuppressMerge } from '/Users/bot/src/puzzle/src/game/pile-detection.ts';
import { reorderGroupsAfterDrop } from '/Users/bot/src/puzzle/src/game/z-order.ts';
import { buildProximityContext, selectStickyWinner } from '/Users/bot/src/puzzle/src/game/snap-proximity-context.ts';
import { getGroupVisualBounds, getGroupLocalBounds } from '/Users/bot/src/puzzle/src/game/group-bounds.ts';
import { getPathBounds } from '/Users/bot/src/puzzle/src/game/path-bounds.ts';

import { checkWin } from '/Users/bot/src/puzzle/src/game/win-detection.ts';
import { buildGroupIndexes } from '/Users/bot/src/puzzle/src/model/helpers.ts';
import { serializeStatic, serializeProgress, recombine } from '/Users/bot/src/puzzle/src/persistence/serialization.ts';
import { compressForStorage, decompressFromStorage } from '/Users/bot/src/puzzle/src/persistence/compression.ts';
import type { GameState, PieceGroup } from '/Users/bot/src/puzzle/src/model/types.ts';

function bench(name: string, fn: () => unknown, iters = 200) {
    for (let i = 0; i < Math.min(20, iters); i++) fn();
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    const per = (performance.now() - t0) / iters;
    console.log(name.padEnd(58), (per * 1000).toFixed(1).padStart(10), 'µs');
}
function cloneGroups(s: GameState): GameState {
    const groups = s.groups.map(g => ({ ...g, position: { ...g.position }, pieces: new Map(g.pieces) }));
    const { groupsById, pieceToGroup } = buildGroupIndexes(groups);
    return { ...s, groups, groupsById, pieceToGroup, completed: false };
}

await preloadTracedTabGenerator();
for (const [label, opts] of [
    ['classic-traced', { cutStyle: 'classic', classicConfig: { traceSetVersion: 2 } }],
    ['triangles', { cutStyle: 'triangles', trianglesConfig: { traceSetVersion: 2 } }],
] as const) {
    const fresh = createNewGame('x', { width: 1920, height: 1280 }, { width: 1400, height: 900 }, { cols: 16, rows: 12 }, { ...(opts as any), seed: 12345, rotationMode: 'free' });
    console.log(`\n== ${label}: ${fresh.pieces.length} pieces, ${fresh.groups.length} groups, edges ${fresh.pieces.reduce((a, p) => a + p.edges.length, 0)}`);
    // mid-game: big solved group with half the pieces + rest singletons
    const half = Math.floor(fresh.pieces.length / 2);
    const big: PieceGroup = { id: 0, pieces: new Map(), position: { x: 300, y: 200 }, rotation: 0 };
    const singles: PieceGroup[] = [];
    for (const g of fresh.groups) for (const pid of g.pieces.keys()) {
        const p = fresh.piecesById.get(pid)!;
        if (pid < half) big.pieces.set(pid, { x: -p.imageOffset.x, y: -p.imageOffset.y });
        else singles.push({ id: pid, pieces: new Map([[pid, { x: 0, y: 0 }]]), position: { ...g.position }, rotation: g.rotation });
    }
    big.id = Math.min(...big.pieces.keys());
    const midGroups = [big, ...singles];
    const mid: GameState = { ...fresh, groups: midGroups, ...buildGroupIndexes(midGroups) };
    const single = singles[0];

    bench('fresh: processDrop(single, no merge)', () => processDrop(fresh.groups[5].id, cloneGroups(fresh)), 200);
    bench('  (cloneGroups overhead alone)', () => cloneGroups(fresh), 200);
    bench('fresh: shouldSuppressMerge(single)', () => shouldSuppressMerge(fresh.groups[5].id, fresh));
    bench('fresh: detectMerges(single)', () => detectMerges(fresh.groups[5].id, fresh));
    bench('fresh: reorderGroupsAfterDrop(single)', () => reorderGroupsAfterDrop([fresh.groups[5].id], fresh, () => {}));
    bench('mid: detectMerges(big group)', () => detectMerges(big.id, mid));
    bench('mid: reorderGroupsAfterDrop(big group)', () => reorderGroupsAfterDrop([big.id], mid, () => {}));
    bench('mid: shouldSuppressMerge(single)', () => shouldSuppressMerge(single.id, mid));
    const ctx = buildProximityContext(mid, big.id, { tolerancePx: 30, rotationToleranceDeg: 15 })!;
    console.log('  big group border candidates:', ctx.candidates.length);
    bench('mid: buildProximityContext(big) [drag start]', () => buildProximityContext(mid, big.id, { tolerancePx: 30, rotationToleranceDeg: 15 }));
    bench('mid: selectStickyWinner(big) [per move]', () => { ctx.latchedCandidateIndex = null; selectStickyWinner(big, ctx); });
    bench('mid: getGroupVisualBounds(big) warm cache', () => getGroupVisualBounds(big, mid.piecesById));
    bench('mid: getGroupLocalBounds(big) warm', () => getGroupLocalBounds(big, mid.piecesById));
    const allEdges = fresh.pieces.flatMap(p => p.edges);
    bench('getPathBounds over ALL edges (cold-cache equivalent)', () => { for (const e of allEdges) getPathBounds(e.path, e.start); }, 50);
    bench('mid: gatherGroups-equivalent visual bounds all groups', () => { for (const g of mid.groups) getGroupVisualBounds(g, mid.piecesById); }, 100);
    bench('checkWin', () => checkWin(mid), 1000);

    // full-solve drop cascade: place each single exactly into the big group and drop
    {
        const s = cloneGroups(mid);
        const bigG = s.groupsById.get(big.id)!;
        const t0 = performance.now();
        let merges = 0, n = 0;
        for (const g of [...s.groups]) {
            if (g.id === bigG.id) continue;
            const pid = [...g.pieces.keys()][0];
            const p = s.piecesById.get(pid)!;
            const tgt = s.pieceToGroup.get(big.id)!;
            g.rotation = tgt.rotation;
            g.position = { x: tgt.position.x - p.imageOffset.x + 3, y: tgt.position.y - p.imageOffset.y + 2 };
            const r = processDrop(g.id, s);
            if (r) merges += r.mergeCount;
            n++;
        }
        const el = performance.now() - t0;
        console.log(`  solve-by-drops: ${n} drops, ${merges} merges, ${(el / n * 1000).toFixed(1)} µs/drop avg, groups left ${s.groups.length}`);
    }

    // persistence
    let json = '';
    bench('serializeStatic + JSON.stringify', () => { json = JSON.stringify(serializeStatic(fresh)); }, 20);
    console.log('  static blob size KB:', (json.length / 1024).toFixed(0), ' shape omitted on', JSON.parse(json).pieces.filter((p: any) => p.shape === undefined).length, 'pieces');
    let pjson = '';
    bench('serializeProgress + JSON.stringify (mid)', () => { pjson = JSON.stringify(serializeProgress(mid, [], undefined as any)); }, 100);
    console.log('  progress blob size KB:', (pjson.length / 1024).toFixed(1));
    bench('restore: JSON.parse(static)+recombine', () => recombine(JSON.parse(json), JSON.parse(pjson)), 20);
    let comp = '';
    bench('lz compressForStorage(static) [quota fallback only]', () => { comp = compressForStorage(json); }, 3);
    console.log('  compressed chars:', comp.length, '(UTF-16 => bytes x2)');
    bench('lz decompressFromStorage(static)', () => decompressFromStorage(comp), 3);
}
