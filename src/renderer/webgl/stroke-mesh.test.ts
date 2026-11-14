import { describe, test, expect } from 'vitest';
import { buildStrokeMesh, simplifyPolyline, type StrokeMesh } from './stroke-mesh.js';
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
