/**
 * Each preset's `color` is a `var(--color-<id>)` reference, so background and
 * swatches flip light/dark with the OS theme. Preferences saved before the
 * palette switch (old preset id or bare integer index) migrate via
 * `LEGACY_COLOR_MAP`.
 */

import { diagnostics } from '../diagnostics.js';
import { createStringPreference } from './preference-store.js';
import { PALETTE_SWATCHES, type PaletteSwatch } from './palette.js';
import type { SwatchEntry } from './swatch-picker.js';

export type BackgroundColorPreset = PaletteSwatch;

export const DEFAULT_COLOR_ID = 'glaucous-lighter';

export const COLOR_PREFERENCE_KEY = 'puzzle-background-color';

/**
 * Pre-rename (British spelling) localStorage key; a returning user may still
 * have a preference here, read at load and migrated to {@link COLOR_PREFERENCE_KEY}.
 */
const LEGACY_COLOR_PREFERENCE_KEY = 'puzzle-background-colour';

export const CSS_CUSTOM_PROPERTY = '--puzzle-bg-color';

const swatchById = new Map<string, PaletteSwatch>(
    PALETTE_SWATCHES.map((s) => [s.id, s]),
);

const defaultSwatchOrUndef = swatchById.get(DEFAULT_COLOR_ID);
if (defaultSwatchOrUndef === undefined) {
    throw new Error(
        `DEFAULT_COLOR_ID '${DEFAULT_COLOR_ID}' is not a palette swatch id`,
    );
}
const defaultSwatch: PaletteSwatch = defaultSwatchOrUndef;

/** `satisfies SwatchEntry[]` so presets feed the swatch picker directly. */
export const BACKGROUND_COLOR_PRESETS: readonly BackgroundColorPreset[] =
    PALETTE_SWATCHES satisfies readonly SwatchEntry[];

const ALLOWED_IDS = PALETTE_SWATCHES.map((s) => s.id);

const store = createStringPreference({
    key: COLOR_PREFERENCE_KEY,
    allowed: ALLOWED_IDS,
    defaultValue: DEFAULT_COLOR_ID,
});

export const saveColorPreference = store.save;

/**
 * Each old preset id maps to its nearest new-palette swatch, curated for hue
 * character (grays→grays, pastels stay in-family) rather than blind nearest.
 */
const LEGACY_NEAREST: Record<string, string> = {
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

/**
 * Pre-id storage order: an even-older preference was a bare integer index
 * into this list, so `'3'` resolves to the same target as `'light'`.
 */
const LEGACY_ORDER = [
    'midnight', 'charcoal', 'slate', 'light', 'wood', 'green-felt',
    'hot-pink', 'blush', 'peach', 'sage', 'sky', 'lavender',
] as const;

const LEGACY_COLOR_MAP: Record<string, string> = {
    ...LEGACY_NEAREST,
    ...Object.fromEntries(
        LEGACY_ORDER.map((id, i) => [String(i), LEGACY_NEAREST[id]]),
    ),
};

// Fail fast if a migration target drifts off the palette. Iterate the assembled
// map, not just LEGACY_NEAREST, so a bad integer-index target surfaces too.
for (const target of Object.values(LEGACY_COLOR_MAP)) {
    if (!swatchById.has(target)) {
        throw new Error(
            `Legacy migration target '${target}' is not a palette swatch id`,
        );
    }
}

function resolveStoredId(raw: string): string {
    if (Object.hasOwn(LEGACY_COLOR_MAP, raw)) {
        return LEGACY_COLOR_MAP[raw];
    }
    return ALLOWED_IDS.includes(raw) ? raw : DEFAULT_COLOR_ID;
}

export function loadColorPreference(): string {
    let raw: string | null;
    let fromLegacyKey = false;
    try {
        raw = localStorage.getItem(COLOR_PREFERENCE_KEY);
        if (raw === null) {
            raw = localStorage.getItem(LEGACY_COLOR_PREFERENCE_KEY);
            fromLegacyKey = raw !== null;
        }
    } catch {
        return DEFAULT_COLOR_ID;
    }
    if (raw === null) {
        return DEFAULT_COLOR_ID;
    }
    const resolved = resolveStoredId(raw);
    if (fromLegacyKey) {
        try {
            saveColorPreference(resolved);
            localStorage.removeItem(LEGACY_COLOR_PREFERENCE_KEY);
        } catch {
            // Best-effort; a failed write just retries on the next load.
        }
    }
    return resolved;
}

export type SharedColorOutcome = 'adopted' | 'kept-own' | 'invalid';

/**
 * Adopt a share link's background color only for a recipient who never chose
 * one. Tests raw key existence, since `loadColorPreference()` returns the
 * default either way.
 */
export function adoptSharedBackgroundColor(id: string): SharedColorOutcome {
    if (!ALLOWED_IDS.includes(id)) {
        return 'invalid';
    }
    try {
        if (localStorage.getItem(COLOR_PREFERENCE_KEY) !== null
            || localStorage.getItem(LEGACY_COLOR_PREFERENCE_KEY) !== null) {
            return 'kept-own';
        }
        saveColorPreference(id);
    } catch {
        // Can't inspect or persist the preference; leave it be.
        return 'kept-own';
    }
    applyBackgroundColor(id);
    return 'adopted';
}

export function getColorPreset(id: string): BackgroundColorPreset {
    return swatchById.get(id) ?? defaultSwatch;
}

function parseRgb(color: string): [number, number, number] | null {
    // Accept both legacy comma syntax `rgb(r, g, b)` and CSS Color Level 4
    // space syntax `rgb(r g b / a)`, with optional fractional channels.
    const rgb = color.match(
        /rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)/i,
    );
    if (rgb) {
        return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    }
    const hex = color.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = hex[1];
        return [
            parseInt(n.slice(0, 2), 16),
            parseInt(n.slice(2, 4), 16),
            parseInt(n.slice(4, 6), 16),
        ];
    }
    return null;
}

/** Relative luminance > 0.4, from an already-parsed [r, g, b] (0–255). */
function luminanceIsLight([r, g, b]: [number, number, number]): boolean {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.4;
}

export function isLightColor(color: string): boolean {
    const parsed = parseRgb(color);
    return parsed !== null && luminanceIsLight(parsed);
}

export function applyBackgroundColor(id: string): void {
    const preset = getColorPreset(id);
    // Drives the visible background — style.css applies it on :root.
    document.documentElement.style.setProperty(CSS_CUSTOM_PROPERTY, preset.color);
    // NOT redundant with the line above: this is the read-back target for the
    // chrome decision below. Without it body stays transparent → rgba(0,0,0,0),
    // which parses fine → chrome silently stuck on dark, no warn. Don't
    // "simplify" this away.
    document.body.style.backgroundColor = preset.color;

    // Reading back the `var(--color-…)` resolves to rgb() only once palette.css
    // has loaded (main.ts imports it before boot). If unparseable, chrome
    // defaults to dark; warn so a load-order or naming regression is noticed.
    const resolved = parseRgb(getComputedStyle(document.body).backgroundColor);
    if (resolved === null) {
        diagnostics.warn(
            `applyBackgroundColor: could not parse the resolved background ` +
                `for "${preset.color}" (is palette.css loaded?); ` +
                `defaulting UI chrome to dark`,
        );
    }
    document.documentElement.dataset.uiScheme =
        resolved !== null && luminanceIsLight(resolved) ? 'light' : 'dark';
}
