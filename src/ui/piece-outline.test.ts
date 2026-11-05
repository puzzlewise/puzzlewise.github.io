/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    PIECE_OUTLINE_PRESETS,
    DEFAULT_PIECE_OUTLINE_ID,
    PIECE_OUTLINE_PREFERENCE_KEY,
    CSS_CUSTOM_PROPERTY,
    IDLE_CSS_CUSTOM_PROPERTY,
    getPieceOutlinePreset,
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

    it('each preset has id, label, description, and filter', () => {
        for (const preset of PIECE_OUTLINE_PRESETS) {
            expect(preset.id).toBeTruthy();
            expect(preset.label).toBeTruthy();
            expect(preset.description).toBeTruthy();
            expect(preset.filter).toBeTruthy();
        }
    });

    it('none preset uses a no-op filter so it composes with state variants', () => {
        // Bare `none` is invalid in `filter: none drop-shadow(...)`; `opacity(1)` is a no-op.
        expect(getPieceOutlinePreset('none').filter).toBe('opacity(1)');
    });

    it('shadow preset uses a zero-offset drop-shadow (rotation-invariant)', () => {
        expect(getPieceOutlinePreset('shadow').filter).toMatch(
            /^drop-shadow\(\s*0\s+0\s+/,
        );
    });

    it('outline preset puts no filter on groups, like none (#687)', () => {
        const outline = getPieceOutlinePreset('outline');
        expect(outline.filter).toBe('opacity(1)');
        expect(outline.idleFilter).toBe('none');
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
    beforeEach(() => {
        document.documentElement.style.removeProperty(CSS_CUSTOM_PROPERTY);
        document.documentElement.style.removeProperty(IDLE_CSS_CUSTOM_PROPERTY);
    });

    it('sets the CSS custom property to the preset filter', () => {
        applyPieceOutline('shadow');
        expect(
            document.documentElement.style.getPropertyValue(CSS_CUSTOM_PROPERTY),
        ).toBe(getPieceOutlinePreset('shadow').filter);
    });

    it('overwrites on subsequent calls', () => {
        applyPieceOutline('shadow');
        applyPieceOutline('none');
        expect(
            document.documentElement.style.getPropertyValue(CSS_CUSTOM_PROPERTY),
        ).toBe('opacity(1)');
    });

    it('falls back to the default preset for an unknown id', () => {
        applyPieceOutline('not-a-mode');
        expect(
            document.documentElement.style.getPropertyValue(CSS_CUSTOM_PROPERTY),
        ).toBe(getPieceOutlinePreset(DEFAULT_PIECE_OUTLINE_ID).filter);
    });

    it('sets the idle filter to none for the none and outline presets', () => {
        for (const id of ['none', 'outline']) {
            applyPieceOutline(id);
            expect(
                document.documentElement.style.getPropertyValue(IDLE_CSS_CUSTOM_PROPERTY),
                id,
            ).toBe('none');
        }
    });

    it('sets the idle filter to the preset filter for shadow', () => {
        applyPieceOutline('shadow');
        expect(
            document.documentElement.style.getPropertyValue(IDLE_CSS_CUSTOM_PROPERTY),
        ).toBe(getPieceOutlinePreset('shadow').filter);
    });

    it('exposes the active preset id on the root element for the outline underlay CSS', () => {
        applyPieceOutline('outline');
        expect(document.documentElement.dataset.pieceOutline).toBe('outline');
        applyPieceOutline('not-a-mode');
        expect(document.documentElement.dataset.pieceOutline).toBe(DEFAULT_PIECE_OUTLINE_ID);
        applyPieceOutline('shadow');
        expect(document.documentElement.dataset.pieceOutline).toBe('shadow');
    });
});
