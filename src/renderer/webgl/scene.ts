import { rotatePoint } from '../../model/helpers.js';
import type { GameState, PieceGroup, Point } from '../../model/types.js';
import type { PieceMesh } from './piece-mesh.js';

export interface SceneChanges {
    transforms: boolean;
    order: boolean;
    outerEdges: boolean;
    /** Ids of groups added, removed or altered (position, rotation, membership) since the last sync. */
    groupsChanged: number[];
}

export const TRANSFORM_STRIDE = 8;
export const TRANSFORM_COS = 0;
export const TRANSFORM_SIN = 1;
export const TRANSFORM_TX = 2;
export const TRANSFORM_TY = 3;
export const TRANSFORM_GROUP_SLOT = 4;

interface GroupSnapshot {
    x: number;
    y: number;
    rotation: number;
    layout: { id: number; x: number; y: number }[];
}

interface RotationOverride {
    deg: number;
    pivot: Point;
    /** World position of the pivot, pinned when the override was set. */
    anchor: Point;
}

function snapshot(group: PieceGroup): GroupSnapshot {
    return {
        x: group.position.x,
        y: group.position.y,
        rotation: group.rotation,
        layout: Array.from(group.pieces, ([id, offset]) => ({ id, x: offset.x, y: offset.y })),
    };
}

function sameLayout(layout: GroupSnapshot['layout'], pieces: PieceGroup['pieces']): boolean {
    if (layout.length !== pieces.size) return false;
    let i = 0;
    for (const [id, offset] of pieces) {
        const entry = layout[i++];
        if (entry.id !== id || entry.x !== offset.x || entry.y !== offset.y) return false;
    }
    return true;
}

export class Scene {
    private readonly meshes = new Map<number, PieceMesh>();
    private readonly slotByPiece = new Map<number, number>();
    private readonly edgeOwners = new Map<number, { pieceId: number; matePieceId: number }>();
    private readonly groups = new Map<number, GroupSnapshot>();
    private readonly pieceGroup = new Map<number, number>();
    private readonly flags = new Map<number, { selected: boolean; dragging: boolean }>();
    private readonly overrides = new Map<number, RotationOverride>();
    private order: number[] = [];
    private transforms: Float32Array;
    private transformsStale = true;
    private pendingTransforms = false;
    private pendingOrder = false;

    constructor(meshes: PieceMesh[], state: GameState) {
        for (const mesh of meshes) this.meshes.set(mesh.pieceId, mesh);
        state.pieces.forEach((piece, slot) => {
            this.slotByPiece.set(piece.id, slot);
            for (const edge of piece.edges) {
                this.edgeOwners.set(edge.id, { pieceId: piece.id, matePieceId: edge.matePieceId });
            }
        });
        this.transforms = new Float32Array(state.pieces.length * TRANSFORM_STRIDE);
        this.sync(state);
    }

    meshFor(pieceId: number): PieceMesh | undefined {
        return this.meshes.get(pieceId);
    }

    sync(state: GameState): SceneChanges {
        const changed: number[] = [];
        let membershipChanged = false;
        let orderChanged = this.pendingOrder;
        let transformsChanged = this.pendingTransforms;
        this.pendingOrder = false;
        this.pendingTransforms = false;

        for (const group of state.groups) {
            const prev = this.groups.get(group.id);
            if (!prev) {
                this.groups.set(group.id, snapshot(group));
                this.order.push(group.id);
                orderChanged = true;
                membershipChanged = true;
                transformsChanged = true;
                changed.push(group.id);
                continue;
            }
            const layoutChanged = !sameLayout(prev.layout, group.pieces);
            const moved = prev.x !== group.position.x || prev.y !== group.position.y
                || prev.rotation !== group.rotation;
            if (!layoutChanged && !moved) continue;
            if (layoutChanged) {
                this.groups.set(group.id, snapshot(group));
                membershipChanged = true;
            } else {
                prev.x = group.position.x;
                prev.y = group.position.y;
                prev.rotation = group.rotation;
            }
            transformsChanged = true;
            changed.push(group.id);
        }

        if (this.groups.size > state.groups.length) {
            for (const id of this.groups.keys()) {
                if (state.groupsById.has(id)) continue;
                this.groups.delete(id);
                this.flags.delete(id);
                this.overrides.delete(id);
                changed.push(id);
                orderChanged = true;
                membershipChanged = true;
                transformsChanged = true;
            }
            this.order = this.order.filter((id) => this.groups.has(id));
        }

        if (membershipChanged) {
            this.pieceGroup.clear();
            for (const group of state.groups) {
                for (const pieceId of group.pieces.keys()) this.pieceGroup.set(pieceId, group.id);
            }
        }
        // Group slots shift whenever the order does.
        if (orderChanged) transformsChanged = true;
        if (transformsChanged) this.transformsStale = true;

        return {
            transforms: transformsChanged,
            order: orderChanged,
            outerEdges: membershipChanged,
            groupsChanged: changed,
        };
    }

