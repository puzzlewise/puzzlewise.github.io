/**
 * On `documentElement`, `--piece-edge-idle-filter` is read by `[data-group-id]`
 * and `--piece-edge-filter` by its state variants, via `var(...)`;
 * `data-piece-outline` holds the active preset id.
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

const PRESETS = [
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
        description: 'Sharp line',
        // Drawn by the renderer's per-group underlay instead: any filter on
        // the group layers is paid on every frame (#687).
        filter: 'opacity(1)',
        idleFilter: 'none',
    },
] as const satisfies readonly PieceOutlinePreset[];

export type PieceOutlineId = (typeof PRESETS)[number]['id'];

export const PIECE_OUTLINE_PRESETS: readonly PieceOutlinePreset[] = PRESETS;

export const DEFAULT_PIECE_OUTLINE_ID: PieceOutlineId = 'outline';
export const PIECE_OUTLINE_ATTRIBUTE = 'data-piece-outline';
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
    const root = document.documentElement;
    root.setAttribute(PIECE_OUTLINE_ATTRIBUTE, preset.id);
    const { style } = root;
    style.setProperty(CSS_CUSTOM_PROPERTY, preset.filter);
    style.setProperty(IDLE_CSS_CUSTOM_PROPERTY, preset.idleFilter ?? preset.filter);
}
