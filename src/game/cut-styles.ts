import { createIdPreferenceStore } from '../ui/preference-store.js';

export type CutStyle = 'classic' | 'fractal' | 'wavy' | 'triangles' | 'composable';

export interface CutStyleOption {
    id: CutStyle;
    label: string;
    description: string;
    /**
     * Piece rotation when the player enables rotation for a new game. Fractal
     * uses 90° steps; the rest rotate freely (quarter-turns don't match their
     * irregular shapes).
     */
    rotation: 'quarter-turn' | 'free';
}

/**
 * Storage is id-keyed; declaration order no longer matters for persistence.
 * The legacy-integer migration relies on the pre-migration order, captured
 * separately in `LEGACY_ORDER`.
 */
export const CUT_STYLE_OPTIONS: readonly CutStyleOption[] = [
    {
        id: 'classic',
        label: 'Classic',
        description: 'Traditional jigsaw pieces',
        rotation: 'free',
    },
    {
        id: 'fractal',
        label: 'Fractal',
        description: 'Organic circle-packing',
        rotation: 'quarter-turn',
    },
    {
        id: 'wavy',
        label: 'Wavy',
        description: 'Like Classic, but each cut curves boldly',
        rotation: 'free',
    },
    {
        id: 'triangles',
        label: 'Triangles',
        description: 'An irregular lattice of triangles',
        rotation: 'free',
    },
    {
        id: 'composable',
        label: 'Composable',
        description: 'Experimental — customizable cuts',
        rotation: 'free',
    },
] as const;

export const DEFAULT_CUT_STYLE_ID: CutStyle = 'classic';

export const CUT_STYLE_PREFERENCE_KEY = 'puzzle-cut-style';

/**
 * Pre-migration storage order — DO NOT reorder. Removable once enough users
 * have loaded the migrated build.
 */
const LEGACY_ORDER = ['classic', 'fractal', 'composable'] as const;

const store = createIdPreferenceStore({
    key: CUT_STYLE_PREFERENCE_KEY,
    presets: CUT_STYLE_OPTIONS,
    defaultId: DEFAULT_CUT_STYLE_ID,
    legacyOrder: LEGACY_ORDER,
});

export const getCutStyleOption = store.getPreset;
export const saveCutStylePreference = store.save;
export const loadCutStylePreference = store.load;

/**
 * True on `npm run dev` (`import.meta.env.DEV`) and the PR-preview deploy
 * (`/dev/`), false on production. Gates dev-only affordances. Computed
 * per call, not cached, so tests can stub the env.
 */
export function isDevDeploy(): boolean {
    if (import.meta.env.DEV) return true;
    const base = import.meta.env.BASE_URL ?? '';
    return base.includes('/dev/');
}

export function isComposableVisible(): boolean {
    return isDevDeploy();
}

export function getVisibleCutStyleOptions(): readonly CutStyleOption[] {
    if (isComposableVisible()) return CUT_STYLE_OPTIONS;
    return CUT_STYLE_OPTIONS.filter((o) => o.id !== 'composable');
}

/**
 * Reads each style's `rotation` from `CUT_STYLE_OPTIONS`, so a new style must
 * declare its rotation to compile. Only new-game creation uses this; saves and
 * share links carry their own rotationMode, so older quarter-turn puzzles keep
 * loading unchanged.
 */
export function rotationModeForNewGame(
    cutStyle: CutStyle,
    rotationEnabled: boolean,
): 'none' | 'quarter-turn' | 'free' {
    if (!rotationEnabled) return 'none';
    return getCutStyleOption(cutStyle).rotation;
}
