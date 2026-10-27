/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    IMAGE_CATEGORY_OPTIONS,
    IMAGE_CATEGORY_PREFERENCE_KEY,
    VIBRANT_PREFERENCE_KEY,
    buildImageQuery,
    resolveQueryOverride,
    isCustomQuery,
    findImageCategory,
    loadImageCategoryPreference,
    loadVibrantPreference,
    saveImageCategoryPreference,
    saveVibrantPreference,
} from './image-categories.js';

describe('IMAGE_CATEGORY_OPTIONS', () => {
    it('has at least two options', () => {
        expect(IMAGE_CATEGORY_OPTIONS.length).toBeGreaterThanOrEqual(2);
    });

    it('has "any" as the first option', () => {
        expect(IMAGE_CATEGORY_OPTIONS[0].id).toBe('any');
    });

    it('"any" has no query', () => {
        expect(IMAGE_CATEGORY_OPTIONS[0].query).toBeUndefined();
    });

    it('all non-any options have a query string', () => {
        for (const opt of IMAGE_CATEGORY_OPTIONS.slice(1)) {
            expect(opt.query).toBeTruthy();
        }
    });

    it('all options have unique ids', () => {
        const ids = IMAGE_CATEGORY_OPTIONS.map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('findImageCategory', () => {
    it('finds a known category by id', () => {
        const result = findImageCategory('nature');
        expect(result.id).toBe('nature');
        expect(result.query).toBe('nature');
    });

    it("has an Astronomy category querying 'astronomy'", () => {
        const result = findImageCategory('astronomy');
        expect(result.id).toBe('astronomy');
        expect(result.label).toBe('Astronomy');
        expect(result.query).toBe('astronomy');
    });

    it("returns 'any' for the retired space id", () => {
        expect(findImageCategory('space').id).toBe('any');
    });

    it('finds the people category with the bare tag query', () => {
        const result = findImageCategory('people');
        expect(result.id).toBe('people');
        expect(result.query).toBe('people');
    });

    it('finds the face category with the person-face query', () => {
        const result = findImageCategory('face');
        expect(result.id).toBe('face');
        expect(result.query).toBe('person face');
    });

    it('returns "any" for an unknown id', () => {
        const result = findImageCategory('nonexistent');
        expect(result.id).toBe('any');
    });

    it('returns "any" for an empty string', () => {
        const result = findImageCategory('');
        expect(result.id).toBe('any');
    });
});

describe('image category preference persistence', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('returns "any" when nothing is saved', () => {
        expect(loadImageCategoryPreference()).toBe('any');
    });

    it('saves and loads a category preference', () => {
        saveImageCategoryPreference('astronomy');
        expect(loadImageCategoryPreference()).toBe('astronomy');
    });

    it("loads 'astronomy' when the retired space id is stored", () => {
        localStorage.setItem(IMAGE_CATEGORY_PREFERENCE_KEY, 'space');
        expect(loadImageCategoryPreference()).toBe('astronomy');
    });

    it('uses the correct localStorage key', () => {
        saveImageCategoryPreference('food');
        expect(localStorage.getItem(IMAGE_CATEGORY_PREFERENCE_KEY)).toBe(
            'food',
        );
    });

    it('returns "any" for an invalid saved value', () => {
        localStorage.setItem(IMAGE_CATEGORY_PREFERENCE_KEY, 'invalid-id');
        expect(loadImageCategoryPreference()).toBe('any');
    });

    it('overwrites the previous preference', () => {
        saveImageCategoryPreference('nature');
        saveImageCategoryPreference('travel');
        expect(loadImageCategoryPreference()).toBe('travel');
    });
});

describe('vibrant preference persistence', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('defaults to false when nothing is saved', () => {
        expect(loadVibrantPreference()).toBe(false);
    });

    it('saves and loads true', () => {
        saveVibrantPreference(true);
        expect(loadVibrantPreference()).toBe(true);
    });

    it('saves and loads false', () => {
        saveVibrantPreference(true);
        saveVibrantPreference(false);
        expect(loadVibrantPreference()).toBe(false);
    });

    it('uses the documented localStorage key', () => {
        saveVibrantPreference(true);
        expect(localStorage.getItem(VIBRANT_PREFERENCE_KEY)).toBe('true');
    });

    it('returns false for a garbage saved value', () => {
        localStorage.setItem(VIBRANT_PREFERENCE_KEY, 'not-a-boolean');
        expect(loadVibrantPreference()).toBe(false);
    });
});

describe('resolveQueryOverride', () => {
    it('uses the override when it is a non-empty string', () => {
        expect(resolveQueryOverride('nature', 'red bicycles')).toBe('red bicycles');
    });

    it('overrides even the empty "any" category (undefined query)', () => {
        expect(resolveQueryOverride(undefined, 'red bicycles')).toBe('red bicycles');
    });

    it('trims surrounding whitespace from the override', () => {
        expect(resolveQueryOverride('nature', '  red bicycles  ')).toBe('red bicycles');
    });

    it('falls back to the category query when the override is undefined', () => {
        expect(resolveQueryOverride('nature', undefined)).toBe('nature');
    });

    it('falls back to the category query when the override is empty', () => {
        expect(resolveQueryOverride('nature', '')).toBe('nature');
    });

    it('falls back to the category query when the override is whitespace only', () => {
        expect(resolveQueryOverride('nature', '   ')).toBe('nature');
    });
});

describe('buildImageQuery', () => {
    it('returns undefined when no category query and vibrant is off', () => {
        expect(buildImageQuery(undefined, false)).toBeUndefined();
    });

    it('returns the category query unchanged when vibrant is off', () => {
        expect(buildImageQuery('nature landscape', false)).toBe(
            'nature landscape',
        );
    });

    it('returns vibrant keywords when no category query and vibrant is on', () => {
        const result = buildImageQuery(undefined, true);
        expect(result).toBeDefined();
        expect(result).toMatch(/vibrant/);
    });

    it('appends vibrant keywords to the category query when vibrant is on', () => {
        const result = buildImageQuery('nature landscape', true);
        expect(result).toMatch(/^nature landscape/);
        expect(result).toMatch(/vibrant/);
    });
});

describe('isCustomQuery', () => {
    it('is true exactly when the override replaces the category query', () => {
        expect(isCustomQuery('red bicycles')).toBe(true);
        expect(isCustomQuery('  ')).toBe(false);
        expect(isCustomQuery('')).toBe(false);
        expect(isCustomQuery(undefined)).toBe(false);
    });
});
