/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { diagnostics } from '../diagnostics.js';
import {
    BACKGROUND_COLOR_PRESETS,
    DEFAULT_COLOR_ID,
    COLOR_PREFERENCE_KEY,
    CSS_CUSTOM_PROPERTY,
    getColorPreset,
    saveColorPreference,
    loadColorPreference,
    applyBackgroundColor,
    isLightColor,
    adoptSharedBackgroundColor,
} from './background-color.js';

describe('BACKGROUND_COLOR_PRESETS', () => {
    it('exposes the full palette (140 presets)', () => {
        expect(BACKGROUND_COLOR_PRESETS.length).toBe(140);
    });

    it('each preset color is a var(--color-…) reference', () => {
        for (const p of BACKGROUND_COLOR_PRESETS) {
            expect(p.color).toMatch(/^var\(--color-[a-z]+-[a-z0-9-]+\)$/);
        }
    });

    it('defaults to the light glaucous swatch', () => {
        expect(DEFAULT_COLOR_ID).toBe('glaucous-lighter');
    });

    it('default id resolves to a preset', () => {
        expect(
            BACKGROUND_COLOR_PRESETS.some((p) => p.id === DEFAULT_COLOR_ID),
        ).toBe(true);
    });
});

describe('getColorPreset', () => {
    it('returns the matching preset', () => {
        const preset = getColorPreset('blue-default');
        expect(preset.id).toBe('blue-default');
        expect(preset.color).toBe('var(--color-blue-default)');
    });

    it('falls back to the default for an unknown id', () => {
        expect(getColorPreset('nope').id).toBe(DEFAULT_COLOR_ID);
    });
});

describe('loadColorPreference', () => {
    beforeEach(() => localStorage.clear());

    it('returns the default when nothing is saved', () => {
        expect(loadColorPreference()).toBe(DEFAULT_COLOR_ID);
    });

    it('round-trips a valid id', () => {
        saveColorPreference('green-dark');
        expect(loadColorPreference()).toBe('green-dark');
    });

    it('migrates each old string id to its specific nearest swatch', () => {
        // Assert the exact target for each old preset: a typo would otherwise
        // be masked by the default fallback resolving to a real swatch anyway.
        const expected: Record<string, string> = {
            midnight: 'indigo-darker',
            charcoal: 'gray-darker',
            slate: 'glaucous-dark',
            light: 'gray-light',
            wood: 'brown-dark',
            'green-felt': 'green-darker',
            'hot-pink': 'magenta-default',
            blush: 'red-lighter',
            peach: 'orange-lighter',
            sage: 'green-lighter',
            sky: 'blue-lighter',
            lavender: 'violet-lighter',
        };
        for (const [legacy, target] of Object.entries(expected)) {
            localStorage.setItem(COLOR_PREFERENCE_KEY, legacy);
            expect(loadColorPreference()).toBe(target);
        }
    });

    it('migrates a legacy integer index to the same target as its id', () => {
        localStorage.setItem(COLOR_PREFERENCE_KEY, '0'); // midnight
        expect(loadColorPreference()).toBe('indigo-darker');
        localStorage.setItem(COLOR_PREFERENCE_KEY, '3'); // light
        expect(loadColorPreference()).toBe('gray-light');
        localStorage.setItem(COLOR_PREFERENCE_KEY, '11'); // lavender
        expect(loadColorPreference()).toBe('violet-lighter');
    });

    it('falls back to default for an unrecognized value', () => {
        localStorage.setItem(COLOR_PREFERENCE_KEY, 'totally-unknown');
        expect(loadColorPreference()).toBe(DEFAULT_COLOR_ID);
    });

    it('ignores Object.prototype keys (returns a real string id)', () => {
        for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            localStorage.setItem(COLOR_PREFERENCE_KEY, key);
            expect(loadColorPreference()).toBe(DEFAULT_COLOR_ID);
        }
    });

    it('falls back to default for an out-of-range legacy index', () => {
        localStorage.setItem(COLOR_PREFERENCE_KEY, '99');
        expect(loadColorPreference()).toBe(DEFAULT_COLOR_ID);
    });

    it('migrates a value under the old British-spelling key', () => {
        // A returning user with a preference saved before the key rename.
        localStorage.setItem('puzzle-background-colour', 'green-dark');
        expect(loadColorPreference()).toBe('green-dark');
        // Migration is one-time: rewritten under the new key, old one dropped.
        expect(localStorage.getItem(COLOR_PREFERENCE_KEY)).toBe('green-dark');
        expect(localStorage.getItem('puzzle-background-colour')).toBeNull();
    });

    it('migrates a legacy id stored under the old key to its nearest swatch', () => {
        localStorage.setItem('puzzle-background-colour', 'midnight');
        expect(loadColorPreference()).toBe('indigo-darker');
        expect(localStorage.getItem(COLOR_PREFERENCE_KEY)).toBe('indigo-darker');
        expect(localStorage.getItem('puzzle-background-colour')).toBeNull();
    });

    it('prefers the new key over the old when both exist', () => {
        localStorage.setItem(COLOR_PREFERENCE_KEY, 'blue-default');
        localStorage.setItem('puzzle-background-colour', 'green-dark');
        expect(loadColorPreference()).toBe('blue-default');
        expect(localStorage.getItem('puzzle-background-colour')).toBe('green-dark');
    });
});

