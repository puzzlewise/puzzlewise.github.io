/**
 * On `documentElement`, `--piece-edge-idle-filter` is read by `[data-group-id]`
 * and `--piece-edge-filter` by its state variants, via `var(...)`.
 */

import { createIdPreferenceStore } from './preference-store.js';

export interface PieceOutlinePreset {
    /** Persisted in localStorage — must stay stable. */
    id: string;
    label: string;
    description: string;
    filter: string;
    idleFilter?: string;
}

export const PIECE_OUTLINE_PRESETS: readonly PieceOutlinePreset[] = [
    {
        id: 'none',
        label: 'None',
        description: 'No edge',
        // `opacity(1)` is a no-op filter that composes with state-variant filters;
        // the bare `none` keyword doesn't — `filter: none drop-shadow(...)` is
        // invalid CSS and the whole declaration is dropped.
        filter: 'opacity(1)',
        // WebKit composites `opacity(1)` as a real filter on every group layer,
        // which drops a zoomed-out 192-piece pan from ~60 to ~13 fps on iPad (#687).
        idleFilter: 'none',
    },
    {
        id: 'shadow',
        label: 'Shadow',
        description: 'Soft halo',
        filter: 'drop-shadow(0 0 4px rgba(0, 0, 0, 0.35))',
    },
    {
        id: 'outline',
        label: 'Outline',
        description: 'Sharp 1px line',
        filter: 'url(#piece-outline)',
    },
] as const;

export const DEFAULT_PIECE_OUTLINE_ID = 'shadow';
export const PIECE_OUTLINE_PREFERENCE_KEY = 'puzzle-piece-outline';
export const CSS_CUSTOM_PROPERTY = '--piece-edge-filter';
export const IDLE_CSS_CUSTOM_PROPERTY = '--piece-edge-idle-filter';

const store = createIdPreferenceStore({
    key: PIECE_OUTLINE_PREFERENCE_KEY,
    presets: PIECE_OUTLINE_PRESETS,
    defaultId: DEFAULT_PIECE_OUTLINE_ID,
    legacyOrder: [],
});

export const getPieceOutlinePreset = store.getPreset;
export const savePieceOutlinePreference = store.save;
export const loadPieceOutlinePreference = store.load;

export function applyPieceOutline(id: string): void {
    const preset = getPieceOutlinePreset(id);
    const { style } = document.documentElement;
    style.setProperty(CSS_CUSTOM_PROPERTY, preset.filter);
    style.setProperty(IDLE_CSS_CUSTOM_PROPERTY, preset.idleFilter ?? preset.filter);
}
