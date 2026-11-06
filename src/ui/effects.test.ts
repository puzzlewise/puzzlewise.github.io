/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    EFFECTS_PRESETS,
    EFFECTS_PREFERENCE_KEY,
    DEFAULT_EFFECTS_ID,
    detectEffectsLevel,
    readEffectsSignals,
    resetDetectedEffectsLevelForTests,
    describeAuto,
    loadEffectsPreference,
    saveEffectsPreference,
    resolveEffectsLevel,
    applyEffects,
    type EffectsSignals,
} from './effects.js';

const IPAD_17_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.14 Safari/605.1.15';
const IPAD_HOME_SCREEN_APP =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const MAC_SAFARI_18 =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const IPHONE_SAFARI_26_FROZEN_OS =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME_IOS_17 =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const WINDOWS_FIREFOX =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';

describe('detectEffectsLevel', () => {
    const cases: [string, EffectsSignals, 'full' | 'simple'][] = [
        ['iPad Safari 17', { userAgent: IPAD_17_SAFARI, maxTouchPoints: 5, deviceMemory: undefined, hasWebKit26Features: false }, 'simple'],
        ['iPad home-screen app without Version/', { userAgent: IPAD_HOME_SCREEN_APP, maxTouchPoints: 5, deviceMemory: undefined, hasWebKit26Features: false }, 'simple'],
        ['Mac Safari 18 (no touch)', { userAgent: MAC_SAFARI_18, maxTouchPoints: 0, deviceMemory: undefined, hasWebKit26Features: false }, 'full'],
        ['iPhone Safari 26 with frozen OS 18_6 token', { userAgent: IPHONE_SAFARI_26_FROZEN_OS, maxTouchPoints: 5, deviceMemory: undefined, hasWebKit26Features: true }, 'full'],
        ['Chrome on iOS 17', { userAgent: IPHONE_CHROME_IOS_17, maxTouchPoints: 5, deviceMemory: undefined, hasWebKit26Features: false }, 'simple'],
        ['Android Chrome, 2 GB', { userAgent: ANDROID_CHROME, maxTouchPoints: 5, deviceMemory: 2, hasWebKit26Features: false }, 'simple'],
        ['Android Chrome, 4 GB', { userAgent: ANDROID_CHROME, maxTouchPoints: 5, deviceMemory: 4, hasWebKit26Features: false }, 'full'],
        ['Windows Firefox, no deviceMemory', { userAgent: WINDOWS_FIREFOX, maxTouchPoints: 0, deviceMemory: undefined, hasWebKit26Features: false }, 'full'],
    ];

    it.each(cases)('%s', (_name, signals, expected) => {
        expect(detectEffectsLevel(signals)).toBe(expected);
    });
});

describe('readEffectsSignals', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reports no WebKit 26 features when CSS.supports is unavailable', () => {
        vi.stubGlobal('CSS', undefined);
        expect(readEffectsSignals().hasWebKit26Features).toBe(false);
    });

    it('reports WebKit 26 features when contrast-color() is supported', () => {
        vi.stubGlobal('CSS', {
            supports: (prop: string, value?: string) => prop === 'color' && value === 'contrast-color(red)',
        });
        expect(readEffectsSignals().hasWebKit26Features).toBe(true);
    });

    it('reports WebKit 26 features when scroll-driven animations are supported', () => {
        vi.stubGlobal('CSS', {
            supports: (prop: string, value?: string) => prop === 'animation-timeline' && value === 'scroll()',
        });
        expect(readEffectsSignals().hasWebKit26Features).toBe(true);
    });
});

describe('EFFECTS_PRESETS', () => {
    it('lists auto, full and simple in that order', () => {
        expect(EFFECTS_PRESETS.map((p) => [p.id, p.label])).toEqual([
            ['auto', 'Auto'],
            ['full', 'Full'],
            ['simple', 'Simple'],
        ]);
    });

    it('describes what Auto resolved to', () => {
        expect(describeAuto('simple')).toBe('Simple on this device');
        expect(describeAuto('full')).toBe('Full on this device');
    });
});

describe('loadEffectsPreference / saveEffectsPreference', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('defaults to auto', () => {
        expect(DEFAULT_EFFECTS_ID).toBe('auto');
        expect(loadEffectsPreference()).toBe('auto');
    });

    it('round-trips a saved id', () => {
        saveEffectsPreference('simple');
        expect(localStorage.getItem(EFFECTS_PREFERENCE_KEY)).toBe('simple');
        expect(loadEffectsPreference()).toBe('simple');
    });

    it('falls back to auto for an unknown saved value', () => {
        localStorage.setItem(EFFECTS_PREFERENCE_KEY, 'bogus');
        expect(loadEffectsPreference()).toBe('auto');
    });

    it('falls back to auto when localStorage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        expect(loadEffectsPreference()).toBe('auto');
    });
});

describe('resolveEffectsLevel', () => {
    it.each([
        ['auto', 'simple', 'simple'],
        ['auto', 'full', 'full'],
        ['full', 'simple', 'full'],
        ['simple', 'full', 'simple'],
        ['bogus', 'simple', 'simple'],
    ] as const)('%s with %s detected resolves to %s', (id, detected, expected) => {
        expect(resolveEffectsLevel(id, detected)).toBe(expected);
    });
});

describe('applyEffects', () => {
    beforeEach(() => {
        resetDetectedEffectsLevelForTests();
        delete document.documentElement.dataset.effects;
    });

    it('writes the resolved level to the root element', () => {
        applyEffects('simple');
        expect(document.documentElement.dataset.effects).toBe('simple');

        applyEffects('full');
        expect(document.documentElement.dataset.effects).toBe('full');
    });

    it('resolves auto from the detected level', () => {
        applyEffects('auto');
        expect(document.documentElement.dataset.effects).toBe('full');
    });
});
