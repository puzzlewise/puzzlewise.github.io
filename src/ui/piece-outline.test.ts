/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    PIECE_OUTLINE_PRESETS,
    DEFAULT_PIECE_OUTLINE_ID,
    PIECE_OUTLINE_PREFERENCE_KEY,
    savePieceOutlinePreference,
    loadPieceOutlinePreference,
    applyPieceOutline,
} from './piece-outline.js';

describe('PIECE_OUTLINE_PRESETS', () => {
    it('has exactly three presets in order: none, shadow, outline', () => {
        expect(PIECE_OUTLINE_PRESETS.map((p) => p.id)).toEqual([
            'none',
            'shadow',
            'outline',
        ]);
    });

    it('default id is "outline"', () => {
        expect(DEFAULT_PIECE_OUTLINE_ID).toBe('outline');
    });

    it('each preset has id, label and description', () => {
        for (const preset of PIECE_OUTLINE_PRESETS) {
            expect(preset.id).toBeTruthy();
            expect(preset.label).toBeTruthy();
            expect(preset.description).toBeTruthy();
        }
    });
});

describe('savePieceOutlinePreference / loadPieceOutlinePreference', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('saves and loads an id', () => {
        savePieceOutlinePreference('outline');
        expect(loadPieceOutlinePreference()).toBe('outline');
    });

    it('returns the default when nothing is saved', () => {
        expect(loadPieceOutlinePreference()).toBe(DEFAULT_PIECE_OUTLINE_ID);
    });

    it('returns the default for an unknown saved id', () => {
        localStorage.setItem(PIECE_OUTLINE_PREFERENCE_KEY, 'not-a-mode');
        expect(loadPieceOutlinePreference()).toBe(DEFAULT_PIECE_OUTLINE_ID);
    });
});

describe('applyPieceOutline', () => {
    it('exposes the active preset id on the root element', () => {
        applyPieceOutline('outline');
        expect(document.documentElement.dataset.pieceOutline).toBe('outline');
        applyPieceOutline('not-a-mode');
        expect(document.documentElement.dataset.pieceOutline).toBe(DEFAULT_PIECE_OUTLINE_ID);
        applyPieceOutline('shadow');
        expect(document.documentElement.dataset.pieceOutline).toBe('shadow');
    });
});
