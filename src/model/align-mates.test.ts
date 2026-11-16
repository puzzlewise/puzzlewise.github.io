import { describe, it, expect } from 'vitest';
import { alignLegacyGroupOffsets, alignLegacyMates, alignMatePaths } from './align-mates.js';
import { buildShape } from './build-shape.js';
import { deriveMatePath, parseEdgePath } from './edge-path.js';
import type { Edge, GeneratedEdge, GeneratedPiece, Piece, PieceGroup, Point } from './types.js';
import { v11UnroundedGridBlob, v13GridBlob } from '../test-helpers/v13-save.js';

function edge(
    id: number,
    mateEdgeId: number,
    matePieceId: number,
    path: string,
    start: Point,
    end: Point,
): GeneratedEdge {
    return { id, mateEdgeId, matePieceId, path, start, end };
}

function piece(id: number, imageOffset: Point, edges: GeneratedEdge[]): GeneratedPiece {
    return { id, imageOffset, edges, shape: 'stale' };
}

function makePieces(): GeneratedPiece[] {
    return [
        piece(0, { x: 0, y: 0 }, [
            edge(1, 2, 1, 'C 70 10, 70 40, 64.34 50', { x: 64.33, y: 0 }, { x: 64.33, y: 50 }),
            edge(3, -1, -1, 'L 0 50.01', { x: 64.33, y: 50 }, { x: 0, y: 50 }),
            edge(4, -1, -1, 'Q 1 2 3 4', { x: 0, y: 50 }, { x: 64.33, y: 0 }),
        ]),
        piece(1, { x: -64.33, y: 0 }, [
            edge(2, 1, 0, 'C 5.68 40, 5.67 10, 0 0', { x: 0, y: 50 }, { x: 0, y: 0 }),
        ]),
        piece(2, { x: -10.5, y: -20.25 }, [
            edge(6, 5, 2, 'A 5 5 0 0,1 0.01 0', { x: 10, y: 0 }, { x: 0, y: 0 }),
            edge(5, 6, 2, 'A 5 5 0 0,1 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
        ]),
        piece(3, { x: 0, y: 0 }, [
            edge(10, 11, 4, 'L 5 5', { x: 0, y: 0 }, { x: 5, y: 5 }),
            edge(20, 21, 4, 'Q 1 2 3 4', { x: 5, y: 5 }, { x: 0, y: 0 }),
        ]),
        piece(4, { x: 0, y: 0 }, [
            edge(11, 99, 3, 'L 2 3 L 0.01 0', { x: 5, y: 5 }, { x: 0, y: 0 }),
            edge(21, 20, 3, 'L 2 2 L 5.01 5', { x: 0, y: 0 }, { x: 5, y: 5 }),
        ]),
    ];
}

function pathOf(pieces: GeneratedPiece[], edgeId: number): string {
    const found = pieces.flatMap((p) => p.edges).find((e) => e.id === edgeId);
    if (!found) throw new Error(`edge ${edgeId} missing`);
    return found.path;
}

describe('alignMatePaths', () => {
    it('snaps the canonical path to its end and derives the mate from it', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 1)).toBe('C 70 10, 70 40, 64.33 50');
        expect(pathOf(out, 2)).toBe('C 5.67 40, 5.67 10, 0 0');
    });

    it('snaps a border path to its end', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 3)).toBe('L 0 50');
    });

    it('derives a self-mated pair from its lower id with one shared offset', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 5)).toBe('A 5 5 0 0,1 10 0');
        expect(pathOf(out, 6)).toBe('A 5 5 0 0,0 0 0');
    });

    it('snaps but does not derive an asymmetric pair or the mate of an unparseable path', () => {
        const out = alignMatePaths(makePieces());

        expect(pathOf(out, 10)).toBe('L 5 5');
        expect(pathOf(out, 11)).toBe('L 2 3 L 0 0');
        expect(pathOf(out, 20)).toBe('Q 1 2 3 4');
        expect(pathOf(out, 21)).toBe('L 2 2 L 5 5');
        expect(pathOf(out, 4)).toBe('Q 1 2 3 4');
    });

    it('rebuilds every shape from the aligned edges', () => {
        for (const p of alignMatePaths(makePieces())) {
            expect(p.shape).toBe(buildShape(p.edges));
        }
    });

    it('does not mutate the input pieces', () => {
        const input = makePieces();

        alignMatePaths(input);

        expect(input).toEqual(makePieces());
    });
});

