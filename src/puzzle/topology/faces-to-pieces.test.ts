import { describe, it, expect, beforeAll } from 'vitest';
import { facesToPieceDefinitions } from './faces-to-pieces.js';
import { buildDCEL } from './dcel.js';
import { Curve } from './curve.js';
import type { PieceDefinition } from '../composable/types.js';
import { registerTabGenerator } from './generator-registry.js';
import { tracedTabGenerator } from './traced-tab-generator.js';
import { getCutStyleStrategy } from '../../game/cut-style-strategies.js';
import type { InitOptions } from '../../game/init.js';
import type { CutStyle } from '../../game/cut-styles.js';
import { fmt } from '../../model/build-shape.js';

function buildPipeline(curves: Curve[]): PieceDefinition[] {
    const dcel = buildDCEL({ curves });
    return facesToPieceDefinitions(dcel);
}

function makeGrid(cols: number, rows: number, w: number, h: number): Curve[] {
    const curves: Curve[] = [
        Curve.line({ x: 0, y: 0 }, { x: w, y: 0 }),
        Curve.line({ x: w, y: 0 }, { x: w, y: h }),
        Curve.line({ x: w, y: h }, { x: 0, y: h }),
        Curve.line({ x: 0, y: h }, { x: 0, y: 0 }),
    ];
    for (let r = 1; r < rows; r++) {
        const y = (r / rows) * h;
        curves.push(Curve.line({ x: 0, y }, { x: w, y }));
    }
    for (let c = 1; c < cols; c++) {
        const x = (c / cols) * w;
        curves.push(Curve.line({ x, y: 0 }, { x, y: h }));
    }
    return curves;
}

describe('facesToPieceDefinitions: single rectangle', () => {
    it('produces 1 piece', () => {
        const pieces = buildPipeline([
            Curve.line({ x: 0, y: 0 }, { x: 100, y: 0 }),
            Curve.line({ x: 100, y: 0 }, { x: 100, y: 80 }),
            Curve.line({ x: 100, y: 80 }, { x: 0, y: 80 }),
            Curve.line({ x: 0, y: 80 }, { x: 0, y: 0 }),
        ]);
        expect(pieces).toHaveLength(1);
    });

    it('has 4 edges, all border', () => {
        const pieces = buildPipeline([
            Curve.line({ x: 0, y: 0 }, { x: 100, y: 0 }),
            Curve.line({ x: 100, y: 0 }, { x: 100, y: 80 }),
            Curve.line({ x: 100, y: 80 }, { x: 0, y: 80 }),
            Curve.line({ x: 0, y: 80 }, { x: 0, y: 0 }),
        ]);

        expect(pieces[0].edges).toHaveLength(4);
        for (const edge of pieces[0].edges) {
            expect(edge.mateEdgeId).toBe(-1);
            expect(edge.matePieceId).toBe(-1);
        }
    });

    it('has correct imageOffset', () => {
        const pieces = buildPipeline([
            Curve.line({ x: 0, y: 0 }, { x: 100, y: 0 }),
            Curve.line({ x: 100, y: 0 }, { x: 100, y: 80 }),
            Curve.line({ x: 100, y: 80 }, { x: 0, y: 80 }),
            Curve.line({ x: 0, y: 80 }, { x: 0, y: 0 }),
        ]);

        // bbox starts at (0,0), so offset is (0,0)
        expect(pieces[0].imageOffset.x).toBeCloseTo(0, 0);
        expect(pieces[0].imageOffset.y).toBeCloseTo(0, 0);
    });
});

