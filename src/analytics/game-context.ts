import { diagnostics } from '../diagnostics.js';
import type { NewGameData } from './umami.js';

/**
 * The `new-game-started` payload of the puzzle in the save slot, so a
 * completion after a reload can still report how the game began (#601).
 * Kept apart from the geometry blob because both start flows write the
 * geometry before the payload exists.
 */
export const GAME_CONTEXT_KEY = 'puzzle-game-analytics';

interface StoredGameContext {
    seed: number;
    startedAt: number;
    data: NewGameData;
}

type TagOf<V> = NonNullable<V> extends string
    ? 'string'
    : NonNullable<V> extends number
      ? 'number'
      : NonNullable<V> extends boolean
        ? 'boolean'
        : never;

const FIELD_TYPES: { [K in keyof NewGameData]-?: TagOf<NewGameData[K]> } = {
    source: 'string',
    cutStyle: 'string',
    traceSetVersion: 'number',
    tracedChunkDegraded: 'boolean',
    bootFallback: 'boolean',
    rotationMode: 'string',
    orientation: 'string',
    cols: 'number',
    rows: 'number',
    pieceCount: 'number',
    imageSource: 'string',
    imageCategory: 'string',
    vibrant: 'boolean',
    imagePicked: 'boolean',
    imagePage: 'number',
    imagePagesKnown: 'number',
    includesProgress: 'boolean',
    recipientHadSavedState: 'boolean',
    sharedColor: 'string',
    generationMode: 'string',
    generationMs: 'number',
    generationFallbackKind: 'string',
    generationFallbackReason: 'string',
};

/**
 * Keyed by `seed` so a record left behind by another puzzle — another tab's
 * start, or a write that failed — is never read back against this one.
 */
export function saveGameContext(
    seed: number | undefined,
    data: NewGameData,
    startedAt: number,
): void {
    if (seed === undefined) return;
    const record: StoredGameContext = { seed, startedAt, data };
    try {
        localStorage.setItem(GAME_CONTEXT_KEY, JSON.stringify(record));
    } catch (error) {
        diagnostics.warn(`Could not save "${GAME_CONTEXT_KEY}":`, error);
        clearGameContext();
    }
}

export function clearGameContext(): void {
    try {
        localStorage.removeItem(GAME_CONTEXT_KEY);
    } catch {}
}

export function loadGameContext(seed: number | undefined): Partial<NewGameData> | null {
    const record = readRecord(seed);
    if (!record || !isRecord(record.data)) return null;
    return readNewGameData(record.data);
}

export function loadGameStartedAt(seed: number | undefined): number | undefined {
    const startedAt = readRecord(seed)?.startedAt;
    return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : undefined;
}

function readRecord(seed: number | undefined): Record<string, unknown> | null {
    if (seed === undefined) return null;
    let parsed: unknown;
    try {
        const raw = localStorage.getItem(GAME_CONTEXT_KEY);
        if (raw === null) return null;
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    return isRecord(parsed) && parsed.seed === seed ? parsed : null;
}

/**
 * Field by field rather than all-or-nothing: a field later added to
 * `NewGameData` would otherwise invalidate the record of every game in
 * progress at deploy.
 */
function readNewGameData(stored: Record<string, unknown>): Partial<NewGameData> {
    const data: Record<string, unknown> = {};
    for (const [key, type] of Object.entries(FIELD_TYPES)) {
        if (typeof stored[key] === type) data[key] = stored[key];
    }
    return data as Partial<NewGameData>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
