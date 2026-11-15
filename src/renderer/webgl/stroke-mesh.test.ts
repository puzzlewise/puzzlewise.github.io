import { describe, test, expect } from 'vitest';
import { buildStrokeMesh, type IndexRange, simplifyPolyline, type StrokeCorner, type StrokeMesh } from './stroke-mesh.js';
import type { Point } from '../../model/types.js';

const SIMPLIFY = 0.0125;

interface Vertex {
    cx: number;
    cy: number;
    nx: number;
    ny: number;
    side: number;
}

function vertices(mesh: StrokeMesh): Vertex[] {
    const out: Vertex[] = [];
    for (let i = 0; i < mesh.sides.length; i++) {
        out.push({
            cx: mesh.centers[2 * i],
            cy: mesh.centers[2 * i + 1],
            nx: mesh.normals[2 * i],
            ny: mesh.normals[2 * i + 1],
            side: mesh.sides[i],
        });
    }
    return out;
}

function offset(v: Vertex): [number, number] {
    return [v.nx * v.side, v.ny * v.side];
}

function arcPoints(radius: number, count: number): Point[] {
    return Array.from({ length: count }, (_, k) => {
        const angle = (k / (count - 1)) * (Math.PI / 2);
        return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    });
}

type Triangle = [number, number, number, number, number, number];

function trianglesOf(mesh: StrokeMesh, halfWidth: number): Triangle[] {
    const at = (i: number): [number, number] => [
        mesh.centers[2 * i] + mesh.normals[2 * i] * mesh.sides[i] * halfWidth,
        mesh.centers[2 * i + 1] + mesh.normals[2 * i + 1] * mesh.sides[i] * halfWidth,
    ];
    const out: Triangle[] = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
        out.push([...at(mesh.indices[i]), ...at(mesh.indices[i + 1]), ...at(mesh.indices[i + 2])]);
    }
    return out;
}

