/**
 * The router owns container listeners; this file builds the collaborators
 * and connects them via the router's hooks.
 */

import type { GameState, Point } from '../model/types.js';
import { getGroupForPiece, moveGroup, tryGetGroup } from '../model/helpers.js';
import type { Renderer } from '../renderer/types.js';
import { DragController } from './drag-controller.js';
import type { ScreenDeltaToWorld } from './drag-controller.js';
import { ViewportController } from './viewport-controller.js';
import type { ViewportTransform } from './viewport-transform.js';
import { AutoPanController } from './auto-pan.js';
import { PointerRouter } from './pointer-router.js';
import type { ClassifyTarget } from './pointer-router.js';
import { probeNearbyPieceId } from './hit-probe.js';
import type { SelectionManager } from './selection-manager.js';
import type { RotationFocus } from './rotation-focus.js';
import { MarqueeController, groupScreenRect } from './marquee-controller.js';
import type { ScreenRect } from './marquee-controller.js';
import { loadOffsetDragPreference, loadMarqueeContainPreference } from '../ui/index.js';
import { SnapProximityRotationController } from './snap-proximity-rotation-controller.js';
import { createFrameCoalescer } from './frame-coalescer.js';
import type { SnapTolerances } from '../game/snap-proximity-rotation.js';

export interface InteractionSetupOptions {
    container: HTMLElement;
    renderer: Renderer;
    viewportTransform: ViewportTransform;
    getState: () => GameState;
    onStateChanged: () => void;
    onDrop: (groupId: number) => void;
    onViewportChanged: () => void;
    screenDeltaToWorld?: ScreenDeltaToWorld;
    panViewport?: (screenDelta: Point) => void;
    selectionManager?: SelectionManager;
    rotationFocus?: RotationFocus;
    /** Active snap tolerances; omit to disable snap proximity rotation. */
    getSnapTolerances?: () => SnapTolerances;
}

const OFFSET_DRAG_SCREEN_PX = 50;