describe('facesToPieceDefinitions: 2×2 grid', () => {
    const curves = makeGrid(2, 2, 100, 100);

    it('produces 4 pieces', () => {
        const pieces = buildPipeline(curves);
        expect(pieces).toHaveLength(4);
    });

    it('assigns unique piece IDs', () => {
        const pieces = buildPipeline(curves);
        const ids = pieces.map(p => p.id);
        expect(new Set(ids).size).toBe(4);
    });

    it('assigns unique edge IDs across all pieces', () => {
        const pieces = buildPipeline(curves);
        const allEdgeIds = pieces.flatMap(p => p.edges.map(e => e.id));
        expect(new Set(allEdgeIds).size).toBe(allEdgeIds.length);
    });

    it('each piece has 4 edges', () => {
        const pieces = buildPipeline(curves);
        for (const piece of pieces) {
            expect(piece.edges).toHaveLength(4);
        }
    });

    it('each piece has 2 shared + 2 border edges', () => {
        const pieces = buildPipeline(curves);
        for (const piece of pieces) {
            const shared = piece.edges.filter(e => e.mateEdgeId !== -1);
            const border = piece.edges.filter(e => e.mateEdgeId === -1);
            expect(shared).toHaveLength(2);
            expect(border).toHaveLength(2);
        }
    });

    it('mate relationships are bidirectional', () => {
        const pieces = buildPipeline(curves);
        const edgeMap = new Map<number, { pieceId: number; edge: typeof pieces[0]['edges'][0] }>();
        for (const piece of pieces) {
            for (const edge of piece.edges) {
                edgeMap.set(edge.id, { pieceId: piece.id, edge });
            }
        }

        for (const piece of pieces) {
            for (const edge of piece.edges) {
                if (edge.mateEdgeId === -1) continue;

                const mate = edgeMap.get(edge.mateEdgeId);
                expect(mate).toBeDefined();
                expect(mate!.pieceId).toBe(edge.matePieceId);
                expect(mate!.edge.mateEdgeId).toBe(edge.id);
                expect(mate!.edge.matePieceId).toBe(piece.id);
            }
        }
    });

    it('shared edges have matching sharedEdgeKey', () => {
        const pieces = buildPipeline(curves);
        const edgeMap = new Map<number, typeof pieces[0]['edges'][0]>();
        for (const piece of pieces) {
            for (const edge of piece.edges) {
                edgeMap.set(edge.id, edge);
            }
        }

        for (const piece of pieces) {
            for (const edge of piece.edges) {
                if (edge.mateEdgeId === -1) continue;
                const mate = edgeMap.get(edge.mateEdgeId)!;
                expect(edge.sharedEdgeKey).toBe(mate.sharedEdgeKey);
                expect(edge.isFirstSide).not.toBe(mate.isFirstSide);
            }
        }
    });

    it('edges are in piece-local coordinates', () => {
        const pieces = buildPipeline(curves);
        for (const p of pieces) {
            // Piece-local coords (relative to bbox top-left) are non-negative.
            for (const edge of p.edges) {
                expect(edge.start.x).toBeGreaterThanOrEqual(-0.5);
                expect(edge.start.y).toBeGreaterThanOrEqual(-0.5);
                expect(edge.end.x).toBeGreaterThanOrEqual(-0.5);
                expect(edge.end.y).toBeGreaterThanOrEqual(-0.5);
            }
        }
    });
});

describe('facesToPieceDefinitions: 3×3 grid', () => {
    const curves = makeGrid(3, 3, 90, 90);

    it('produces 9 pieces', () => {
        const pieces = buildPipeline(curves);
        expect(pieces).toHaveLength(9);
    });

    it('total shared edges = 12', () => {
        const pieces = buildPipeline(curves);
        const allKeys = new Set<string>();
        for (const piece of pieces) {
            for (const edge of piece.edges) {
                if (edge.sharedEdgeKey) allKeys.add(edge.sharedEdgeKey);
            }
        }
        expect(allKeys.size).toBe(12);
    });

    it('all mate relationships are bidirectional', () => {
        const pieces = buildPipeline(curves);
        const edgeMap = new Map<number, { pieceId: number; mateEdgeId: number; matePieceId: number }>();
        for (const p of pieces) {
            for (const e of p.edges) {
                edgeMap.set(e.id, { pieceId: p.id, mateEdgeId: e.mateEdgeId, matePieceId: e.matePieceId });
            }
        }

        for (const p of pieces) {
            for (const e of p.edges) {
                if (e.mateEdgeId === -1) continue;
                const mate = edgeMap.get(e.mateEdgeId)!;
                expect(mate.mateEdgeId).toBe(e.id);
                expect(mate.matePieceId).toBe(p.id);
                expect(mate.pieceId).toBe(e.matePieceId);
            }
        }
    });
});

describe('facesToPieceDefinitions: image offsets', () => {
    it('bottom-right piece has correct offset', () => {
        const pieces = buildPipeline(makeGrid(2, 2, 100, 100));

        // The bottom-right quadrant piece has imageOffset near (-50, -50).
        const bottomRight = pieces.find(p =>
            Math.abs(p.imageOffset.x - (-50)) < 2 &&
            Math.abs(p.imageOffset.y - (-50)) < 2,
        );
        expect(bottomRight).toBeDefined();
    });

    it('top-left piece has offset near (0, 0)', () => {
        const pieces = buildPipeline(makeGrid(2, 2, 100, 100));

        const topLeft = pieces.find(p =>
            Math.abs(p.imageOffset.x) < 2 &&
            Math.abs(p.imageOffset.y) < 2,
        );
        expect(topLeft).toBeDefined();
    });
});