function insideTriangle([ax, ay, bx, by, cx, cy]: Triangle, x: number, y: number): boolean {
    const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
    const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
    return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

describe('buildStrokeMesh', () => {
    test('straight segment gives a quad whose sides are ±1', () => {
        const mesh = buildStrokeMesh(
            [{ x: 0, y: 0 }, { x: 10, y: 0 }],
            false,
            1,
        );
        const quad = vertices(mesh).slice(0, 4);
        const atStart = quad.filter((v) => v.cx === 0);
        expect(atStart.map((v) => v.side).sort((a, b) => a - b)).toEqual([-1, 1]);
        for (const v of quad) {
            expect(Math.abs(offset(v)[1])).toBeCloseTo(1);
            expect(v.cy).toBe(0);
        }
    });

    test('interiorSide flips which side is −1', () => {
        const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
        for (const interiorSide of [1, -1] as const) {
            const mesh = buildStrokeMesh(line, false, interiorSide);
            for (const v of vertices(mesh)) {
                const [, oy] = offset(v);
                if (v.side === 0 || Math.abs(oy) < 0.5) continue;
                expect(v.side).toBe(oy * interiorSide > 0 ? -1 : 1);
            }
        }
    });

    test('a 90° corner adds round-join fan vertices whose normals sweep the outer angle', () => {
        const mesh = buildStrokeMesh(
            [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
            false,
            1,
        );
        const atCorner = vertices(mesh).filter(
            (v) => v.cx === 10 && v.cy === 0 && v.side !== 0,
        );
        const offsets = atCorner.map(offset);
        const outerAngles = offsets
            .filter(([x, y]) => x > 1e-6 && y < -1e-6)
            .map(([x, y]) => Math.atan2(y, x));
        expect(outerAngles.length).toBeGreaterThanOrEqual(1);
        const hasDiagonal = offsets.some(
            ([x, y]) => Math.abs(x - Math.SQRT1_2) < 1e-6 && Math.abs(y + Math.SQRT1_2) < 1e-6,
        );
        expect(hasDiagonal).toBe(true);
        const fan = atCorner.filter(
            (v) => offset(v)[0] > 1e-6 && offset(v)[1] < 1e-6 && v.side === 1,
        );
        expect(fan.length).toBeGreaterThanOrEqual(3);
    });

    test('open polyline gets round caps at both ends', () => {
        const mesh = buildStrokeMesh(
            [{ x: 0, y: 0 }, { x: 10, y: 0 }],
            false,
            1,
        );
        const vs = vertices(mesh);
        const tipLeft = vs.some((v) => v.cx === 0 && offset(v)[0] < -0.99);
        const tipRight = vs.some((v) => v.cx === 10 && offset(v)[0] > 0.99);
        expect(tipLeft).toBe(true);
        expect(tipRight).toBe(true);
    });

    test('normals are unit at caps and round joins and 1/cos(turn/2) at mitred joints', () => {
        const bend = (10 * Math.PI) / 180;
        const b = { x: 10, y: 0 };
        const c = { x: b.x + 10 * Math.cos(bend), y: 10 * Math.sin(bend) };
        const d = { x: c.x + 10 * Math.cos(bend + Math.PI / 2), y: c.y + 10 * Math.sin(bend + Math.PI / 2) };
        const mesh = buildStrokeMesh([{ x: 0, y: 0 }, b, c, d], false, 1);
        expect(mesh.indices.length % 3).toBe(0);
        const rim = vertices(mesh).filter((v) => v.side !== 0);
        const atB = rim.filter((v) => Math.abs(v.cx - b.x) < 1e-6 && Math.abs(v.cy - b.y) < 1e-6);
        expect(atB).toHaveLength(2);
        const exteriors = [[0, -1], [Math.sin(bend), -Math.cos(bend)]];
        for (const v of atB) {
            expect(Math.hypot(v.nx, v.ny)).toBeCloseTo(1 / Math.cos(bend / 2), 5);
            for (const [ex, ey] of exteriors) {
                expect(offset(v)[0] * ex + offset(v)[1] * ey).toBeCloseTo(v.side, 5);
            }
        }
        for (const v of rim) {
            if (atB.includes(v)) continue;
            expect(Math.hypot(v.nx, v.ny)).toBeCloseTo(1, 5);
        }

        const triangle = buildStrokeMesh([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }], true, -1);
        for (const v of vertices(triangle)) {
            expect(Math.hypot(v.nx, v.ny)).toBeCloseTo(1, 5);
        }
    });

    test('the cap ranges hold exactly the fans around the first and last points', () => {
        const mesh = buildStrokeMesh([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, 1);
        const hubs = (indices: Uint32Array) => new Set(Array.from(indices)
            .filter((v) => mesh.sides[v] === 0)
            .map((v) => `${mesh.centers[2 * v]},${mesh.centers[2 * v + 1]}`));
        const within = (i: number, r: IndexRange) => i >= r.offset && i < r.offset + r.count;
        const range = (r: IndexRange) => mesh.indices.filter((_, i) => within(i, r));
        const rest = mesh.indices.filter((_, i) => !within(i, mesh.startCap) && !within(i, mesh.endCap));

        expect(hubs(range(mesh.startCap))).toEqual(new Set(['0,0']));
        expect(hubs(range(mesh.endCap))).toEqual(new Set(['10,10']));
        expect(hubs(rest)).toEqual(new Set(['10,0']));
    });

    test('a closed stroke has no caps', () => {
        const mesh = buildStrokeMesh([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }], true, 1);

        expect(mesh.startCap.count).toBe(0);
        expect(mesh.endCap.count).toBe(0);
    });

    test('a gently curving 95-point polyline mitres every joint and simplifies to a fraction of the vertices', () => {
        const arc = arcPoints(50, 95);
        const mitred = buildStrokeMesh(arc, false, 1);
        expect(vertices(mitred).filter((v) => v.side === 0)).toHaveLength(4);
        expect(mitred.sides.length).toBe(95 * 2 + 32);
        const simplified = buildStrokeMesh(simplifyPolyline(arc, SIMPLIFY), false, 1);
        expect(simplified.sides.length).toBeLessThanOrEqual(160);
    });

    test('a simplified mitred stroke stays within tolerance of the true offset curves', () => {
        const radius = 50;
        const halfWidth = 1.5;
        const margin = 2 * SIMPLIFY;
        const mesh = buildStrokeMesh(simplifyPolyline(arcPoints(radius, 95), SIMPLIFY), false, 1);
        const triangles = trianglesOf(mesh, halfWidth);
        const covered = (x: number, y: number): boolean => triangles.some((t) => insideTriangle(t, x, y));
        for (let k = 0; k <= 200; k++) {
            const angle = ((3 + (84 * k) / 200) * Math.PI) / 180;
            const at = (r: number): [number, number] => [r * Math.cos(angle), r * Math.sin(angle)];
            expect(covered(...at(radius + halfWidth - margin))).toBe(true);
            expect(covered(...at(radius - halfWidth + margin))).toBe(true);
            expect(covered(...at(radius + halfWidth + margin))).toBe(false);
            expect(covered(...at(radius - halfWidth - margin))).toBe(false);
        }
    });

    test('mitred joints keep side -1 on the interior and +1 on the exterior', () => {
        const polygon = Array.from({ length: 36 }, (_, k) => ({
            x: 20 * Math.cos((k * Math.PI) / 18),
            y: 20 * Math.sin((k * Math.PI) / 18),
        }));
        for (const interiorSide of [1, -1] as const) {
            const mesh = buildStrokeMesh(polygon, true, interiorSide);
            const rim = vertices(mesh);
            expect(rim).toHaveLength(72);
            for (const v of rim) {
                expect(Math.hypot(v.nx, v.ny)).toBeCloseTo(1 / Math.cos(Math.PI / 36), 5);
                const [ox, oy] = offset(v);
                const inside = Math.hypot(v.cx + ox * 0.5, v.cy + oy * 0.5) < 19.9;
                expect(v.side).toBe((interiorSide === 1) === inside ? -1 : 1);
            }
        }
    });

    test('inward-turning join fans carry side -1 and outward ones +1', () => {
        const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
        for (const interiorSide of [1, -1] as const) {
            const mesh = buildStrokeMesh(square, true, interiorSide);
            const interiorIsInside = interiorSide === 1;
            for (const v of vertices(mesh)) {
                if (v.side === 0) continue;
                const [ox, oy] = offset(v);
                const px = v.cx + ox * 0.5 + (5 - v.cx) * 0.01;
                const py = v.cy + oy * 0.5 + (5 - v.cy) * 0.01;
                const inside = px > 0 && px < 10 && py > 0 && py < 10;
                expect(v.side).toBe(interiorIsInside === inside ? -1 : 1);
            }
        }
    });
});

describe('buildStrokeMesh inner tails', () => {
    const HALF_WIDTH = 1.5;
    const EPS = 1e-6;
    const dir = (degrees: number): Point => ({
        x: Math.cos((degrees * Math.PI) / 180),
        y: Math.sin((degrees * Math.PI) / 180),
    });
    // A straight neighbor edge leaving `at`; the piece lies between it and the stroke's own edge.
    function corner(own: number, neighbor: number, at: Point = { x: 0, y: 0 }): StrokeCorner {
        const o = dir(own);
        const n = dir(neighbor);
        return {
            own: o,
            neighbor: n,
            neighborPath: [at, { x: at.x + 40 * n.x, y: at.y + 40 * n.y }],
            neighborInteriorSide: n.x * o.y - n.y * o.x >= 0 ? 1 : -1,
        };
    }

    // The piece boundary along a straight neighbor edge leaving p at `degrees`; positive inside.
    interface Boundary { p: Point; hx: number; hy: number }

    function boundary(p: Point, degrees: number, inside: Point): Boundary {
        const { x, y } = dir(degrees);
        const sign = Math.sign((inside.x - p.x) * -y + (inside.y - p.y) * x);
        return { p, hx: -y * sign, hy: x * sign };
    }

    const signed = ({ p, hx, hy }: Boundary, x: number, y: number): number => (x - p.x) * hx + (y - p.y) * hy;

    function trianglesFrom(mesh: StrokeMesh, indices: ArrayLike<number>, halfWidth: number): Triangle[] {
        const at = (i: number): [number, number] => [
            mesh.centers[2 * i] + mesh.normals[2 * i] * mesh.sides[i] * halfWidth,
            mesh.centers[2 * i + 1] + mesh.normals[2 * i + 1] * mesh.sides[i] * halfWidth,
        ];
        const out: Triangle[] = [];
        for (let i = 0; i < indices.length; i += 3) {
            out.push([...at(indices[i]), ...at(indices[i + 1]), ...at(indices[i + 2])]);
        }
        return out;
    }

    function band(mesh: StrokeMesh): number[] {
        const caps = [mesh.startCap, mesh.endCap];
        return Array.from(mesh.indices).filter((_, i) => !caps.some((r) => i >= r.offset && i < r.offset + r.count));
    }

    function body(mesh: StrokeMesh): number[] {
        const tailAndCaps = [...mesh.tail, mesh.startCap, mesh.endCap];
        return Array.from(mesh.indices)
            .filter((_, i) => !tailAndCaps.some((r) => i >= r.offset && i < r.offset + r.count));
    }

    const covers = (triangles: Triangle[], x: number, y: number): boolean =>
        triangles.some((t) => insideTriangle(t, x, y));

    function shrunkCorners([ax, ay, bx, by, cx, cy]: Triangle): [number, number][] {
        const mx = (ax + bx + cx) / 3;
        const my = (ay + by + cy) / 3;
        return [[ax, ay], [bx, by], [cx, cy]].map(([x, y]) => [x + (mx - x) * EPS, y + (my - y) * EPS]);
    }

    // Every inner-tail triangle lies inside the piece and inside the unclipped band, and no
    // interior vertex left in the body lies outside the piece.
    function expectClippedWithinBand(mesh: StrokeMesh, tail: Uint32Array, boundaries: Boundary[]): void {
        expect(tail.length).toBeGreaterThan(0);
        const unclipped = trianglesFrom(mesh, band(mesh), HALF_WIDTH);
        for (const triangle of trianglesFrom(mesh, tail, HALF_WIDTH)) {
            for (const [x, y] of shrunkCorners(triangle)) {
                for (const b of boundaries) expect(signed(b, x, y)).toBeGreaterThan(-EPS);
                expect(covers(unclipped, x, y)).toBe(true);
            }
        }
        for (const i of body(mesh)) {
            if (mesh.sides[i] !== -1) continue;
            const x = mesh.centers[2 * i] - mesh.normals[2 * i] * HALF_WIDTH;
            const y = mesh.centers[2 * i + 1] - mesh.normals[2 * i + 1] * HALF_WIDTH;
            for (const b of boundaries) expect(signed(b, x, y)).toBeGreaterThan(-EPS);
        }
    }

    // Samples the interior half-band of every segment; every sample inside the piece must stay drawn.
    function expectInsideHalfCovered(
        mesh: StrokeMesh,
        polyline: Point[],
        interiorSide: 1 | -1,
        tail: Uint32Array,
        boundaries: Boundary[],
    ): void {
        const drawn = trianglesFrom(mesh, [...body(mesh), ...tail], HALF_WIDTH);
        let checked = 0;
        const expectCovered = (x: number, y: number): void => {
            if (boundaries.some((b) => signed(b, x, y) < 0.01)) return;
            checked++;
            expect(covers(drawn, x, y)).toBe(true);
        };
        const interiorNormal = (a: Point, b: Point): Point => {
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            return { x: (-interiorSide * (b.y - a.y)) / length, y: (interiorSide * (b.x - a.x)) / length };
        };
        const depths = [0.1, 0.5, 1, 1.4];
        for (let i = 0; i + 1 < polyline.length; i++) {
            const a = polyline[i];
            const b = polyline[i + 1];
            const m = interiorNormal(a, b);
            for (let s = 1; s < 20; s++) {
                for (const depth of depths) {
                    expectCovered(a.x + ((b.x - a.x) * s) / 20 + m.x * depth, a.y + ((b.y - a.y) * s) / 20 + m.y * depth);
                }
            }
            if (i === 0) continue;
            const before = interiorNormal(polyline[i - 1], a);
            for (const blend of [0.25, 0.5, 0.75]) {
                const x = before.x + (m.x - before.x) * blend;
                const y = before.y + (m.y - before.y) * blend;
                const length = Math.hypot(x, y);
                for (const depth of depths) expectCovered(a.x + (x / length) * depth, a.y + (y / length) * depth);
            }
        }
        expect(checked).toBeGreaterThan(0);
    }

    test.each([26, 40, 75])('a %i° convex end clips its interior half where it leaves the piece', (angle) => {
        const p = { x: 0, y: 0 };
        const polyline = [{ x: 30, y: 0 }, p];
        const mesh = buildStrokeMesh(polyline, false, -1, { end: corner(0, angle) });
        const piece = boundary(p, angle, { x: 30, y: 0.1 });

        expectClippedWithinBand(mesh, mesh.endInnerTail, [piece]);
        expectInsideHalfCovered(mesh, polyline, -1, mesh.endInnerTail, [piece]);
        expect(mesh.startInnerTail).toHaveLength(0);
        expect(mesh.bothInnerTails).toHaveLength(0);
    });

    test('clip points stay on the neighbor edge at extents other than the reference one', () => {
        const p = { x: 0, y: 0 };
        const mesh = buildStrokeMesh([{ x: 30, y: 0 }, p], false, -1, { end: corner(0, 40) });
        const piece = boundary(p, 40, { x: 30, y: 0.1 });
        const position = (i: number, halfWidth: number): [number, number] => [
            mesh.centers[2 * i] + mesh.normals[2 * i] * mesh.sides[i] * halfWidth,
            mesh.centers[2 * i + 1] + mesh.normals[2 * i + 1] * mesh.sides[i] * halfWidth,
        ];
        const onEdge = [...new Set(mesh.endInnerTail)]
            .filter((i) => Math.abs(signed(piece, ...position(i, HALF_WIDTH))) < EPS);
        expect(onEdge.some((i) => mesh.sides[i] === -1)).toBe(true);

        for (const halfWidth of [0.25, 1, 3, 6]) {
            for (const i of onEdge) expect(Math.abs(signed(piece, ...position(i, halfWidth)))).toBeLessThan(EPS);
        }
    });

    test.each([
        ['mitred', 4],
        ['mitred, bending toward the neighbor', -4],
        ['round-joined', 20],
        ['round-joined, bending toward the neighbor', -16],
    ])('a tail over several short %s segments is clipped and keeps the rest of its half', (_, bend) => {
        const p = { x: 0, y: 0 };
        const outward = [p];
        for (let k = 0; k < 4; k++) {
            const last = outward[outward.length - 1];
            const step = dir(-bend * k);
            outward.push({ x: last.x + 0.8 * step.x, y: last.y + 0.8 * step.y });
        }
        const last = outward[outward.length - 1];
        outward.push({ x: last.x + 10, y: last.y });
        const polyline = outward.reverse();
        const mesh = buildStrokeMesh(polyline, false, -1, { end: corner(0, 60) });
        const piece = boundary(p, 60, { x: 30, y: 0 });

        expectClippedWithinBand(mesh, mesh.endInnerTail, [piece]);
        expectInsideHalfCovered(mesh, polyline, -1, mesh.endInnerTail, [piece]);
    });

    test('a bulge past the first segment that lies fully inside the piece is not clipped', () => {
        const polyline = [
            { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 },
            { x: 20, y: 30 }, { x: 24, y: 30 }, { x: 24, y: 0 }, { x: 40, y: 0 },
        ];
        const mesh = buildStrokeMesh(polyline, false, 1, { start: corner(0, 40) });
        const position = (i: number): number => mesh.centers[2 * i + 1] + mesh.normals[2 * i + 1] * mesh.sides[i] * HALF_WIDTH;

        expect(mesh.startInnerTail.length).toBeGreaterThan(0);
        expect(Math.max(...Array.from(mesh.startInnerTail, position))).toBeLessThan(2);
        const inTail = (t: number) => mesh.tail.some((r) => t >= r.offset && t < r.offset + r.count);
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const high = [0, 1, 2].some((k) => position(mesh.indices[t + k]) > 2);
            if (high) expect(inTail(t)).toBe(false);
        }
    });

    test('along a sliver narrower than the stroke, the cut stays within reach of the corner', () => {
        const polyline = [{ x: 0, y: 0 }, ...Array.from({ length: 8 }, (_, k) => ({ x: 5 + 5 * k, y: -1 }))];
        const own = Math.atan2(-1, 5) * (180 / Math.PI);
        const mesh = buildStrokeMesh(polyline, false, 1, { start: corner(own, 0) });
        const x = (i: number): number => mesh.centers[2 * i] + mesh.normals[2 * i] * mesh.sides[i] * HALF_WIDTH;

        expect(mesh.startInnerTail.length).toBeGreaterThan(0);
        expect(Math.max(...Array.from(mesh.startInnerTail, x))).toBeLessThan(11);
        const inTail = (t: number) => mesh.tail.some((r) => t >= r.offset && t < r.offset + r.count);
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const far = [0, 1, 2].every((k) => x(mesh.indices[t + k]) > 11);
            if (far) expect(inTail(t)).toBe(false);
        }
    });

    test.each([
        ['a 90° corner', corner(0, 90)],
        ['an 89.5° corner, as square ones may measure', corner(0, 89.5)],
        ['an obtuse corner', corner(0, 120)],
        ['a 0° corner, folded back onto the edge', corner(0, 0)],
    ])('%s gets no tail and no extra vertices', (_, neighbors) => {
        const polyline = [{ x: 30, y: 0 }, { x: 0, y: 0 }];
        const plain = buildStrokeMesh(polyline, false, -1);
        const mesh = buildStrokeMesh(polyline, false, -1, { end: neighbors });

        expect(mesh.tail).toEqual([]);
        expect(mesh.endInnerTail).toHaveLength(0);
        expect(mesh.sides.length).toBe(plain.sides.length);
        expect(Array.from(mesh.indices)).toEqual(Array.from(plain.indices));
    });

    test('a segment both of whose ends are acute is clipped at either end or both', () => {
        const start = { x: 0, y: 0 };
        const end = { x: 30, y: 0 };
        const polyline = [start, end];
        const mesh = buildStrokeMesh(polyline, false, 1, { start: corner(0, 40), end: corner(180, 140, end) });
        const inside = { x: 15, y: 1 };
        const startSide = boundary(start, 40, inside);
        const endSide = boundary(end, 140, inside);

        expectClippedWithinBand(mesh, mesh.startInnerTail, [startSide]);
        expectClippedWithinBand(mesh, mesh.endInnerTail, [endSide]);
        expectClippedWithinBand(mesh, mesh.bothInnerTails, [startSide, endSide]);
        expectInsideHalfCovered(mesh, polyline, 1, mesh.startInnerTail, [startSide]);
        expectInsideHalfCovered(mesh, polyline, 1, mesh.endInnerTail, [endSide]);
        expectInsideHalfCovered(mesh, polyline, 1, mesh.bothInnerTails, [startSide, endSide]);
        expect(body(mesh)).toEqual([]);
    });
});
