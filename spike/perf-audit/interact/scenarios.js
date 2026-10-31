const L = require('./lib.js');

/** Read static/progress blobs, piece grid coords. */
async function readSave(page) {
    return page.evaluate(() => {
        const st = JSON.parse(localStorage.getItem('puzzle-game-state'));
        const pr = JSON.parse(localStorage.getItem('puzzle-progress'));
        return { st, pr };
    });
}

function gridOf(st) {
    const pw = st.imageSize.width / st.gridSize.cols;
    const ph = st.imageSize.height / st.gridSize.rows;
    const map = new Map();
    for (const p of st.pieces) {
        map.set(p.id, { col: Math.round(-p.imageOffset.x / pw), row: Math.round(-p.imageOffset.y / ph), imageOffset: p.imageOffset });
    }
    return { pw, ph, map };
}

const VIEWPORT = { scale: 0.25, offset: { x: 10, y: 120 } };

/** Build a progress blob. bigIds go in one group at (0,0); others are singles laid on a grid to the right/below. */
function buildProgress(st, pr, { bigIds = [], singlesArea = 'right', selection, viewport = VIEWPORT, singlesOverride }) {
    const g = gridOf(st);
    const big = new Set(bigIds);
    const groups = [];
    let nextId = 0;
    if (bigIds.length) {
        groups.push({
            id: nextId++, position: { x: 0, y: 0 }, rotation: 0,
            pieces: bigIds.map((id) => [id, { x: -g.map.get(id).imageOffset.x, y: -g.map.get(id).imageOffset.y }]),
        });
    }
    const singles = st.pieces.map((p) => p.id).filter((id) => !big.has(id));
    singles.forEach((id, i) => {
        let pos;
        if (singlesOverride) pos = singlesOverride(i, id, g);
        else {
            const perCol = 9;
            pos = { x: 1150 + (i % 3) * 150, y: Math.floor(i / 3) * 200 };
            void perCol;
        }
        groups.push({ id: nextId++, position: pos, rotation: 0, pieces: [[id, { x: 0, y: 0 }]] });
    });
    const out = { version: pr.version, seed: pr.seed, groups, completed: false, viewport };
    if (selection) out.selection = selection(groups);
    return out;
}

async function installProgress(page, progress) {
    await page.evaluate((p) => {
        localStorage.setItem('puzzle-progress', JSON.stringify(p));
        localStorage.setItem('puzzle-offset-drag', 'false');
    }, progress);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction((n) => document.querySelectorAll('[data-group-id]').length === n, progress.groups.length, { timeout: 60000 });
    await page.waitForTimeout(1500);
}

/** Screen position of a piece's local origin. */
async function pieceOriginScreen(page, pieceId) {
    return page.evaluate((id) => {
        const svg = document.querySelector(`svg[data-piece-id="${id}"]`);
        const r = svg.getBoundingClientRect();
        const table = document.querySelector('[data-puzzle-table]');
        const m = new DOMMatrix(getComputedStyle(table).transform);
        return { x: r.left + 30 * m.a, y: r.top + 30 * m.a, scale: m.a };
    }, pieceId);
}

async function preciseDrag(cdp, from, delta, steps, frameMs = 16) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    await L.sleep(frameMs);
    const s = { x: from.x + 10, y: from.y };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: s.x, y: s.y, id: 1 }] });
    await L.sleep(frameMs);
    for (let i = 1; i <= steps; i++) {
        const x = s.x + delta.x * i / steps, y = s.y + delta.y * i / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
        await L.sleep(frameMs);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

module.exports = { readSave, gridOf, buildProgress, installProgress, pieceOriginScreen, preciseDrag, VIEWPORT };