describe('facesToPieceDefinitions: curvePoints', () => {
    it('straight edges have no curvePoints (space optimization)', () => {
        const pieces = buildPipeline(makeGrid(2, 2, 100, 100));
        for (const piece of pieces) {
            for (const edge of piece.edges) {
                expect(edge.curvePoints).toBeUndefined();
            }
        }
    });
});

/** Same algorithm as generator.ts. */
function generateSineCurve(
    start: { x: number; y: number },
    end: { x: number; y: number },
    amplitude: number,
    frequency: number,
    phase: number,
): Curve {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const tx = dx / len;
    const ty = dy / len;
    const px = -ty;
    const py = tx;

    const segmentsPerWave = 4;
    const totalSegments = Math.max(4, Math.ceil(frequency * segmentsPerWave));

    const bezierPoints: { x: number; y: number }[] = [];

    const evalSine = (t: number) => {
        const angle = 2 * Math.PI * frequency * t + phase;
        const s = amplitude * Math.sin(angle);
        const ds = amplitude * 2 * Math.PI * frequency * Math.cos(angle);
        return {
            x: start.x + t * dx + s * px,
            y: start.y + t * dy + s * py,
            tx: dx + ds * px,
            ty: dy + ds * py,
        };
    };

    for (let i = 0; i < totalSegments; i++) {
        const t0 = i / totalSegments;
        const t1 = (i + 1) / totalSegments;
        const dt = t1 - t0;

        const p0 = evalSine(t0);
        const p1 = evalSine(t1);

        if (i === 0) {
            bezierPoints.push({ x: p0.x, y: p0.y });
        }
        bezierPoints.push(
            { x: p0.x + p0.tx * dt / 3, y: p0.y + p0.ty * dt / 3 },
            { x: p1.x - p1.tx * dt / 3, y: p1.y - p1.ty * dt / 3 },
            { x: p1.x, y: p1.y },
        );
    }

    return Curve.fromBezierPath(bezierPoints);
}

// Lens-face merging (issue #219/#220 — no holes from small faces).
describe('facesToPieceDefinitions: mate consistency under degenerate intersections', () => {
    it('merges 2-edge lens faces instead of creating holes', () => {
        // Two close parallel sine waves with opposite phase — creates lenses
        const curves = [
            Curve.line({ x: 0, y: 0 }, { x: 400, y: 0 }),
            Curve.line({ x: 400, y: 0 }, { x: 400, y: 400 }),
            Curve.line({ x: 400, y: 400 }, { x: 0, y: 400 }),
            Curve.line({ x: 0, y: 400 }, { x: 0, y: 0 }),
            generateSineCurve({ x: 0, y: 180 }, { x: 400, y: 180 }, 40, 2, 0),
            generateSineCurve({ x: 0, y: 220 }, { x: 400, y: 220 }, 40, 2, Math.PI),
        ];

        const dcel = buildDCEL({ curves });
        const pieces = facesToPieceDefinitions(dcel);

        for (const piece of pieces) {
            for (const edge of piece.edges) {
                if (edge.matePieceId !== -1) {
                    const matePiece = pieces.find(p => p.id === edge.matePieceId);
                    expect(matePiece).toBeDefined();
                    const mateEdge = matePiece!.edges.find(e => e.id === edge.mateEdgeId);
                    expect(mateEdge).toBeDefined();
                    expect(mateEdge!.matePieceId).toBe(piece.id);
                }
            }
        }
    });

    it('no mate references point to non-existent pieces (no holes)', () => {
        // Extreme settings: 6x4 grid, high amplitude, high frequency
        const w = 600;
        const h = 400;
        const cols = 6;
        const rows = 4;
        const amp = 0.5;
        const freq = 12;
        const pieceW = w / cols;
        const pieceH = h / rows;
        const hPixelAmp = (amp * pieceH) / 2;
        const vPixelAmp = (amp * pieceW) / 2;

        const curves: Curve[] = [
            Curve.line({ x: 0, y: 0 }, { x: w, y: 0 }),
            Curve.line({ x: w, y: 0 }, { x: w, y: h }),
            Curve.line({ x: w, y: h }, { x: 0, y: h }),
            Curve.line({ x: 0, y: h }, { x: 0, y: 0 }),
        ];

        // Seeded phases for reproducibility
        let seed = 42;
        const rng = () => {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        };

        for (let r = 1; r < rows; r++) {
            const y = r * pieceH;
            curves.push(generateSineCurve(
                { x: 0, y }, { x: w, y }, hPixelAmp, freq, rng() * Math.PI * 2,
            ));
        }
        for (let c = 1; c < cols; c++) {
            const x = c * pieceW;
            curves.push(generateSineCurve(
                { x, y: 0 }, { x, y: h }, vPixelAmp, freq, rng() * Math.PI * 2,
            ));
        }

        const dcel = buildDCEL({ curves });
        const pieces = facesToPieceDefinitions(dcel);

        const pieceIds = new Set(pieces.map(p => p.id));

        for (const piece of pieces) {
            for (const edge of piece.edges) {
                if (edge.matePieceId !== -1) {
                    expect(pieceIds.has(edge.matePieceId)).toBe(true);
                }
            }
        }

        // At least cols*rows pieces — extra intersections may add more, but
        // never fewer (no holes).
        expect(pieces.length).toBeGreaterThanOrEqual(cols * rows);
    });
});

