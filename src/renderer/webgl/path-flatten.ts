import type { Point } from '../../model/types.js';

const MAX_STEPS = 64;
const CLOSE_EPSILON = 1e-9;

const ARG_COUNTS: Record<string, number> = {
    M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

interface Segment {
    command: string;
    args: number[];
}

function parseSegments(d: string): Segment[] {
    const segments: Segment[] = [];
    let i = 0;
    const skipSeparators = (): void => {
        while (i < d.length && /[\s,]/.test(d[i])) i++;
    };
    function fail(reason: string): never {
        throw new Error(`${reason} at ${i}: ${d.slice(i, i + 10)}`);
    }
    const readNumber = (): number => {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(d);
        if (!m) fail('Invalid path data');
        i = NUMBER.lastIndex;
        return Number(m[0]);
    };
    const readFlag = (): number => {
        const c = d[i];
        if (c !== '0' && c !== '1') fail('Invalid arc flag');
        i++;
        return Number(c);
    };

    let command = '';
    while (true) {
        skipSeparators();
        if (i >= d.length) break;
        const c = d[i];
        if (/[A-Za-z]/.test(c)) {
            if (!(c.toUpperCase() in ARG_COUNTS)) fail(`Unknown path command ${c}`);
            command = c;
            i++;
            if (c === 'Z' || c === 'z') {
                segments.push({ command: c, args: [] });
                continue;
            }
        } else if (command === '' || command === 'Z' || command === 'z') {
            fail('Invalid path data');
        }
        const upper = command.toUpperCase();
        const args: number[] = [];
        for (let k = 0; k < ARG_COUNTS[upper]; k++) {
            skipSeparators();
            args.push(upper === 'A' && (k === 3 || k === 4) ? readFlag() : readNumber());
        }
        segments.push({ command, args });
        // Implicit repeats after M/m are line-tos.
        if (command === 'M') command = 'L';
        else if (command === 'm') command = 'l';
    }
    return segments;
}

function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function stepsFor(length: number, tolerance: number): number {
    return Math.min(MAX_STEPS, Math.max(1, Math.ceil(Math.sqrt(length / tolerance))));
}

function comesBefore(a: Point, b: Point): boolean {
    return a.x !== b.x ? a.x < b.x : a.y < b.y;
}

function samePoint(a: Point, b: Point): boolean {
    return a.x === b.x && a.y === b.y;
}

function cubicInterior(p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number): Point[] {
    const length = dist(p0, p3) + ((dist(p0, p1) + dist(p2, p3)) + dist(p1, p2));
    const n = stepsFor(length, tolerance);
    const points: Point[] = [];
    for (let i = 1; i < n; i++) {
        const t = i / n;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const e = t * t * t;
        points.push({
            x: a * p0.x + b * p1.x + c * p2.x + e * p3.x,
            y: a * p0.y + b * p1.y + c * p2.y + e * p3.y,
        });
    }
    return points;
}

// Evaluated in a canonical direction so a mate edge traversed in reverse produces bit-identical
// vertices; fills of neighboring pieces stay watertight.
function flattenCubic(out: Point[], p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number): void {
    const reversed = samePoint(p0, p3) ? comesBefore(p2, p1) : comesBefore(p3, p0);
    const interior = reversed
        ? cubicInterior(p3, p2, p1, p0, tolerance).reverse()
        : cubicInterior(p0, p1, p2, p3, tolerance);
    for (const p of interior) out.push(p);
    out.push({ x: p3.x, y: p3.y });
}

function quadraticToCubic(p0: Point, q: Point, p3: Point): [Point, Point] {
    return [
        { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
        { x: p3.x + (2 / 3) * (q.x - p3.x), y: p3.y + (2 / 3) * (q.y - p3.y) },
    ];
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
    return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

// SVG 1.1 implementation notes F.6.5 (endpoint to center) and F.6.6 (radius scaling).
function arcInterior(
    from: Point,
    rxIn: number,
    ryIn: number,
    rotationDeg: number,
    largeArc: number,
    sweep: number,
    to: Point,
    tolerance: number,
): Point[] {
    let rx = Math.abs(rxIn);
    let ry = Math.abs(ryIn);
    const phi = (rotationDeg * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const dx = (from.x - to.x) / 2;
    const dy = (from.y - to.y) / 2;
    const x1p = cosPhi * dx + sinPhi * dy;
    const y1p = -sinPhi * dx + cosPhi * dy;

    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s;
        ry *= s;
    }

    const rx2 = rx * rx;
    const ry2 = ry * ry;
    const denom = rx2 * y1p * y1p + ry2 * x1p * x1p;
    const sign = largeArc === sweep ? -1 : 1;
    const coef = denom === 0 ? 0 : sign * Math.sqrt(Math.max(0, (rx2 * ry2 - denom) / denom));
    const cxp = (coef * rx * y1p) / ry;
    const cyp = (-coef * ry * x1p) / rx;
    const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

    const ux = (x1p - cxp) / rx;
    const uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx;
    const vy = (-y1p - cyp) / ry;
    const theta1 = vectorAngle(1, 0, ux, uy);
    let delta = vectorAngle(ux, uy, vx, vy);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    else if (sweep && delta < 0) delta += 2 * Math.PI;

    const n = stepsFor(Math.max(rx, ry) * Math.abs(delta), tolerance);
    const points: Point[] = [];
    for (let i = 1; i < n; i++) {
        const theta = theta1 + (delta * i) / n;
        const ex = rx * Math.cos(theta);
        const ey = ry * Math.sin(theta);
        points.push({
            x: cosPhi * ex - sinPhi * ey + cx,
            y: sinPhi * ex + cosPhi * ey + cy,
        });
    }
    return points;
}

function flattenArc(
    out: Point[],
    from: Point,
    rx: number,
    ry: number,
    rotationDeg: number,
    largeArc: number,
    sweep: number,
    to: Point,
    tolerance: number,
): void {
    if (samePoint(from, to)) return;
    if (rx === 0 || ry === 0) {
        out.push({ x: to.x, y: to.y });
        return;
    }
    const interior = comesBefore(to, from)
        ? arcInterior(to, rx, ry, rotationDeg, largeArc, 1 - sweep, from, tolerance).reverse()
        : arcInterior(from, rx, ry, rotationDeg, largeArc, sweep, to, tolerance);
    for (const p of interior) out.push(p);
    out.push({ x: to.x, y: to.y });
}

export function flattenPath(d: string, tolerance: number): Point[][] {
    const loops: Point[][] = [];
    let current: Point[] = [];
    let cur: Point = { x: 0, y: 0 };
    let start: Point = { x: 0, y: 0 };
    let prevCubicCtrl: Point | null = null;
    let prevQuadCtrl: Point | null = null;

    const flush = (closed: boolean): void => {
        if (closed && current.length > 1) {
            const first = current[0];
            const last = current[current.length - 1];
            if (Math.abs(first.x - last.x) < CLOSE_EPSILON && Math.abs(first.y - last.y) < CLOSE_EPSILON) {
                current.pop();
            }
        }
        if (current.length > 1) loops.push(current);
        current = [];
    };
    const ensureStarted = (): void => {
        if (current.length === 0) current.push({ x: cur.x, y: cur.y });
    };

    for (const { command, args } of parseSegments(d)) {
        const rel = command === command.toLowerCase();
        const ox = rel ? cur.x : 0;
        const oy = rel ? cur.y : 0;
        let nextCubic: Point | null = null;
        let nextQuad: Point | null = null;

        switch (command.toUpperCase()) {
            case 'M':
                flush(false);
                cur = { x: args[0] + ox, y: args[1] + oy };
                start = cur;
                current.push({ x: cur.x, y: cur.y });
                break;
            case 'L':
                ensureStarted();
                cur = { x: args[0] + ox, y: args[1] + oy };
                current.push({ x: cur.x, y: cur.y });
                break;
            case 'H':
                ensureStarted();
                cur = { x: args[0] + ox, y: cur.y };
                current.push({ x: cur.x, y: cur.y });
                break;
            case 'V':
                ensureStarted();
                cur = { x: cur.x, y: args[0] + oy };
                current.push({ x: cur.x, y: cur.y });
                break;
            case 'C':
            case 'S': {
                ensureStarted();
                const isS = command.toUpperCase() === 'S';
                const c1: Point = isS
                    ? (prevCubicCtrl ? { x: 2 * cur.x - prevCubicCtrl.x, y: 2 * cur.y - prevCubicCtrl.y } : cur)
                    : { x: args[0] + ox, y: args[1] + oy };
                const o = isS ? 0 : 2;
                const c2 = { x: args[o] + ox, y: args[o + 1] + oy };
                const end = { x: args[o + 2] + ox, y: args[o + 3] + oy };
                flattenCubic(current, cur, c1, c2, end, tolerance);
                nextCubic = c2;
                cur = end;
                break;
            }
            case 'Q':
            case 'T': {
                ensureStarted();
                const isT = command.toUpperCase() === 'T';
                const q: Point = isT
                    ? (prevQuadCtrl ? { x: 2 * cur.x - prevQuadCtrl.x, y: 2 * cur.y - prevQuadCtrl.y } : cur)
                    : { x: args[0] + ox, y: args[1] + oy };
                const o = isT ? 0 : 2;
                const end = { x: args[o] + ox, y: args[o + 1] + oy };
                const [c1, c2] = quadraticToCubic(cur, q, end);
                flattenCubic(current, cur, c1, c2, end, tolerance);
                nextQuad = q;
                cur = end;
                break;
            }
            case 'A': {
                ensureStarted();
                const end = { x: args[5] + ox, y: args[6] + oy };
                flattenArc(current, cur, args[0], args[1], args[2], args[3], args[4], end, tolerance);
                cur = end;
                break;
            }
            case 'Z':
                flush(true);
                cur = start;
                break;
        }
        prevCubicCtrl = nextCubic;
        prevQuadCtrl = nextQuad;
    }
    flush(false);
    return loops;
}