export function setupInteraction(options: InteractionSetupOptions): () => void {
    const {
        container, renderer, viewportTransform, getState, onStateChanged,
        onDrop, onViewportChanged, screenDeltaToWorld, panViewport, selectionManager,
        rotationFocus, getSnapTolerances,
    } = options;

    const deltaToWorld = screenDeltaToWorld ?? ((d: Point) => d);

    // Auto-pan moves the viewport within its own frame, so its group render
    // can't wait for the next one; it renders now and supersedes a pending one.
    const dragRender = createFrameCoalescer(onStateChanged);
    const renderNow = (): void => {
        dragRender.cancel();
        onStateChanged();
    };

    const expandToSelection = (groupId: number): readonly number[] =>
        selectionManager?.expandToSelectionIfActive(groupId) ?? [groupId];

    const viewportController = new ViewportController(viewportTransform, onViewportChanged);

    const viewportMotion = new Set<'pan' | 'pinch' | 'auto-pan'>();
    const setViewportMotion = (reason: 'pan' | 'pinch' | 'auto-pan', active: boolean): void => {
        if (active) viewportMotion.add(reason);
        else viewportMotion.delete(reason);
        renderer.setViewportMoving(viewportMotion.size > 0);
    };

    const snapRotation = getSnapTolerances
        ? new SnapProximityRotationController({ getState, getTolerances: getSnapTolerances })
        : null;

    const autoPan = panViewport
        ? new AutoPanController({
            panViewport(screenDelta) {
                setViewportMotion('auto-pan', true);
                panViewport(screenDelta);
            },
            moveGroup(groupId, worldDelta) {
                for (const id of expandToSelection(groupId)) {
                    const group = tryGetGroup(getState(), id);
                    if (group) moveGroup(group, worldDelta);
                }
                snapRotation?.onGroupMoved();
            },
            screenDeltaToWorld: deltaToWorld,
            requestRender: renderNow,
            getViewportSize: () => ({
                width: window.visualViewport?.width ?? window.innerWidth,
                height: window.visualViewport?.height ?? window.innerHeight,
            }),
        })
        : null;

    const dragController = new DragController(
        {
            getGroupForPiece: (pieceId) => getGroupForPiece(getState(), pieceId),
            getGroupById: (id) => tryGetGroup(getState(), id),
        },
        {
            moveGroup(groupId, delta) {
                for (const id of expandToSelection(groupId)) {
                    const group = tryGetGroup(getState(), id);
                    if (group) moveGroup(group, delta);
                }
                snapRotation?.onGroupMoved();
            },
            bringToFront(groupId) {
                const ids = expandToSelection(groupId);
                for (let i = ids.length - 1; i >= 0; i--) {
                    renderer.bringGroupToFront(ids[i]);
                    renderer.setGroupDragging(ids[i], true);
                }
            },
            requestRender: () => dragRender.schedule(),
        },
        undefined,
        screenDeltaToWorld,
    );

    const marquee = selectionManager
        ? new MarqueeController({
            container,
            selectionManager,
            isContainMode: () => loadMarqueeContainPreference(),
            getGroupScreenRects: () => {
                const state = getState();
                const rects: Array<{ id: number; rect: ScreenRect }> = [];
                for (const group of state.groups) {
                    const rect = groupScreenRect(
                        group,
                        state.piecesById,
                        (p) => viewportTransform.worldToScreen(p),
                    );
                    if (rect) rects.push({ id: group.id, rect });
                }
                return rects;
            },
            onSelectionCommitted: renderNow,
        })
        : null;

    // Decided once at drag start and held until the gesture resolves.
    let backgroundMode: 'pan' | 'marquee' = 'pan';

    function endPan(): void {
        viewportController.handlePanEnd();
        setViewportMotion('pan', false);
    }

    function applyOffsetDragIfSingleGroup(groupId: number): void {
        const group = tryGetGroup(getState(), groupId);
        if (!group) return;
        if (expandToSelection(groupId).length > 1) return;
        if (!loadOffsetDragPreference()) return;
        const offset = deltaToWorld({ x: 0, y: -OFFSET_DRAG_SCREEN_PX });
        moveGroup(group, offset);
        renderNow();
    }

    const probeHitTest = (p: Point): number | null => renderer.pieceIdAtPoint(p);

    const classifyTarget: ClassifyTarget = (target, point) => {
        const isTable = target === container ||
            (target instanceof Element && target.closest('[data-puzzle-table]') !== null);
        if (!isTable) return { kind: 'ignore' };
        if (!point) return { kind: 'background' };

        const pieceId = renderer.pieceIdAtPoint(point) ?? probeNearbyPieceId(point, probeHitTest);
        return pieceId === null ? { kind: 'background' } : { kind: 'piece', pieceId };
    };

    const router = new PointerRouter({
        container,
        classifyTarget,

        onPieceTap: (pieceId, _evt) => {
            const group = getGroupForPiece(getState(), pieceId);
            rotationFocus?.setFocus(group.id);
            if (!selectionManager?.toolActive) return;
            selectionManager.toggle(group.id);
            renderer.setGroupSelected(group.id, selectionManager.isSelected(group.id));
            renderNow();
        },

        onPieceDrag: {
            start: (pieceId, evt) => {
                rotationFocus?.clearFocus();
                dragController.handlePointerDown(pieceId, evt);
                const drag = dragController.getActiveDrag();
                if (!drag) return;
                applyOffsetDragIfSingleGroup(drag.groupId);
                autoPan?.start(drag.groupId);
                autoPan?.updatePointer({ x: evt.clientX, y: evt.clientY });
                // Single-group drags only: rotating one group of a multi-selection would disturb the arrangement.
                if (expandToSelection(drag.groupId).length === 1) {
                    snapRotation?.start(drag.groupId);
                }
            },
            move: (evt) => {
                dragController.handlePointerMove(evt);
                autoPan?.updatePointer({ x: evt.clientX, y: evt.clientY });
            },
            end: (evt) => {
                const drag = dragController.getActiveDrag();
                if (!drag) return;
                const groupId = drag.groupId;
                dragController.handlePointerUp(evt);
                autoPan?.stop();
                setViewportMotion('auto-pan', false);
                dragRender.flush();
                for (const id of expandToSelection(groupId)) renderer.setGroupDragging(id, false);
                snapRotation?.stop();
                onDrop(groupId);
            },
            cancel: () => {
                const drag = dragController.getActiveDrag();
                if (!drag) return;
                const groupId = drag.groupId;
                snapRotation?.stop();
                dragController.cancel();
                autoPan?.stop();
                setViewportMotion('auto-pan', false);
                dragRender.flush();
                for (const id of expandToSelection(groupId)) renderer.setGroupDragging(id, false);
            },
        },

        onBackgroundPan: {
            start: (evt) => {
                rotationFocus?.clearFocus();
                // start fires from the move that crosses the drag threshold, so evt.shiftKey
                // is the authoritative Shift read for arming the marquee (press-then-hold-Shift
                // still arms it). The button's cosmetic shiftHint reads the key separately and
                // may briefly disagree without affecting the gesture.
                const wantMarquee =
                    !!marquee && !!selectionManager &&
                    (selectionManager.marqueeActive || evt.shiftKey);
                if (wantMarquee) {
                    backgroundMode = 'marquee';
                    // A marquee needs the tool on. marqueeActive already implies it; the Shift
                    // shortcut may not, so enable it here (Shift+drag leaves multi-select on but
                    // doesn't arm the marquee).
                    if (!selectionManager.toolActive) {
                        selectionManager.toolActive = true;
                    }
                    marquee.start(evt);
                } else {
                    backgroundMode = 'pan';
                    setViewportMotion('pan', true);
                    viewportController.handlePanStart(evt);
                }
            },
            move: (evt) => {
                if (backgroundMode === 'marquee') marquee?.move(evt);
                else viewportController.handlePanMove(evt);
            },
            end: (evt) => {
                if (backgroundMode === 'marquee') marquee?.end(evt);
                else endPan();
            },
            cancel: () => {
                if (backgroundMode === 'marquee') marquee?.cancel();
                else endPan();
            },
        },

        onPinch: {
            start: (a, b) => {
                rotationFocus?.clearFocus();
                setViewportMotion('pinch', true);
                viewportController.handlePinchStart(a, b);
            },
            move: (a, b) => viewportController.handlePinchMove(a, b),
            end: () => {
                viewportController.handlePinchEnd();
                setViewportMotion('pinch', false);
            },
        },

        onWheelZoom: (evt) => {
            rotationFocus?.clearFocus();
            viewportController.handleWheel(evt);
        },

        onBackgroundTap: () => {
            rotationFocus?.clearFocus();
        },
    });

    return () => {
        autoPan?.stop();
        dragRender.cancel();
        viewportMotion.clear();
        renderer.setViewportMoving(false);
        router.destroy();
    };
}
