/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    CUT_STYLE_OPTIONS,
    DEFAULT_CUT_STYLE_ID,
    CUT_STYLE_PREFERENCE_KEY,
    getCutStyleOption,
    saveCutStylePreference,
    loadCutStylePreference,
    getVisibleCutStyleOptions,
    isComposableVisible,
    isDevDeploy,
    rotationModeForNewGame,
} from './cut-styles.js';

describe('CUT_STYLE_OPTIONS', () => {
    it('has at least two options', () => {
        expect(CUT_STYLE_OPTIONS.length).toBeGreaterThanOrEqual(2);
    });

    it('includes classic, fractal, composable', () => {
        const ids = CUT_STYLE_OPTIONS.map((o) => o.id);
        expect(ids).toContain('classic');
        expect(ids).toContain('fractal');
        expect(ids).toContain('composable');
    });

    it('default id is "classic"', () => {
        expect(DEFAULT_CUT_STYLE_ID).toBe('classic');
    });

    it('includes wavy between fractal and composable', () => {
        const ids = CUT_STYLE_OPTIONS.map((o) => o.id);
        const fractalIdx = ids.indexOf('fractal');
        const wavyIdx = ids.indexOf('wavy');
        const composableIdx = ids.indexOf('composable');
        expect(wavyIdx).toBeGreaterThan(fractalIdx);
        expect(composableIdx).toBeGreaterThan(wavyIdx);
    });

    it('renders wavy in the visible list on production', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/');
        const ids = getVisibleCutStyleOptions().map((o) => o.id);
        expect(ids).toContain('wavy');
        vi.unstubAllEnvs();
    });

    it('includes triangles between wavy and composable', () => {
        const ids = CUT_STYLE_OPTIONS.map((o) => o.id);
        expect(ids.indexOf('triangles')).toBeGreaterThan(ids.indexOf('wavy'));
        expect(ids.indexOf('composable')).toBeGreaterThan(ids.indexOf('triangles'));
    });
});

describe('getCutStyleOption', () => {
    it('returns the option matching an id', () => {
        expect(getCutStyleOption('classic').id).toBe('classic');
        expect(getCutStyleOption('fractal').id).toBe('fractal');
    });

    it('returns the default for an unknown id', () => {
        expect(getCutStyleOption('not-a-style').id).toBe('classic');
    });
});

describe('saveCutStylePreference / loadCutStylePreference', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('returns default when nothing is saved', () => {
        expect(loadCutStylePreference()).toBe(DEFAULT_CUT_STYLE_ID);
    });

    it('round-trips an id', () => {
        saveCutStylePreference('fractal');
        expect(loadCutStylePreference()).toBe('fractal');
    });

    it('migrates legacy integer indices to ids', () => {
        // Pre-migration order: classic=0, fractal=1, composable=2.
        localStorage.setItem(CUT_STYLE_PREFERENCE_KEY, '0');
        expect(loadCutStylePreference()).toBe('classic');
        localStorage.setItem(CUT_STYLE_PREFERENCE_KEY, '1');
        expect(loadCutStylePreference()).toBe('fractal');
        localStorage.setItem(CUT_STYLE_PREFERENCE_KEY, '2');
        expect(loadCutStylePreference()).toBe('composable');
    });

    it('returns default for unknown stored values', () => {
        localStorage.setItem(CUT_STYLE_PREFERENCE_KEY, 'garbage');
        expect(loadCutStylePreference()).toBe(DEFAULT_CUT_STYLE_ID);
    });
});

describe('getVisibleCutStyleOptions', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('hides composable on production builds', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/');
        const ids = getVisibleCutStyleOptions().map((o) => o.id);
        expect(ids).not.toContain('composable');
    });

    it('shows composable on dev-deploys (BASE_URL contains /dev/)', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/dev/');
        const ids = getVisibleCutStyleOptions().map((o) => o.id);
        expect(ids).toContain('composable');
    });

    it('shows composable when import.meta.env.DEV is truthy', () => {
        vi.stubEnv('DEV', true);
        vi.stubEnv('BASE_URL', '/');
        const ids = getVisibleCutStyleOptions().map((o) => o.id);
        expect(ids).toContain('composable');
    });

    it('shows triangles on production builds', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/');
        const ids = getVisibleCutStyleOptions().map((o) => o.id);
        expect(ids).toContain('triangles');
    });
});

describe('isComposableVisible', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('returns false on a production build (no DEV, no /dev/ in BASE_URL)', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/');
        expect(isComposableVisible()).toBe(false);
    });

    it('returns true when BASE_URL contains "/dev/"', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/dev/');
        expect(isComposableVisible()).toBe(true);
    });

    it('returns true when DEV is set', () => {
        vi.stubEnv('DEV', true);
        vi.stubEnv('BASE_URL', '/');
        expect(isComposableVisible()).toBe(true);
    });
});

describe('isDevDeploy', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('returns false on a production build (no DEV, no /dev/ in BASE_URL)', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/');
        expect(isDevDeploy()).toBe(false);
    });

    it('returns true when BASE_URL contains "/dev/"', () => {
        vi.stubEnv('DEV', false);
        vi.stubEnv('BASE_URL', '/dev/');
        expect(isDevDeploy()).toBe(true);
    });

    it('returns true when DEV is set', () => {
        vi.stubEnv('DEV', true);
        vi.stubEnv('BASE_URL', '/');
        expect(isDevDeploy()).toBe(true);
    });
});

describe('rotationModeForNewGame', () => {
    it('returns none when rotation is disabled, for every cut style', () => {
        for (const option of CUT_STYLE_OPTIONS) {
            expect(rotationModeForNewGame(option.id, false)).toBe('none');
        }
    });

    it('returns quarter-turn for fractal', () => {
        expect(rotationModeForNewGame('fractal', true)).toBe('quarter-turn');
    });

    it('returns free for classic, wavy, triangles, and composable', () => {
        expect(rotationModeForNewGame('classic', true)).toBe('free');
        expect(rotationModeForNewGame('wavy', true)).toBe('free');
        expect(rotationModeForNewGame('triangles', true)).toBe('free');
        expect(rotationModeForNewGame('composable', true)).toBe('free');
    });
});
