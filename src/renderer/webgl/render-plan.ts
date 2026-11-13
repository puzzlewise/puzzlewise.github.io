import type { GameState, Point, Size } from '../../model/types.js';
import type { RendererAppearance } from '../appearance.js';
import { type DrawPasses, drawPasses } from './draw-list.js';
import { silhouetteStroke } from './halo-atlas-plan.js';
import { HALO_STATES, type HaloState, haloSteps } from './halo-recipe.js';
import type { SceneChanges } from './scene.js';

/**
 * Piece ids restart at 0 each game, so ids can't tell games apart. The count
 * and first shape also catch a piece array replaced in place, as the SVG
 * renderer's fingerprint does.
 */
export interface GameIdentity {
    pieces: GameState['pieces'];
    count: number;
    firstShape: string;
    imageUrl: string | null;
}

export interface Dirt {
    vertices: boolean;
    indices: boolean;
    transforms: boolean;
    halos: boolean;
    frame: boolean;
}

export const NO_DIRT: Readonly<Dirt> = { vertices: false, indices: false, transforms: false, halos: false, frame: false };

export function gameIdentity(state: GameState): GameIdentity {
    return {
        pieces: state.pieces,
        count: state.pieces.length,
        firstShape: state.pieces[0]?.shape ?? '',
        imageUrl: state.imageUrl,
    };
}

export function sameGame(a: GameIdentity, b: GameIdentity): boolean {
    return a.pieces === b.pieces && a.count === b.count && a.firstShape === b.firstShape && a.imageUrl === b.imageUrl;
}

export function sceneDirt(changes: SceneChanges): Dirt {
    const indices = changes.order || changes.outerEdges;
    return {
        vertices: false,
        indices,
        transforms: changes.transforms,
        halos: changes.outerEdges,
        frame: indices || changes.transforms || changes.groupsChanged.length > 0,
    };
}

function sameValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
    return a === b;
}

function samePasses(a: DrawPasses, b: DrawPasses): boolean {
    return a.strokesUnder === b.strokesUnder && a.fringe === b.fringe && a.strokesOver === b.strokesOver;
}

export function appearanceDirt(prev: RendererAppearance, next: RendererAppearance): Dirt {
    const keys = Object.keys(next) as (keyof RendererAppearance)[];
    const frame = keys.some((key) => !sameValue(prev[key], next[key]));
    return {
        vertices: false,
        indices: !samePasses(drawPasses(prev, true), drawPasses(next, true)),
        transforms: false,
        halos: HALO_STATES.some((state) => haloKey(prev, state) !== haloKey(next, state)),
        frame,
    };
}

/** Everything in the appearance that the pixels of a halo in `state` depend on. */
export function haloKey(appearance: RendererAppearance, state: HaloState): string {
    const steps = haloSteps(state, appearance.outline, appearance.selectionGlowColor);
    return JSON.stringify([silhouetteStroke(appearance), steps]);
}

export function haloState(flags: { selected: boolean; dragging: boolean }): HaloState {
    if (flags.selected) return flags.dragging ? 'selected-dragging' : 'selected';
    return flags.dragging ? 'dragging' : 'idle';
}

type GroupFlags = { selected: boolean; dragging: boolean };

export function groupStateDirt(prev: GroupFlags, next: GroupFlags, appearance: RendererAppearance): Dirt {
    const steps = (flags: GroupFlags) =>
        JSON.stringify(haloSteps(haloState(flags), appearance.outline, appearance.selectionGlowColor));
    return { ...NO_DIRT, halos: steps(prev) !== steps(next) };
}

/** `rect` is the canvas's client rect; `cssSize` its layout size, which differs under an ancestor's CSS transform. */
export function clientToCanvas(
    point: Point,
    rect: { left: number; top: number; width: number; height: number },
    cssSize: Size,
): Point {
    const sx = rect.width > 0 ? cssSize.width / rect.width : 1;
    const sy = rect.height > 0 ? cssSize.height / rect.height : 1;
    return { x: (point.x - rect.left) * sx, y: (point.y - rect.top) * sy };
}