describe('facesToPieceDefinitions: piece with hole', () => {
    /**
     * A flat edge list is one or more loops chained end-to-start; a loop
     * boundary is an edge whose `start` doesn't match the previous `end`.
     */
    function countLoops(edges: PieceDefinition['edges']): number {
        if (edges.length === 0) return 0;
        let loops = 1;
        for (let i = 1; i < edges.length; i++) {
            const prev = edges[i - 1];
            const cur = edges[i];
            if (Math.abs(prev.end.x - cur.start.x) > 0.5
                || Math.abs(prev.end.y - cur.start.y) > 0.5) {
                loops++;
            }
        }
        return loops;
    }

    it('appends the free-floating circle as a second loop on the frame piece', () => {
        const W = 600, H = 400;
        const pieces = buildPipeline([
            Curve.line({ x: 0, y: 0 }, { x: W, y: 0 }),
            Curve.line({ x: W, y: 0 }, { x: W, y: H }),
            Curve.line({ x: W, y: H }, { x: 0, y: H }),
            Curve.line({ x: 0, y: H }, { x: 0, y: 0 }),
            Curve.circle({ x: 300, y: 200 }, 50),
        ]);
        const withHoles = pieces.filter(p => countLoops(p.edges) > 1);
        expect(withHoles).toHaveLength(1);
        expect(countLoops(withHoles[0].edges)).toBe(2);
    });
});

describe('facesToPieceDefinitions: curve samples end at the edge vertices', () => {
    beforeAll(() => {
        registerTabGenerator(tracedTabGenerator);
    });

    const imageSize = { width: 1080, height: 720 };
    const grid = { cols: 16, rows: 12 };
    const cases: Array<{ name: string; options: InitOptions & { cutStyle: CutStyle } }> = [
        { name: 'classic', options: { cutStyle: 'classic', classicConfig: { traceSetVersion: 1 } } },
        { name: 'wavy', options: { cutStyle: 'wavy', wavyConfig: { traceSetVersion: 1 } } },
    ];

    for (const { name, options } of cases) {
        it(`starts and ends curve samples at the edge vertices (${name})`, () => {
            const strategy = getCutStyleStrategy(options.cutStyle);
            const scaled = strategy.scaleGrid(grid, imageSize, options);
            const puzzleSize = strategy.inscribePuzzleSize(imageSize, scaled, options);
            const { pieces } = strategy.generatePieces(scaled, puzzleSize, 4242, options);

            const mismatches: string[] = [];
            let edgeCount = 0;
            for (const piece of pieces) {
                for (const edge of piece.edges) {
                    edgeCount++;
                    const nums = edge.path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? [];
                    const got = nums.slice(-2).join(',');
                    const want = `${fmt(edge.end.x)},${fmt(edge.end.y)}`;
                    if (got !== want) {
                        mismatches.push(`piece ${piece.id} edge ${edge.id}: ${got} vs ${want}`);
                    }
                }
            }

            expect(edgeCount).toBeGreaterThan(0);
            expect(mismatches.slice(0, 5), `${mismatches.length} of ${edgeCount} edges`).toEqual([]);
        });
    }
});