describe('alignLegacyMates', () => {
    function gridPieces(): { id: number; imageOffset: Point; edges: Edge[] }[] {
        return v13GridBlob().pieces.map((p) => ({ id: p.id, imageOffset: p.imageOffset, edges: p.edges as Edge[] }));
    }

    function aligned() {
        return alignLegacyMates(gridPieces());
    }

    function unroundedPieces(): { id: number; imageOffset: Point; edges: Edge[] }[] {
        return v11UnroundedGridBlob().pieces.map((p) => ({ id: p.id, imageOffset: p.imageOffset, edges: p.edges as Edge[] }));
    }

    const isRounded = (n: number) => Math.round(n * 100) / 100 === n;

    it('derives every mate from its lower-id side, ending at its corner', () => {
        const pieces = aligned();
        const owners = new Map(pieces.flatMap((p) => p.edges.map((e) => [e.id, { e, p }] as const)));
        let pairs = 0;
        for (const p of pieces) {
            for (const e of p.edges) {
                if (e.mateEdgeId < 0 || e.id > e.mateEdgeId) continue;
                const mate = owners.get(e.mateEdgeId)!;
                expect(deriveMatePath(e.path, e.start, p.imageOffset, mate.p.imageOffset)).toBe(mate.e.path);
                expect(parseEdgePath(e.path)!.at(-1)!.to).toEqual(e.end);
                pairs++;
            }
        }
        expect(pairs).toBe(4);
    });

    it('gives every shared vertex one image-space position', () => {
        const positions = new Map<string, Set<string>>();
        for (const p of aligned()) {
            for (const e of p.edges) {
                for (const v of [e.start, e.end]) {
                    const x = v.x - p.imageOffset.x;
                    const y = v.y - p.imageOffset.y;
                    const key = `${Math.round(x)},${Math.round(y)}`;
                    positions.set(key, (positions.get(key) ?? new Set()).add(`${x},${y}`));
                }
            }
        }
        expect(positions.get('10,10')!.size).toBe(1);
        expect([...positions.values()].every((s) => s.size === 1)).toBe(true);
    });

    it('keeps ids and mates', () => {
        const strip = (e: Edge) => ({ id: e.id, mateEdgeId: e.mateEdgeId, matePieceId: e.matePieceId });
        expect(aligned().map((p) => p.edges.map(strip))).toEqual(gridPieces().map((p) => p.edges.map(strip)));
    });

    it('ends an unmated path at its vertex and keeps the bytes of one that already does', () => {
        const points = (path: string) => parseEdgePath(path)!.map((s) => s.to);
        const before = gridPieces();
        const after = aligned();
        for (const [i, p] of after.entries()) {
            for (const [k, e] of p.edges.entries()) {
                if (e.mateEdgeId >= 0) continue;
                expect(points(e.path).at(-1)).toEqual(e.end);
                const stored = before[i].edges[k];
                if (stored.id === 0) continue;
                expect(e.path).toBe(stored.path);
            }
        }
        expect(after[0].edges[0].path).toBe('L 10 0');
    });

    for (const [name, change] of [
        ['a null end', { end: null }],
        ['a stored-NaN end', { end: { x: null, y: null } }],
        ['an unparseable path', { path: 'Q 1 2 3 4' }],
        ['a non-string path', { path: 42 }],
    ] as const) {
        it(`leaves an unmated edge with ${name} as stored`, () => {
            const pieces = gridPieces();
            const corrupt = { ...pieces[0].edges[0], ...change } as unknown as Edge;
            pieces[0].edges[0] = corrupt;
            const result = alignLegacyMates(pieces);
            expect(result[0].edges[0].path).toBe(corrupt.path);
        });
    }

    it('treats a border edge without an id as unpaired', () => {
        const pieces = gridPieces();
        const { id: _id, ...withoutId } = pieces[0].edges[0];
        pieces[0].edges[0] = withoutId as Edge;
        const result = alignLegacyMates(pieces);
        expect(result[0].edges[0].path).toBe('L 10 0');
    });

    it('treats an edge with neither id nor mate id as unpaired', () => {
        const pieces = gridPieces();
        const { id: _id, mateEdgeId: _mateEdgeId, ...bare } = pieces[0].edges[0];
        pieces[0].edges[0] = bare as Edge;
        const result = alignLegacyMates(pieces);
        expect(result[0].edges[0].path).toBe('L 10 0');
    });

    it('leaves an unparseable canonical path and its mate as stored', () => {
        const pieces = gridPieces();
        pieces[0].edges[1] = { ...pieces[0].edges[1], path: 'Q 1 2 3 4' };
        const result = alignLegacyMates(pieces);
        expect(result[0].edges[1].path).toBe('Q 1 2 3 4');
        expect(result[1].edges[3].path).toBe('L 1.01 5 L 0 0');
    });

    for (const [name, end] of [
        ['null', null], ['an empty object', {}], ['string coordinates', { x: '10', y: '10' }],
        ['null coordinates (a stored NaN)', { x: null, y: null }],
    ] as const) {
        it(`leaves a pair whose canonical end is ${name}, and its mate, as stored`, () => {
            const pieces = gridPieces();
            pieces[0].edges[1] = { ...pieces[0].edges[1], end: end as unknown as Point };
            const result = alignLegacyMates(pieces);
            expect(result[0].edges[1].path).toBe('L 11 5 L 9.5 10');
            expect(result[1].edges[3].path).toBe('L 1.01 5 L 0 0');
        });
    }

    it('leaves a piece without a usable image offset as stored and ends its mates at their own vertices', () => {
        const pieces = gridPieces();
        pieces[1] = { ...pieces[1], imageOffset: undefined as unknown as Point };
        const result = alignLegacyMates(pieces);
        expect(result[1]).toEqual(pieces[1]);
        expect(result[0].edges[1].path).toBe('L 11 5 L 10 10');
    });

    it('changes nothing on already aligned pieces', () => {
        const once = aligned();
        expect(alignLegacyMates(once)).toEqual(once);
    });

    it('rounds unrounded image offsets and endpoints of a pre-2026-07-25 save', () => {
        const before = unroundedPieces();
        const after = alignLegacyMates(before);
        for (const [i, p] of after.entries()) {
            expect(isRounded(p.imageOffset.x) && isRounded(p.imageOffset.y)).toBe(true);
            expect(Math.abs(p.imageOffset.x - before[i].imageOffset.x)).toBeLessThanOrEqual(0.005);
            expect(Math.abs(p.imageOffset.y - before[i].imageOffset.y)).toBeLessThanOrEqual(0.005);
            for (const e of p.edges) {
                expect([e.start.x, e.start.y, e.end.x, e.end.y].every(isRounded)).toBe(true);
            }
        }
    });

    it('makes the mates of a pre-2026-07-25 save coincide in image space', () => {
        const pieces = alignLegacyMates(unroundedPieces());
        const owners = new Map(pieces.flatMap((p) => p.edges.map((e) => [e.id, { e, p }] as const)));
        const imagePoints = (e: Edge, offset: Point) =>
            [e.start, ...parseEdgePath(e.path)!.map((s) => s.to)].map((q) => ({ x: q.x - offset.x, y: q.y - offset.y }));
        let pairs = 0;
        for (const p of pieces) {
            for (const e of p.edges) {
                if (e.mateEdgeId < 0 || e.id > e.mateEdgeId) continue;
                const mate = owners.get(e.mateEdgeId)!;
                const a = imagePoints(e, p.imageOffset);
                const b = imagePoints(mate.e, mate.p.imageOffset).reverse();
                expect(b).toHaveLength(a.length);
                a.forEach((q, k) => {
                    expect(Math.abs(q.x - b[k].x)).toBeLessThan(1e-9);
                    expect(Math.abs(q.y - b[k].y)).toBeLessThan(1e-9);
                });
                pairs++;
            }
        }
        expect(pairs).toBe(4);
    });

    it('does not mutate its input', () => {
        const pieces = gridPieces();
        const snapshot = JSON.stringify(pieces);
        alignLegacyMates(pieces);
        expect(JSON.stringify(pieces)).toBe(snapshot);
    });
});

