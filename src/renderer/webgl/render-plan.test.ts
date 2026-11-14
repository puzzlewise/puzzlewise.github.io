import { describe, expect, test } from 'vitest';
import { makeGameState, makeRectPiece } from '../../test-helpers/fixtures.js';
import type { RendererAppearance } from '../appearance.js';
import {
    appearanceDirt,
    clientToCanvas,
    gameIdentity,
    groupStateDirt,
    haloKey,
    haloState,
    NO_DIRT,
    sameGame,
    sceneDirt,
} from './render-plan.js';

const APPEARANCE: RendererAppearance = {
    outline: 'outline',
    outlineColor: [0, 0, 0, 1],
    constantWidth: false,
    innerOutline: false,
    selectionGlowColor: [1, 1, 1, 1],
    backgroundColor: [0, 0, 0, 1],
    pieceOpacity: 1,
    debugPieces: false,
    matelessEdges: false,
};

function state(imageUrl: string | null = 'a.jpg') {
    return makeGameState({ pieces: [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })], imageUrl });
}

describe('sameGame', () => {
    test('the same state rendered again is the same game', () => {
        const s = state();
        expect(sameGame(gameIdentity(s), gameIdentity(s))).toBe(true);
    });

    test('a different photo is a new game', () => {
        const s = state();
        expect(sameGame(gameIdentity(s), gameIdentity({ ...s, imageUrl: 'b.jpg' }))).toBe(false);
        expect(sameGame(gameIdentity(s), gameIdentity({ ...s, imageUrl: null }))).toBe(false);
    });

    test('a different piece set is a new game, even with equal ids and photo', () => {
        const s = state();
        expect(sameGame(gameIdentity(s), gameIdentity({ ...s, pieces: [...s.pieces] }))).toBe(false);
        expect(sameGame(gameIdentity(s), gameIdentity({ ...s, pieces: s.pieces.slice(0, 1) }))).toBe(false);
    });

    test('a piece set mutated in place to another shape is a new game', () => {
        const s = state();
        const before = gameIdentity(s);
        s.pieces[0] = makeRectPiece({ id: 0, width: 50 });
        expect(sameGame(before, gameIdentity(s))).toBe(false);
    });
});

describe('sceneDirt', () => {
    test('an unchanged scene needs no upload and no frame', () => {
        expect(sceneDirt({ transforms: false, order: false, outerEdges: false, groupsChanged: [] })).toEqual(NO_DIRT);
    });

    test('moves upload transforms only', () => {
        expect(sceneDirt({ transforms: true, order: false, outerEdges: false, groupsChanged: [3] }))
            .toEqual({ vertices: false, indices: false, transforms: true, halos: false, frame: true });
    });

    test('order and outer-edge changes rebuild the index buffer, never the vertex buffer', () => {
        expect(sceneDirt({ transforms: true, order: true, outerEdges: false, groupsChanged: [] }))
            .toEqual({ vertices: false, indices: true, transforms: true, halos: false, frame: true });
        expect(sceneDirt({ transforms: true, order: false, outerEdges: true, groupsChanged: [1, 2] }))
            .toEqual({ vertices: false, indices: true, transforms: true, halos: true, frame: true });
    });
});