    bringToFront(groupId: number): void {
        const index = this.order.indexOf(groupId);
        if (index === -1 || index === this.order.length - 1) return;
        this.order.splice(index, 1);
        this.order.push(groupId);
        this.pendingOrder = true;
        this.pendingTransforms = true;
        this.transformsStale = true;
    }

    setSelected(groupId: number, on: boolean): void {
        const flags = this.flagsFor(groupId);
        if (flags) flags.selected = on;
    }

    setDragging(groupId: number, on: boolean): void {
        const flags = this.flagsFor(groupId);
        if (flags) flags.dragging = on;
    }

    private flagsFor(groupId: number): { selected: boolean; dragging: boolean } | undefined {
        if (!this.groups.has(groupId)) return undefined;
        let flags = this.flags.get(groupId);
        if (!flags) {
            flags = { selected: false, dragging: false };
            this.flags.set(groupId, flags);
        }
        return flags;
    }

    groupState(groupId: number): { selected: boolean; dragging: boolean } {
        const flags = this.flags.get(groupId);
        return { selected: flags?.selected ?? false, dragging: flags?.dragging ?? false };
    }

    orderedGroupIds(): readonly number[] {
        return this.order;
    }

    isOuterEdge(edgeId: number): boolean {
        const owner = this.edgeOwners.get(edgeId);
        if (!owner || owner.matePieceId === -1) return owner !== undefined;
        return this.pieceGroup.get(owner.pieceId) !== this.pieceGroup.get(owner.matePieceId);
    }

    setRotationOverride(groupId: number, deg: number, pivotLocal: Point | null): void {
        const group = this.groups.get(groupId);
        if (pivotLocal === null || !group) {
            if (!this.overrides.delete(groupId)) return;
        } else {
            const rotatedPivot = rotatePoint(pivotLocal, group.rotation);
            this.overrides.set(groupId, {
                deg,
                pivot: pivotLocal,
                anchor: { x: group.x + rotatedPivot.x, y: group.y + rotatedPivot.y },
            });
        }
        this.pendingTransforms = true;
        this.transformsStale = true;
    }

    pieceTransforms(): Float32Array {
        if (this.transformsStale) this.rebuildTransforms();
        return this.transforms;
    }

    private rebuildTransforms(): void {
        this.order.forEach((groupId, groupSlot) => {
            const group = this.groups.get(groupId)!;
            const override = this.overrides.get(groupId);
            const rotation = override ? override.deg : group.rotation;
            const rad = (rotation * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            for (const { id: pieceId, x: ox, y: oy } of group.layout) {
                const slot = this.slotByPiece.get(pieceId);
                if (slot === undefined) continue;
                let tx: number;
                let ty: number;
                if (override) {
                    const dx = ox - override.pivot.x;
                    const dy = oy - override.pivot.y;
                    tx = override.anchor.x + dx * cos - dy * sin;
                    ty = override.anchor.y + dx * sin + dy * cos;
                } else {
                    tx = group.x + ox * cos - oy * sin;
                    ty = group.y + ox * sin + oy * cos;
                }
                const base = slot * TRANSFORM_STRIDE;
                this.transforms[base + TRANSFORM_COS] = cos;
                this.transforms[base + TRANSFORM_SIN] = sin;
                this.transforms[base + TRANSFORM_TX] = tx;
                this.transforms[base + TRANSFORM_TY] = ty;
                this.transforms[base + TRANSFORM_GROUP_SLOT] = groupSlot;
            }
        });
        this.transformsStale = false;
    }
}