describe('alignLegacyGroupOffsets', () => {
    const imageOffsets: Record<number, Point> = {
        0: { x: 0, y: 0 }, 1: { x: -64.33, y: 0 }, 2: { x: 0, y: -50.17 }, 3: { x: -64.33, y: -50.17 },
    };
    const pieces = new Map<number, Piece>(Object.entries(imageOffsets).map(([id, imageOffset]) => [
        Number(id),
        { id: Number(id), imageOffset, edges: [], shape: '', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
    ]));

    function drifted(): PieceGroup {
        return {
            id: 7,
            position: { x: 412.5, y: -83.25 },
            rotation: 37.5,
            pieces: new Map([
                [2, { x: 10.004, y: 60.18 }],
                [0, { x: 10.01, y: 9.996 }],
                [3, { x: 74.33 + 0.07, y: 60.17 - 0.06 }],
                [1, { x: 74.32, y: 10.013 }],
            ]),
        };
    }

    it('re-derives every offset from the first piece, keeping the group where it is', () => {
        const before = drifted();
        const [after] = alignLegacyGroupOffsets([before], pieces);
        const anchor = before.pieces.get(2)!;
        expect(after.id).toBe(7);
        expect(after.position).toEqual(before.position);
        expect(after.rotation).toBe(37.5);
        expect([...after.pieces.keys()]).toEqual([...before.pieces.keys()]);
        expect(after.pieces.get(2)).toEqual(anchor);
        for (const [id, offset] of after.pieces) {
            expect(offset.x + imageOffsets[id].x).toBeCloseTo(anchor.x + imageOffsets[2].x, 12);
            expect(offset.y + imageOffsets[id].y).toBeCloseTo(anchor.y + imageOffsets[2].y, 12);
            const was = before.pieces.get(id)!;
            expect(Math.hypot(offset.x - was.x, offset.y - was.y)).toBeLessThan(1);
        }
    });

    it('leaves a group exactly as stored when any piece would move 1 px or more', () => {
        const group = drifted();
        group.pieces.set(1, { x: 75.4, y: 10 });
        const snapshot = structuredClone(group);
        const [after] = alignLegacyGroupOffsets([group], pieces);
        expect(after).toBe(group);
        expect(group).toEqual(snapshot);
    });

    it('skips a missing piece and a non-finite offset without throwing', () => {
        const group = drifted();
        group.pieces.set(99, { x: 1, y: 2 });
        group.pieces.set(3, { x: Number.NaN, y: 0 });
        const [after] = alignLegacyGroupOffsets([group], pieces);
        expect(after.pieces.get(99)).toEqual({ x: 1, y: 2 });
        expect(after.pieces.get(3)!.x).toBeNaN();
        expect(after.pieces.get(1)!.x + imageOffsets[1].x).toBeCloseTo(10.004, 12);
    });

    it('leaves a group whose first piece is unknown as stored', () => {
        const group = drifted();
        group.pieces = new Map([[99, { x: 0, y: 0 }], ...group.pieces]);
        const [after] = alignLegacyGroupOffsets([group], pieces);
        expect(after).toBe(group);
    });

    it('changes nothing the second time', () => {
        const once = alignLegacyGroupOffsets([drifted()], pieces);
        const twice = alignLegacyGroupOffsets(once, pieces);
        expect([...twice[0].pieces]).toEqual([...once[0].pieces]);
    });

    it('does not mutate its input', () => {
        const group = drifted();
        const snapshot = structuredClone(group);
        alignLegacyGroupOffsets([group], pieces);
        expect(group).toEqual(snapshot);
    });
});