describe('appearanceDirt', () => {
    test('an equal appearance needs nothing', () => {
        expect(appearanceDirt(APPEARANCE, { ...APPEARANCE })).toEqual(NO_DIRT);
    });

    test('colors, opacity and constant width only redraw', () => {
        for (const change of [
            { backgroundColor: [1, 0, 0, 1] as const },
            { outlineColor: [1, 1, 0, 1] as const },
            { pieceOpacity: 0.5 },
            { constantWidth: true },
        ]) {
            expect(appearanceDirt(APPEARANCE, { ...APPEARANCE, ...change }))
                .toEqual({ vertices: false, indices: false, transforms: false, halos: false, frame: true });
        }
    });

    test('outline preset and inner outline rebuild the index buffer and the halos', () => {
        for (const change of [{ outline: 'none' as const }, { innerOutline: true }]) {
            expect(appearanceDirt(APPEARANCE, { ...APPEARANCE, ...change }))
                .toEqual({ vertices: false, indices: true, transforms: false, halos: true, frame: true });
        }
    });

    test('the glow color rebuilds the halos only', () => {
        expect(appearanceDirt(APPEARANCE, { ...APPEARANCE, selectionGlowColor: [0, 1, 0, 1] }))
            .toEqual({ vertices: false, indices: false, transforms: false, halos: true, frame: true });
    });

    test('halo inputs that change no halo leave the halos alone', () => {
        const none = { ...APPEARANCE, outline: 'none' as const };
        expect(appearanceDirt(none, { ...none, innerOutline: true }).halos).toBe(false);
        expect(appearanceDirt({ ...none, innerOutline: true }, { ...APPEARANCE, innerOutline: true }).halos).toBe(false);
    });

    test('inner outline only rebuilds the index buffer when an outline is drawn', () => {
        const toggle = (outline: RendererAppearance['outline']) =>
            appearanceDirt({ ...APPEARANCE, outline }, { ...APPEARANCE, outline, innerOutline: true }).indices;
        expect(toggle('outline')).toBe(true);
        expect(toggle('none')).toBe(false);
        expect(toggle('shadow')).toBe(false);
    });
});

describe('haloState', () => {
    test('combines selection and dragging', () => {
        expect(haloState({ selected: false, dragging: false })).toBe('idle');
        expect(haloState({ selected: true, dragging: false })).toBe('selected');
        expect(haloState({ selected: false, dragging: true })).toBe('dragging');
        expect(haloState({ selected: true, dragging: true })).toBe('selected-dragging');
    });
});

describe('groupStateDirt', () => {
    const idle = { selected: false, dragging: false };
    const selected = { selected: true, dragging: false };

    test('a change that alters the halo resyncs the halos, which draw once they change', () => {
        expect(groupStateDirt(idle, selected, APPEARANCE))
            .toEqual({ vertices: false, indices: false, transforms: false, halos: true, frame: false });
    });

    test('an unchanged state needs nothing', () => {
        expect(groupStateDirt(selected, { ...selected }, APPEARANCE)).toEqual(NO_DIRT);
    });
});

describe('haloKey', () => {
    test('differs exactly when that state\'s halo or its silhouette would', () => {
        const key = haloKey(APPEARANCE, 'selected');
        expect(haloKey({ ...APPEARANCE, backgroundColor: [1, 1, 1, 1] }, 'selected')).toBe(key);
        expect(haloKey({ ...APPEARANCE, selectionGlowColor: [0, 0, 1, 1] }, 'selected')).not.toBe(key);
        expect(haloKey({ ...APPEARANCE, outline: 'shadow' }, 'selected')).not.toBe(key);
        expect(haloKey({ ...APPEARANCE, innerOutline: true }, 'selected')).not.toBe(key);
    });

    test('a glow color change leaves the keys of states without a glow alone', () => {
        const shadow = { ...APPEARANCE, outline: 'shadow' as const };
        const glow = { ...shadow, selectionGlowColor: [0, 0, 1, 1] as const };
        expect(haloKey(glow, 'idle')).toBe(haloKey(shadow, 'idle'));
        expect(haloKey(glow, 'dragging')).toBe(haloKey(shadow, 'dragging'));
        expect(haloKey(glow, 'selected-dragging')).not.toBe(haloKey(shadow, 'selected-dragging'));
    });
});

describe('clientToCanvas', () => {
    test('subtracts the canvas origin', () => {
        const rect = { left: 10, top: 25, width: 400, height: 300 };
        expect(clientToCanvas({ x: 110, y: 75 }, rect, { width: 400, height: 300 })).toEqual({ x: 100, y: 50 });
    });

    test('undoes a CSS scale on an ancestor', () => {
        const rect = { left: 10, top: 20, width: 200, height: 450 };
        expect(clientToCanvas({ x: 110, y: 170 }, rect, { width: 400, height: 300 })).toEqual({ x: 200, y: 100 });
    });

    test('an empty rect maps without scaling', () => {
        const rect = { left: 10, top: 20, width: 0, height: 0 };
        expect(clientToCanvas({ x: 15, y: 30 }, rect, { width: 400, height: 300 })).toEqual({ x: 5, y: 10 });
    });
});
