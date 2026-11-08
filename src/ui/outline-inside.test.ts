/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    OUTLINE_INSIDE_KEY,
    loadOutlineInsidePreference,
    saveOutlineInsidePreference,
} from './outline-inside.js';

describe('outline-inside preference', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('is off when nothing is saved', () => {
        expect(loadOutlineInsidePreference()).toBe(false);
    });

    it('saves and loads the choice', () => {
        saveOutlineInsidePreference(true);
        expect(localStorage.getItem(OUTLINE_INSIDE_KEY)).toBe('true');
        expect(loadOutlineInsidePreference()).toBe(true);
    });
});
