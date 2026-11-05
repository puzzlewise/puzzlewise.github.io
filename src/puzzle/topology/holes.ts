/**
 * Only single-level hole nesting is verified by tests (frame + circle,
 * frame + two-circle Venn); deeper nesting is unverified.
 */

import type { TopologyGraph, Face } from './dcel.js';
import { walkLoop } from './half-edge-loop.js';
import type { Component } from './components.js';
import type { Point } from '../../model/types.js';

export function assignHoles(graph: TopologyGraph, components: Component[]): void {
    const primary = components.find(c => c.faces.has(graph.outerFace.id));
    if (!primary) return;
    const others = components.filter(c => c !== primary);

    for (const inner of others) {
        const probe = inner.halfEdges[0].origin.position;
        const containingFace = findContainingFace(probe, graph, inner);
        if (!containingFace) continue;

        // Redundant after attachment — same physical region as
        // `containingFace` — so remove it from the graph.
        const localOuterFace = findLocalOuterFace(inner, graph);
        if (!localOuterFace) continue;

        containingFace.innerBoundaries.push(localOuterFace.outerEdge);

        // Retarget: else faces-to-pieces walks `he.twin.face` into the removed
        // local-outer Face, the faceId→pieceId lookup misses and yields
        // matePieceId = -1, marking inner-boundary edges as unmated borders and
        // breaking interactive merge.
        for (const he of walkLoop(localOuterFace.outerEdge)) {
            he.face = containingFace;
        }

        const idx = graph.faces.indexOf(localOuterFace);
        if (idx >= 0) graph.faces.splice(idx, 1);
    }
}

function findLocalOuterFace(component: Component, graph: TopologyGraph): Face | null {
    // Most-negative signed area = the local outer face. Uses SAMPLED curve
    // points: vertex-only shoelace collapses to zero for few-vertex curved
    // faces (a 2-arc circle has 2 vertices), essential for Venn.
    let bestFace: Face | null = null;
    let mostNegative = Infinity;
    for (const faceId of component.faces) {
        const face = graph.faces.find(f => f.id === faceId);
        if (!face) continue;
        const area = sampledSignedArea(face);
        if (area < mostNegative) {
            mostNegative = area;
            bestFace = face;
        }
    }
    return bestFace;
}

function findContainingFace(
    probe: Point,
    graph: TopologyGraph,
    excludeComponent: Component,
): Face | null {
    const excluded = new Set(excludeComponent.faces);
    let best: Face | null = null;
    let bestArea = Infinity;

    for (const face of graph.faces) {
        if (face.isOuter) continue;
        if (excluded.has(face.id)) continue;

        const polygon = sampleFaceBoundary(face);
        if (!pointInPolygon(probe, polygon)) continue;

        const area = polygonArea(polygon);
        if (area < bestArea) {
            bestArea = area;
            best = face;
        }
    }
    return best;
}

function sampleFaceBoundary(face: Face): Point[] {
    return walkLoop(face.outerEdge).flatMap(he => he.curve.sample(8));
}

function pointInPolygon(p: Point, polygon: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersects = ((yi > p.y) !== (yj > p.y))
            && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function polygonArea(polygon: Point[]): number {
    let a = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        a += (polygon[j].x + polygon[i].x) * (polygon[j].y - polygon[i].y);
    }
    return Math.abs(a / 2);
}

/**
 * SAMPLED points along each edge curve, not endpoints: vertex-only shoelace
 * collapses to zero for few-vertex curved faces (a 2-vertex circle).
 */
function sampledSignedArea(face: Face): number {
    // Shoelace is robust to the endpoints duplicated between edges.
    const points = walkLoop(face.outerEdge).flatMap(he => he.curve.sample(8));

    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j].x * points[i].y - points[i].x * points[j].y;
    }
    return area / 2;
}