describe('isLightColor', () => {
    it('classifies rgb() strings (from getComputedStyle)', () => {
        expect(isLightColor('rgb(245, 245, 245)')).toBe(true);
        expect(isLightColor('rgb(26, 35, 126)')).toBe(false);
    });

    it('classifies hex strings', () => {
        expect(isLightColor('#ffffff')).toBe(true);
        expect(isLightColor('#000000')).toBe(false);
    });

    it('treats an unparseable color as dark', () => {
        expect(isLightColor('')).toBe(false);
    });

    it('classifies space-separated rgb() (CSS Color L4)', () => {
        expect(isLightColor('rgb(245 245 245)')).toBe(true);
        expect(isLightColor('rgb(26 35 126)')).toBe(false);
    });
});

describe('applyBackgroundColor', () => {
    beforeEach(() => {
        document.documentElement.style.removeProperty(CSS_CUSTOM_PROPERTY);
        document.body.style.backgroundColor = '';
        delete document.documentElement.dataset.uiScheme;
    });
    afterEach(() => vi.restoreAllMocks());

    it('sets the custom property to the variable reference', () => {
        // Stub a resolvable color so the chrome path doesn't warn (jsdom can't
        // resolve var() on its own).
        vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            backgroundColor: 'rgb(33, 150, 243)',
        } as CSSStyleDeclaration);
        const warn = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        applyBackgroundColor('blue-default');
        expect(
            document.documentElement.style.getPropertyValue(CSS_CUSTOM_PROPERTY),
        ).toBe('var(--color-blue-default)');
        expect(warn).not.toHaveBeenCalled();
    });

    it('warns and defaults to dark chrome when the color cannot be resolved', () => {
        // Mirrors a missing/unloaded palette.css: getComputedStyle returns
        // an empty, unparseable background-color.
        vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            backgroundColor: '',
        } as CSSStyleDeclaration);
        const warn = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        applyBackgroundColor('blue-default');
        expect(warn).toHaveBeenCalledOnce();
        expect(document.documentElement.dataset.uiScheme).toBe('dark');
    });

    it('sets a light ui-scheme when the resolved color is light', () => {
        vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            backgroundColor: 'rgb(245, 245, 245)',
        } as CSSStyleDeclaration);
        applyBackgroundColor('gray-lighter');
        expect(document.documentElement.dataset.uiScheme).toBe('light');
    });

    it('sets a dark ui-scheme when the resolved color is dark', () => {
        vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            backgroundColor: 'rgb(26, 35, 126)',
        } as CSSStyleDeclaration);
        applyBackgroundColor('indigo-darker');
        expect(document.documentElement.dataset.uiScheme).toBe('dark');
    });

    it('derives the chrome from the color written to document.body', () => {
        // Regression guard: applyBackgroundColor writes body's backgroundColor
        // so it can read it back to pick the ui-scheme. This mock resolves the
        // var() off body's inline style, so it fails if that write is removed.
        vi.spyOn(window, 'getComputedStyle').mockImplementation(
            (el: Element) =>
                ({
                    backgroundColor:
                        (el as HTMLElement).style.backgroundColor ===
                        'var(--color-gray-lighter)'
                            ? 'rgb(245, 245, 245)'
                            : '',
                }) as CSSStyleDeclaration,
        );
        const warn = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        applyBackgroundColor('gray-lighter');
        expect(document.body.style.backgroundColor).toBe(
            'var(--color-gray-lighter)',
        );
        expect(document.documentElement.dataset.uiScheme).toBe('light');
        expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to the default preset for an unknown id', () => {
        applyBackgroundColor('not-a-color');
        expect(
            document.documentElement.style.getPropertyValue(CSS_CUSTOM_PROPERTY),
        ).toBe(`var(--color-${DEFAULT_COLOR_ID})`);
    });
});

describe('adoptSharedBackgroundColor', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.style.removeProperty(CSS_CUSTOM_PROPERTY);
    });
    afterEach(() => vi.restoreAllMocks());

    it('adopts and persists when no preference exists', () => {
        // Stub a resolvable color so applyBackgroundColor's chrome path doesn't
        // warn (jsdom can't resolve var() on its own).
        vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            backgroundColor: 'rgb(27, 94, 32)',
        } as CSSStyleDeclaration);
        const warn = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        const outcome = adoptSharedBackgroundColor('green-darker');
        expect(outcome).toBe('adopted');
        expect(localStorage.getItem(COLOR_PREFERENCE_KEY)).toBe('green-darker');
        expect(
            document.documentElement.style.getPropertyValue(CSS_CUSTOM_PROPERTY),
        ).toBe('var(--color-green-darker)');
        expect(warn).not.toHaveBeenCalled();
    });

    it('keeps an existing preference untouched', () => {
        saveColorPreference('blue-default');
        expect(adoptSharedBackgroundColor('green-darker')).toBe('kept-own');
        expect(localStorage.getItem(COLOR_PREFERENCE_KEY)).toBe('blue-default');
    });

    it('treats a legacy British-spelling key as an existing preference', () => {
        localStorage.setItem('puzzle-background-colour', 'midnight');
        expect(adoptSharedBackgroundColor('green-darker')).toBe('kept-own');
        expect(localStorage.getItem('puzzle-background-colour')).toBe('midnight');
        expect(localStorage.getItem(COLOR_PREFERENCE_KEY)).toBeNull();
    });

    it('rejects an unknown swatch id without storing anything', () => {
        expect(adoptSharedBackgroundColor('hotdog-stand')).toBe('invalid');
        expect(localStorage.getItem(COLOR_PREFERENCE_KEY)).toBeNull();
    });

    it('keeps its own color when persisting the write throws', () => {
        // Safari private-mode-style quota failure: reads succeed but the write
        // throws; the helper should land in 'kept-own' rather than letting the
        // exception escape.
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        expect(adoptSharedBackgroundColor('green-darker')).toBe('kept-own');
        expect(
            document.documentElement.style.getPropertyValue(CSS_CUSTOM_PROPERTY),
        ).not.toBe('var(--color-green-darker)');
    });
});
