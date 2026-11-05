/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    OUTLINE_CONSTANT_WIDTH_KEY,
    loadOutlineConstantWidthPreference,
    saveOutlineConstantWidthPreference,
    applyOutlineConstantWidth,
} from './outline-constant-width.js';

describe('outline constant-width preference', () => {
    beforeEach(() => {
        localStorage.clear();
        delete document.documentElement.dataset.outlineConstantWidth;
    });

    it('is off when nothing is saved', () => {
        expect(loadOutlineConstantWidthPreference()).toBe(false);
    });

    it('saves and loads the choice', () => {
        saveOutlineConstantWidthPreference(true);
        expect(localStorage.getItem(OUTLINE_CONSTANT_WIDTH_KEY)).toBe('true');
        expect(loadOutlineConstantWidthPreference()).toBe(true);
    });

    it('flags the root element only while on', () => {
        applyOutlineConstantWidth(true);
        expect(document.documentElement.hasAttribute('data-outline-constant-width')).toBe(true);

        applyOutlineConstantWidth(false);
        expect(document.documentElement.hasAttribute('data-outline-constant-width')).toBe(false);
    });
});
