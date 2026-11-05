/**
 * Each preset's `color` is a `var(--color-<id>)` reference, so the outline flips
 * with the OS theme for free; the choice is saved by its stable string id under
 * the outline-scoped `puzzle-piece-<styleId>-color` key.
 */

import { createStringPreference } from './preference-store.js';
import { PALETTE_SWATCHES, type PaletteSwatch } from './palette.js';
import type { SwatchEntry } from './swatch-picker.js';

export type PieceOutlineColorPreset = PaletteSwatch;

/**
 * Default outline color — `gray-darker-3` (#080808): a palette member (so it
 * highlights as selected) that's effectively black in both light and dark mode.
 */
export const DEFAULT_PIECE_OUTLINE_COLOR_ID = 'gray-darker-3';

export const PIECE_OUTLINE_COLOR_PREFERENCE_KEY = 'puzzle-piece-outline-color';

export const CSS_CUSTOM_PROPERTY = '--piece-outline-color';

const swatchById = new Map<string, PaletteSwatch>(
    PALETTE_SWATCHES.map((s) => [s.id, s]),
);

const defaultSwatchOrUndef = swatchById.get(DEFAULT_PIECE_OUTLINE_COLOR_ID);
if (defaultSwatchOrUndef === undefined) {
    throw new Error(
        `DEFAULT_PIECE_OUTLINE_COLOR_ID '${DEFAULT_PIECE_OUTLINE_COLOR_ID}' is not a palette swatch id`,
    );
}
const defaultSwatch: PaletteSwatch = defaultSwatchOrUndef;

/** `satisfies SwatchEntry` so presets feed the swatch picker directly. */
export const PIECE_OUTLINE_COLOR_PRESETS: readonly PieceOutlineColorPreset[] =
    PALETTE_SWATCHES satisfies readonly SwatchEntry[];

const ALLOWED_IDS = PALETTE_SWATCHES.map((s) => s.id);

const store = createStringPreference({
    key: PIECE_OUTLINE_COLOR_PREFERENCE_KEY,
    allowed: ALLOWED_IDS,
    defaultValue: DEFAULT_PIECE_OUTLINE_COLOR_ID,
});

export const savePieceOutlineColorPreference = store.save;
export const loadPieceOutlineColorPreference = store.load;

export function getPieceOutlineColorPreset(
    id: string,
): PieceOutlineColorPreset {
    return swatchById.get(id) ?? defaultSwatch;
}

export function applyPieceOutlineColor(id: string): void {
    const preset = getPieceOutlineColorPreset(id);
    document.documentElement.style.setProperty(
        CSS_CUSTOM_PROPERTY,
        preset.color,
    );
}
