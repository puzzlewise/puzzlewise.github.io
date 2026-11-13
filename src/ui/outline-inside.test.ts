/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    OUTLINE_INSIDE_KEY,
    loadOutlineInsidePreference,
    saveOutlineInsidePreference,
    applyOutlineInside,
} from './outline-inside.js';

describe('outline-inside preference', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.removeAttribute('data-outline-inside-pref');
    });

    it('is off when nothing is saved', () => {
        expect(loadOutlineInsidePreference()).toBe(false);
    });

    it('saves and loads the choice', () => {
        saveOutlineInsidePreference(true);
        expect(localStorage.getItem(OUTLINE_INSIDE_KEY)).toBe('true');
        expect(loadOutlineInsidePreference()).toBe(true);
    });

    it('flags the root element only while on, apart from the table-level data-outline-inside', () => {
        applyOutlineInside(true);
        expect(document.documentElement.hasAttribute('data-outline-inside-pref')).toBe(true);
        expect(document.documentElement.hasAttribute('data-outline-inside')).toBe(false);

        applyOutlineInside(false);
        expect(document.documentElement.hasAttribute('data-outline-inside-pref')).toBe(false);
    });
});
