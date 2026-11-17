import { createIdPreferenceStore } from './preference-store.js';

export interface PieceOutlinePreset {
    /** Persisted in localStorage — must stay stable. */
    id: string;
    label: string;
    description: string;
}

const PRESETS = [
    {
        id: 'none',
        label: 'None',
        description: 'No edge',
    },
    {
        id: 'shadow',
        label: 'Shadow',
        description: 'Soft halo',
    },
    {
        id: 'outline',
        label: 'Outline',
        description: 'Sharp line',
    },
] as const satisfies readonly PieceOutlinePreset[];

export type PieceOutlineId = (typeof PRESETS)[number]['id'];

export const PIECE_OUTLINE_PRESETS: readonly PieceOutlinePreset[] = PRESETS;

export const DEFAULT_PIECE_OUTLINE_ID: PieceOutlineId = 'outline';
export const PIECE_OUTLINE_ATTRIBUTE = 'data-piece-outline';
export const PIECE_OUTLINE_PREFERENCE_KEY = 'puzzle-piece-outline';

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
    document.documentElement.setAttribute(PIECE_OUTLINE_ATTRIBUTE, getPieceOutlinePreset(id).id);
}
