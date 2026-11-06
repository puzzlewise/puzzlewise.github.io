import { createIdPreferenceStore } from './preference-store.js';

export type EffectsLevel = 'full' | 'simple';

export interface EffectsSignals {
    userAgent: string;
    maxTouchPoints: number;
    deviceMemory: number | undefined;
    hasWebKit26Features: boolean;
}

export interface EffectsPreset {
    id: 'auto' | 'full' | 'simple';
    label: string;
    description: string;
}

export const EFFECTS_PRESETS: readonly EffectsPreset[] = [
    { id: 'auto', label: 'Auto', description: '' },
    { id: 'full', label: 'Full', description: 'Soft shadows and glow' },
    { id: 'simple', label: 'Simple', description: 'Lighter on older devices' },
] as const;

export const EFFECTS_PREFERENCE_KEY = 'puzzle-effects';
export const DEFAULT_EFFECTS_ID = 'auto';

const store = createIdPreferenceStore({
    key: EFFECTS_PREFERENCE_KEY,
    presets: EFFECTS_PRESETS,
    defaultId: DEFAULT_EFFECTS_ID,
    legacyOrder: [],
});

export const loadEffectsPreference = store.load;
export const saveEffectsPreference = store.save;

/**
 * On iOS every browser and web view runs the system WebKit, whose features track
 * the OS version; the UA does not (Safari 26 freezes its OS token at 18.x, and
 * home-screen apps may omit `Version/`). A WebKit 26 feature therefore marks
 * iOS/iPadOS 26+, which requires an A12 or newer.
 */
export function detectEffectsLevel(signals: EffectsSignals): EffectsLevel {
    const { userAgent, maxTouchPoints, deviceMemory, hasWebKit26Features } = signals;
    const isAppleTouch = /\b(iPhone|iPad|iPod)\b/.test(userAgent)
        || (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1);
    if (isAppleTouch) {
        return hasWebKit26Features ? 'full' : 'simple';
    }
    return deviceMemory !== undefined && deviceMemory <= 2 ? 'simple' : 'full';
}

export function readEffectsSignals(): EffectsSignals {
    const supports = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        ? (prop: string, value: string) => CSS.supports(prop, value)
        : () => false;
    const memory: unknown = (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory;
    return {
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        deviceMemory: typeof memory === 'number' ? memory : undefined,
        hasWebKit26Features: supports('color', 'contrast-color(red)')
            || supports('animation-timeline', 'scroll()'),
    };
}

let detected: EffectsLevel | undefined;

export function getDetectedEffectsLevel(): EffectsLevel {
    detected ??= detectEffectsLevel(readEffectsSignals());
    return detected;
}

export function resetDetectedEffectsLevelForTests(): void {
    detected = undefined;
}

export function describeAuto(level: EffectsLevel): string {
    return level === 'simple' ? 'Simple on this device' : 'Full on this device';
}

export function resolveEffectsLevel(id: string, detectedLevel: EffectsLevel): EffectsLevel {
    if (id === 'full' || id === 'simple') return id;
    return detectedLevel;
}

export function currentEffectsLevel(): EffectsLevel {
    return resolveEffectsLevel(loadEffectsPreference(), getDetectedEffectsLevel());
}

export function usesRings(level: EffectsLevel): boolean {
    switch (level) {
        case 'simple':
            return true;
        case 'full':
            return false;
    }
}

export function applyEffects(id: string): EffectsLevel {
    const level = resolveEffectsLevel(id, getDetectedEffectsLevel());
    document.documentElement.dataset.effects = level;
    return level;
}
