/**
 * Identifies which traced template ended up on which piece's tab by zipping two
 * streams that fire 1:1 in lockstep per edge: {@link setTracedTabChoiceRecorder}
 * (template selection inside `tracedTabTemplate.generate()`) and
 * {@link ApplyTabsOptions.onCandidate} (per eligible edge, with survival of the
 * collision/fold-back checks). Records are keyed by half-edge, then re-keyed by
 * piece once the graph becomes piece definitions.
 *
 * Lockstep holds on COUNT only: the recorded {@link TracedTabChoice} describes
 * the BASE rung, but the retry ladder may commit a different rung, so recorded
 * scale/flip/mid can differ from what's on screen. Production defaults the
 * recorder to a no-op and leaves `onCandidate` undefined.
 */

import type { HalfEdge, TopologyGraph } from './dcel.js';
import { faceBoundaryEdges } from './faces-to-pieces.js';
import {
    setTracedTabChoiceRecorder,
    type TracedTabChoice,
} from '../composable/traced-tab-recorder.js';

/** `edgeIndex` matches PieceDefinition.edges ordering (as renderer/debug view show it), so entries correlate with on-screen edges. */
export interface TabDebugEntry {
    /** Half-edge id from the DCEL; stable join key. */
    halfEdgeId: number;
    /** Position of this edge in PieceDefinition.edges (outer loop first). */
    edgeIndex: number;
    pieceId: number;
    /** Piece id on the *other* side of the shared edge, or null for borders. */
    matePieceId: number | null;
    /** Whether collision/fold-back checks accepted the candidate. */
    accepted: boolean;
    /** Traced-template selection, if the tab generator was 'traced'. */
    traced: TracedTabChoice | null;
}

export type TabDebugReport = Record<number, TabDebugEntry[]>;

interface RawEntry {
    halfEdge: HalfEdge;
    accepted: boolean;
    traced: TracedTabChoice | null;
}

/**
 * Usage: pass {@link onCandidate} to `applyTabs`, then call {@link finish} once
 * the piece definitions are ready. The session installs a traced-tab recorder
 * for its lifetime; `finish`/`dispose` un-installs it. Only one session may be
 * active — a second silently overwrites the recorder, so don't use these in
 * parallel tests.
 */
export class TabDebugSession {
    private entries: RawEntry[] = [];
    private lastChoice: TracedTabChoice | null = null;
    private disposed = false;

    constructor() {
        setTracedTabChoiceRecorder((choice) => {
            this.lastChoice = choice;
        });
    }

    /**
     * Pass to `applyTabs({ onCandidate })`. Consumes the most recent recorded
     * traced choice; null when the active generator wasn't 'traced'.
     */
    readonly onCandidate = (he: HalfEdge, accepted: boolean): void => {
        const traced = this.lastChoice;
        this.lastChoice = null;
        this.entries.push({ halfEdge: he, accepted, traced });
    };

    /**
     * Build the piece-keyed report. Pass the SAME graph handed to `applyTabs`;
     * the face→piece-id mapping mirrors `facesToPieceDefinitions` (inner faces
     * in DCEL order, indexed from 0). Disposes the session.
     */
    finish(graph: TopologyGraph): TabDebugReport {
        this.dispose();
        const faceIdToPieceId = new Map<number, number>();
        graph.faces.filter(f => !f.isOuter)
            .forEach((face, index) => faceIdToPieceId.set(face.id, index));
        // Reconstruct edgeIndex by replaying the face walk (outer loop then
        // inner boundaries), matching PieceDefinition.edges ordering; the
        // PieceDefinitions aren't in hand here. Each shared edge is emitted
        // under both pieces so a caller can look up by either.
        const report: TabDebugReport = {};
        for (const entry of this.entries) {
            const { halfEdge: he, accepted, traced } = entry;
            for (const side of [he, he.twin]) {
                const face = side.face;
                if (!face || face.isOuter) continue;
                const pieceId = faceIdToPieceId.get(face.id);
                if (pieceId === undefined) continue;
                const matePieceId = matePieceFor(side, faceIdToPieceId);
                const edgeIndex = indexInFaceWalk(side);
                (report[pieceId] ??= []).push({
                    halfEdgeId: he.id,
                    edgeIndex,
                    pieceId,
                    matePieceId,
                    accepted,
                    traced,
                });
            }
        }
        // Sort by edgeIndex so a JSON dump follows on-screen order.
        for (const pid of Object.keys(report)) {
            report[Number(pid)].sort((a, b) => a.edgeIndex - b.edgeIndex);
        }
        return report;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        setTracedTabChoiceRecorder(null);
    }
}

function matePieceFor(
    he: HalfEdge,
    faceIdToPieceId: Map<number, number>,
): number | null {
    const twinFace = he.twin.face;
    if (!twinFace || twinFace.isOuter) return null;
    return faceIdToPieceId.get(twinFace.id) ?? null;
}

function indexInFaceWalk(target: HalfEdge): number {
    const face = target.face;
    if (!face) return -1;
    return faceBoundaryEdges(face).indexOf(target);
}
