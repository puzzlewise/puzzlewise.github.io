/**
 * @vitest-environment jsdom
 */

// vi.mock is hoisted to the top by Vitest. Wrapping decompressFromStorage in a
// vi.fn pass-through makes it spy-able even when called from within storage.ts,
// which holds a direct binding to the function. The mock calls the real
// implementation, so all other tests continue to work correctly.
vi.mock('./compression.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./compression.js')>();
    return {
        ...actual,
        decompressFromStorage: vi.fn(actual.decompressFromStorage),
    };
});

import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import type { GameState, PieceGroup } from '../model/types.js';
import * as compression from './compression.js';
import { COMPRESSED_MARKER } from './compression.js';
import {
    STATE_VERSION,
    serializeProgress,
    serializeStatic,
    type SerializedViewport,
} from './serialization.js';
import {
    saveGeometry,
    saveProgress,
    saveNewPuzzle,
    loadState,
    loadSavedGame,
    createDebouncedSave,
    installGeometryTokenInvalidation,
    STORAGE_KEY,
    PROGRESS_KEY,
    GEOMETRY_SEED_KEY,
} from './storage.js';
import {
    makeRectPiece,
    makeGameState as makeBaseGameState,
} from '../test-helpers/fixtures.js';
import { v13Progress, v13StaticBlob } from '../test-helpers/v13-save.js';

// The app installs these from bootstrap.ts; this stands in. Installed once, as
// production does — jsdom shares `window` across tests and the installer is
// idempotent (see "registers each listener once").
beforeAll(() => {
    installGeometryTokenInvalidation();
});

function loadedSelection(): number[] {
    const outcome = loadSavedGame();
    return outcome.status === 'ok' ? outcome.selection : [];
}

function loadedViewport(): SerializedViewport | undefined {
    const outcome = loadSavedGame();
    return outcome.status === 'ok' ? outcome.viewport : undefined;
}

function expectLoaded(): { state: GameState; selection: number[] } {
    const outcome = loadSavedGame();
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected an ok load outcome');
    return outcome;
}

function makeGameState(overrides?: Partial<GameState>): GameState {
    const pieces = [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })];

    const groups: PieceGroup[] = [
        {
            id: 0,
            pieces: new Map([[0, { x: 0, y: 0 }]]),
            position: { x: 50, y: 50 },
            rotation: 0,
        },
        {
            id: 1,
            pieces: new Map([[1, { x: 0, y: 0 }]]),
            position: { x: 200, y: 100 },
            rotation: 0,
        },
    ];

    return makeBaseGameState({
        pieces,
        groups,
        imageUrl: 'test-image.jpg',
        ...overrides,
    });
}

describe('saveNewPuzzle / loadState', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('round-trips a game state through localStorage', () => {
        const state = makeGameState();
        saveNewPuzzle(state);

        const restored = loadState();
        expect(restored).toBeDefined();
        expect(restored!.imageUrl).toBe('test-image.jpg');
        expect(restored!.completed).toBe(false);
        expect(restored!.pieces).toEqual(state.pieces);
        expect(restored!.groups.length).toBe(2);
        expect(restored!.groups[0].pieces).toBeInstanceOf(Map);
        expect(restored!.groups[0].pieces.get(0)).toEqual({ x: 0, y: 0 });
    });

    it('returns undefined when nothing is saved', () => {
        expect(loadState()).toBeUndefined();
    });

    it('returns undefined for corrupted JSON', () => {
        localStorage.setItem(STORAGE_KEY, '{not valid json!!!');

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = loadState();

        expect(result).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledOnce();
        warnSpy.mockRestore();
    });

    it('returns undefined for wrong version', () => {
        const badData = {
            version: 999,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                {
                    id: 0,
                    pieces: [[0, { x: 0, y: 0 }]],
                    position: { x: 0, y: 0 },
                },
            ],
            imageUrl: 'test.jpg',
            completed: false,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(badData));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = loadState();

        expect(result).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledOnce();
        warnSpy.mockRestore();
    });

    it('returns undefined for structurally invalid data', () => {
        // Empty groups → torn v11 static-only blob (no progress key); the
        // two-key model returns undefined silently rather than throwing.
        const badData = {
            version: STATE_VERSION,
            pieces: [],
            groups: [],
            imageUrl: '',
            completed: false,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(badData));

        const result = loadState();
        expect(result).toBeUndefined();
    });

    it('saves and restores completed state', () => {
        const state = makeGameState({ completed: true });
        saveNewPuzzle(state);

        const restored = loadState();
        expect(restored!.completed).toBe(true);
    });
});

describe('saveNewPuzzle quota handling', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('returns "ok" and stores an uncompressed geometry for a normal save', () => {
        const result = saveNewPuzzle(makeGameState());
        expect(result).toBe('ok');
        expect(localStorage.getItem(STORAGE_KEY)!.startsWith(COMPRESSED_MARKER)).toBe(false);
    });

    it('falls back to a compressed write when the plain write exceeds quota', () => {
        const state = makeGameState();
        const realSetItem = Storage.prototype.setItem;

        // Reject uncompressed writes, accept compressed retries. Discriminate by
        // the marker, not size.
        const spy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (!value.startsWith(COMPRESSED_MARKER)) {
                    throw new DOMException('quota', 'QuotaExceededError');
                }
                realSetItem.call(this, key, value);
            });

        const result = saveNewPuzzle(state);
        spy.mockRestore();

        expect(result).toBe('ok-compressed');
        const stored = localStorage.getItem(STORAGE_KEY)!;
        expect(stored.startsWith(COMPRESSED_MARKER)).toBe(true);

        const restored = loadState();
        expect(restored!.pieces).toEqual(state.pieces);
    });

    it('preserves a prior good geometry save and returns "failed" when both writes throw', () => {
        saveNewPuzzle(makeGameState({ imageUrl: 'good.jpg' }));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const spy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });

        const result = saveGeometry(makeGameState({ imageUrl: 'too-big.jpg' }));
        spy.mockRestore();
        warnSpy.mockRestore();

        expect(result).toBe('failed');
        // The earlier good geometry is untouched (never removeItem first), and
        // its progress key still matches, so load works.
        expect(loadState()!.imageUrl).toBe('good.jpg');
    });

    it('round-trips a compressed save (including selection) through loadSavedGame', () => {
        const state = makeGameState();
        const realSetItem = Storage.prototype.setItem;
        const spy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (!value.startsWith(COMPRESSED_MARKER)) {
                    throw new DOMException('quota', 'QuotaExceededError');
                }
                realSetItem.call(this, key, value);
            });
        saveNewPuzzle(state, [1, 0]);
        spy.mockRestore();

        const loaded = expectLoaded();
        expect(loaded.state.pieces).toEqual(state.pieces);
        expect(loaded.selection).toEqual([1, 0]);
    });

    it('leaves the previous puzzle loadable when the new geometry write fails', () => {
        saveNewPuzzle(makeGameState({ seed: 1, imageUrl: 'good.jpg' }), [0]);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const realSetItem = Storage.prototype.setItem;
        // Geometry writes (STORAGE_KEY) fail; small progress writes still succeed.
        const spy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (key === STORAGE_KEY) {
                    throw new DOMException('quota', 'QuotaExceededError');
                }
                realSetItem.call(this, key, value);
            });

        const result = saveNewPuzzle(makeGameState({ seed: 2, imageUrl: 'too-big.jpg' }), [1]);
        spy.mockRestore();
        warnSpy.mockRestore();

        expect(result).toBe('failed');
        // The previous pair is intact: load returns the previous puzzle, not a
        // seed-mismatch.
        const loaded = expectLoaded();
        expect(loaded.state.imageUrl).toBe('good.jpg');
        expect(loaded.state.seed).toBe(1);
    });

    it('does not leave an orphan progress key when the first puzzle is too large to save', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const realSetItem = Storage.prototype.setItem;
        const spy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (key === STORAGE_KEY) {
                    throw new DOMException('quota', 'QuotaExceededError');
                }
                realSetItem.call(this, key, value);
            });

        const result = saveNewPuzzle(makeGameState({ seed: 1 }), [0]);
        spy.mockRestore();
        warnSpy.mockRestore();

        expect(result).toBe('failed');
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
        expect(loadSavedGame().status).toBe('empty');
    });
});

describe('saveNewPuzzle / loadSavedGame selection', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('round-trips a multi-select selection alongside the state', () => {
        const state = makeGameState();
        saveNewPuzzle(state, [1, 0]);

        expect(loadedSelection()).toEqual([1, 0]);
    });

    it('returns an empty array when no selection was saved', () => {
        const state = makeGameState();
        saveNewPuzzle(state);

        expect(loadedSelection()).toEqual([]);
    });

    it('treats an empty selection as no selection (omits the field)', () => {
        const state = makeGameState();
        saveNewPuzzle(state, []);

        expect(loadedSelection()).toEqual([]);
    });

    it('reports "empty" when nothing is saved at all', () => {
        expect(loadSavedGame().status).toBe('empty');
        expect(loadedSelection()).toEqual([]);
    });

    it('reports "unreadable" for corrupted JSON', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.setItem(STORAGE_KEY, '{ not json');
        expect(loadSavedGame().status).toBe('unreadable');
        expect(loadedSelection()).toEqual([]);
        warnSpy.mockRestore();
    });

    it('returns the state and selection from a recombined pair', () => {
        const state = makeGameState();
        saveNewPuzzle(state, [0, 1]);

        const saved = expectLoaded();
        expect(saved.state.imageUrl).toBe('test-image.jpg');
        expect(saved.state.groups.length).toBe(2);
        expect(saved.selection).toEqual([0, 1]);
    });
});

describe('split storage', () => {
    beforeEach(() => localStorage.clear());

    it('saveNewPuzzle writes both keys and round-trips through loadSavedGame', () => {
        const state = makeGameState({ seed: 5 });
        const result = saveNewPuzzle(state, [1, 0]);
        expect(result).not.toBe('failed');
        expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
        expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();

        const loaded = expectLoaded();
        expect(loaded.state.pieces).toEqual(state.pieces);
        expect(loaded.state.groups.length).toBe(state.groups.length);
        expect(loaded.selection).toEqual([1, 0]);
    });

    it('saveProgress writes only the progress key, leaving the geometry untouched', () => {
        const state = makeGameState({ seed: 5 });
        saveNewPuzzle(state, []);
        const geometryBefore = localStorage.getItem(STORAGE_KEY);

        saveProgress(state, [2]);
        expect(localStorage.getItem(STORAGE_KEY)).toBe(geometryBefore);
        expect(expectLoaded().selection).toEqual([2]);
    });

    it('reports "unreadable" for a torn pair (geometry present, progress missing) and logs why', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveGeometry(makeGameState({ seed: 5 })); // writes only the v11 static key
        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
        expect(loadSavedGame().status).toBe('unreadable');
        expect(warnSpy).toHaveBeenCalled(); // intentional discard leaves a trail
        warnSpy.mockRestore();
    });

    it('reports "unreadable" for a seed-mismatched pair and logs why', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const a = makeGameState({ seed: 1 });
        const b = makeGameState({ seed: 2 });
        saveGeometry(a);
        // saveProgress refuses a seed-mismatched pair, so install the stale blob
        // directly — the shape the load-time guard must still detect.
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(serializeProgress(b, [])));
        expect(loadSavedGame().status).toBe('unreadable');
        expect(warnSpy).toHaveBeenCalled(); // intentional discard leaves a trail
        warnSpy.mockRestore();
    });

    it('still loads a legacy single-key v10 save (groups inline, no progress key)', () => {
        // Hand-write a legacy full blob the way the old build stored it.
        const state = makeGameState({ seed: 9 });
        const legacy = {
            version: 10,
            pieces: state.pieces,
            groups: state.groups.map((g) => ({
                id: g.id,
                pieces: Array.from(g.pieces.entries()),
                position: g.position,
                rotation: g.rotation,
            })),
            imageUrl: state.imageUrl,
            imageSize: state.imageSize,
            gridSize: state.gridSize,
            completed: false,
            seed: 9,
            selection: [1],
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();

        const loaded = expectLoaded();
        expect(loaded.state.pieces).toEqual(state.pieces);
        expect(loaded.state.groups.length).toBe(state.groups.length);
        expect(loaded.selection).toEqual([1]);
    });

    it('prefers the progress key over a legacy inline-groups blob (migration)', () => {
        const state = makeGameState({ seed: 9 });
        const legacy = {
            version: 10,
            pieces: state.pieces,
            groups: state.groups.map((g) => ({
                id: g.id, pieces: Array.from(g.pieces.entries()), position: g.position, rotation: g.rotation,
            })),
            imageUrl: state.imageUrl, imageSize: state.imageSize, gridSize: state.gridSize,
            completed: false, seed: 9,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
        saveProgress(state, [0]);
        const loaded = expectLoaded();
        expect(loaded.selection).toEqual([0]); // from progress, not the legacy blob
        expect(loaded.state.pieces).toEqual(state.pieces); // geometry from the legacy static blob
        expect(loaded.state.groups.length).toBe(state.groups.length); // groups recombined from progress
    });

    it('reports "empty" for an orphaned progress key when geometry is missing', () => {
        saveProgress(makeGameState({ seed: 5 }), [1]);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        // No geometry anchor: the stray progress key is a harmless torn-write
        // artifact, not a recognizable save, so this is "empty" not "unreadable".
        expect(loadSavedGame().status).toBe('empty');
    });
});

describe('saveProgress cross-tab guard (#404)', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks(); // reset the vi.mock'd decompressFromStorage call count
    });

    it('refuses to overwrite progress when the stored geometry is a different puzzle', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 1 }), [0]);
        const progressBefore = localStorage.getItem(PROGRESS_KEY);

        const result = saveProgress(makeGameState({ seed: 2 }), [1]); // stale tab
        warnSpy.mockRestore();

        expect(result).toBe('skipped');
        expect(localStorage.getItem(PROGRESS_KEY)).toBe(progressBefore);
    });

    it('logs why it skipped a mismatched progress write', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 1 }), [0]);
        saveProgress(makeGameState({ seed: 2 }), [1]);

        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('keeps the most-recent geometry owner so reload is not a seed-mismatch', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Tab A started puzzle 1; a stale background Tab B autosaves puzzle 2.
        saveNewPuzzle(makeGameState({ seed: 1 }), [0]);
        saveProgress(makeGameState({ seed: 2 }), [1]);
        warnSpy.mockRestore();

        const loaded = expectLoaded();
        expect(loaded.state.seed).toBe(1);
    });

    it('writes normally when the stored geometry is the same puzzle', () => {
        saveNewPuzzle(makeGameState({ seed: 5 }), []);
        const result = saveProgress(makeGameState({ seed: 5 }), [1]);

        expect(result).not.toBe('skipped');
        expect(expectLoaded().selection).toEqual([1]);
    });

    it('writes when no geometry is present (nothing to mismatch against)', () => {
        const result = saveProgress(makeGameState({ seed: 7 }), [1]);
        expect(result).not.toBe('skipped');
        expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
    });

    it('writes when the stored geometry is unreadable (does not block on it)', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.setItem(STORAGE_KEY, '{not valid json!!!');
        const result = saveProgress(makeGameState({ seed: 7 }), [1]);
        warnSpy.mockRestore();

        expect(result).not.toBe('skipped');
        expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
    });

    it('writes when either side has no seed (only a confirmed mismatch skips)', () => {
        saveNewPuzzle(makeGameState({ seed: 5 }), []);
        const result = saveProgress(makeGameState(), [1]); // progress has no seed
        expect(result).not.toBe('skipped');
    });

    it('skips after another tab replaces the geometry', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 490028 }), []);
        expect(saveProgress(makeGameState({ seed: 490028 }), [1])).not.toBe('skipped');

        // Another tab takes over: write the geometry key directly + dispatch the
        // storage event. saveGeometry here would be a same-tab write that updates
        // the token, passing the test for the wrong reason.
        const raw = JSON.stringify(serializeStatic(makeGameState({ seed: 490029 })));
        localStorage.setItem(STORAGE_KEY, raw);
        window.dispatchEvent(
            new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: raw,
                storageArea: localStorage,
            }),
        );

        expect(saveProgress(makeGameState({ seed: 490028 }), [2])).toBe('skipped');
        warnSpy.mockRestore();
    });
});

// Seeds are unique per test on purpose: storage.ts's `cachedGeometryRaw`
// memoizes on the raw geometry and outlives localStorage.clear(), so identical
// geometry across tests would make decode counts order-dependent.
describe('geometry seed token (#490)', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks(); // reset the vi.mock'd decompressFromStorage call count
    });

    it('records the geometry seed on save so the guard need not decode', () => {
        saveNewPuzzle(makeGameState({ seed: 490001 }), []);
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490001');
    });

    it('does not decode the geometry at all on repeated same-puzzle saves', () => {
        saveGeometry(makeGameState({ seed: 490002 }));
        const spy = vi.spyOn(compression, 'decompressFromStorage');

        saveProgress(makeGameState({ seed: 490002 }), [1]);
        saveProgress(makeGameState({ seed: 490002 }), [2]);
        saveProgress(makeGameState({ seed: 490002 }), [3]);

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('skips a mismatched save using the token, without decoding', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 490003 }), []);
        const progressBefore = localStorage.getItem(PROGRESS_KEY);
        const decodeSpy = vi.spyOn(compression, 'decompressFromStorage');

        const result = saveProgress(makeGameState({ seed: 490004 }), [1]);

        expect(result).toBe('skipped');
        expect(localStorage.getItem(PROGRESS_KEY)).toBe(progressBefore);
        expect(decodeSpy).not.toHaveBeenCalled();
        decodeSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('falls back to decoding once, then backfills, for a save with no token', () => {
        // A save written before this change: geometry present, token absent.
        saveNewPuzzle(makeGameState({ seed: 490005 }), []);
        localStorage.removeItem(GEOMETRY_SEED_KEY);
        const spy = vi.spyOn(compression, 'decompressFromStorage');

        saveProgress(makeGameState({ seed: 490005 }), [1]); // miss → decode + backfill
        expect(spy).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490005');

        saveProgress(makeGameState({ seed: 490005 }), [2]); // token path → no decode
        saveProgress(makeGameState({ seed: 490005 }), [3]);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('still detects a takeover when the token is absent', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 490006 }), []);
        localStorage.removeItem(GEOMETRY_SEED_KEY);

        expect(saveProgress(makeGameState({ seed: 490007 }), [1])).toBe('skipped');
        warnSpy.mockRestore();
    });

    it('ignores a non-numeric token and re-derives from the geometry', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 490008 }), []);
        localStorage.setItem(GEOMETRY_SEED_KEY, 'not-a-number');

        expect(saveProgress(makeGameState({ seed: 490009 }), [1])).toBe('skipped');
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490008'); // re-derived
        warnSpy.mockRestore();
    });

    // Both halves of the guard are load-bearing. `Number('')` is 0 (isFinite
    // true), so without the round-trip compare an empty token reads as seed 0;
    // `'NaN'`/`'Infinity'` round-trip through String(), so without isFinite they
    // pass as unequal-to-every-real seeds. Either way skips every save.
    it.each(['', '   ', '0x10', ' 5 ', '1e3', 'NaN', 'Infinity'])(
        'ignores the un-writable token %o rather than reading a seed out of it',
        (token) => {
            saveNewPuzzle(makeGameState({ seed: 490017 }), []);
            localStorage.setItem(GEOMETRY_SEED_KEY, token);

            expect(saveProgress(makeGameState({ seed: 490017 }), [1])).not.toBe('skipped');
            expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490017'); // re-derived
        },
    );

    it('does not record a token when the geometry write failed', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 490010 }), []); // this puzzle owns the slot

        // Both plain and compressed geometry writes throw → 'failed'. Other keys
        // pass through, so a token write would land — swallowing it would pass
        // the test whether or not saveGeometry guards on the write outcome.
        const realSetItem = Storage.prototype.setItem;
        const setItem = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (key === STORAGE_KEY) throw new Error('quota');
                realSetItem.call(this, key, value);
            });
        const result = saveGeometry(makeGameState({ seed: 490011 }));
        setItem.mockRestore();
        warnSpy.mockRestore();

        expect(result).toBe('failed');
        // The slot still belongs to 490010, and the token must still say so.
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490010');
    });

    it('records the owner even when the geometry write had to compress', () => {
        const realSetItem = Storage.prototype.setItem;
        // Only the geometry blob is forced down the compressed retry; the
        // ~10-byte token write is never the thing that overflows.
        const setItem = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(function (this: Storage, key: string, value: string) {
                if (key === STORAGE_KEY && !value.startsWith(COMPRESSED_MARKER)) {
                    throw new DOMException('quota', 'QuotaExceededError');
                }
                realSetItem.call(this, key, value);
            });
        const result = saveGeometry(makeGameState({ seed: 490015 }));
        setItem.mockRestore();

        expect(result).toBe('ok-compressed');
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490015');
    });

    it('falls back to decoding when the token write itself throws', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // A token from the puzzle that owned the slot before this one — the
        // failing write must destroy it, else this tab skips every save for the
        // puzzle it is about to own.
        saveNewPuzzle(makeGameState({ seed: 490016 }), []);
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490016');

        const realSetItem = localStorage.setItem.bind(localStorage);
        const setItem = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation((key: string, value: string) => {
                if (key === GEOMETRY_SEED_KEY) throw new Error('quota');
                realSetItem(key, value);
            });
        saveNewPuzzle(makeGameState({ seed: 490012 }), []);
        setItem.mockRestore();

        // The stale 490016 is gone rather than left standing.
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
        // And the degrade is not silent — the same class of failure
        // `writeWithOverflow` warns about.
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(GEOMETRY_SEED_KEY),
            expect.anything(),
        );
        // And the guard still works, the slow way.
        expect(saveProgress(makeGameState({ seed: 490013 }), [1])).toBe('skipped');
        // Nor is the degrade permanent: the decode backfilled the token with the
        // same write that just failed, so it recovers once storage does.
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490012');
        warnSpy.mockRestore();
    });

    /**
     * A `pageshow` from the back/forward cache. `PageTransitionEvent` isn't
     * constructible in jsdom and `persisted` is read-only, so it's defined onto
     * a plain event.
     */
    function bfcacheRestore(): Event {
        const event = new Event('pageshow');
        Object.defineProperty(event, 'persisted', { value: true });
        return event;
    }

    /** What another tab writing the geometry looks like from inside this one. */
    function otherTabWritesGeometry(seed: number): void {
        const raw = JSON.stringify(serializeStatic(makeGameState({ seed })));
        const oldValue = localStorage.getItem(STORAGE_KEY);
        localStorage.setItem(STORAGE_KEY, raw); // no token update: not our write
        window.dispatchEvent(
            new StorageEvent('storage', {
                key: STORAGE_KEY,
                oldValue,
                newValue: raw,
                storageArea: localStorage,
            }),
        );
    }

    it('drops the token when another tab writes the geometry', () => {
        saveNewPuzzle(makeGameState({ seed: 490020 }), []);
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490020');

        otherTabWritesGeometry(490021);

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
    });

    it('detects a takeover by a tab that does not maintain the token (#404)', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 490022 }), []);
        expect(saveProgress(makeGameState({ seed: 490022 }), [1])).not.toBe('skipped');
        const progressBefore = localStorage.getItem(PROGRESS_KEY);

        otherTabWritesGeometry(490023);

        expect(saveProgress(makeGameState({ seed: 490022 }), [2])).toBe('skipped');
        expect(localStorage.getItem(PROGRESS_KEY)).toBe(progressBefore);
        warnSpy.mockRestore();
    });

    it('re-derives exactly once after a cross-tab write, then goes fast again', () => {
        saveNewPuzzle(makeGameState({ seed: 490024 }), []);
        otherTabWritesGeometry(490025);
        const spy = vi.spyOn(compression, 'decompressFromStorage');

        saveProgress(makeGameState({ seed: 490025 }), [1]); // decode + backfill
        saveProgress(makeGameState({ seed: 490025 }), [2]); // token path
        saveProgress(makeGameState({ seed: 490025 }), [3]);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490025');
        spy.mockRestore();
    });

    it('drops the token when another tab clears storage (null-key event)', () => {
        saveNewPuzzle(makeGameState({ seed: 490026 }), []);

        window.dispatchEvent(
            new StorageEvent('storage', { key: null, storageArea: localStorage }),
        );

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
    });

    it('ignores a storage event from sessionStorage', () => {
        saveNewPuzzle(makeGameState({ seed: 490031 }), []);

        // A null-key sessionStorage clear is the reachable shape of this: it
        // says nothing about our geometry key and must not drop the token.
        window.dispatchEvent(
            new StorageEvent('storage', { key: null, storageArea: sessionStorage }),
        );

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490031');
    });

    it('still drops the token when the storage area is unrecognized', () => {
        saveNewPuzzle(makeGameState({ seed: 490034 }), []);

        // Not a shape any engine produces (storageArea identity is spec-mandated),
        // but it pins the guard's polarity: `!== localStorage` would fail open and
        // switch invalidation off. Excluding only sessionStorage fails safe.
        window.dispatchEvent(
            new StorageEvent('storage', { key: STORAGE_KEY, storageArea: null }),
        );

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
    });

    it('drops the token on a bfcache restore, which delivers no storage events', () => {
        saveNewPuzzle(makeGameState({ seed: 490032 }), []);
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490032');

        // While bfcached this document wasn't "fully active", so a geometry
        // write by another tab reached no listener and isn't replayed — the
        // token is only a guess now.
        window.dispatchEvent(bfcacheRestore());

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
    });

    it('keeps the token across an ordinary (non-bfcache) pageshow', () => {
        saveNewPuzzle(makeGameState({ seed: 490033 }), []);

        window.dispatchEvent(new Event('pageshow'));

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490033');
    });

    it('registers each listener once however many times it is installed', () => {
        // Second install (beforeAll already ran). Must not stack duplicate
        // handlers — they're module-scope refs, not arrows, so addEventListener
        // dedupes on (type, callback, capture); a fresh arrow per call would drop
        // the token twice per event.
        installGeometryTokenInvalidation();
        saveNewPuzzle(makeGameState({ seed: 490036 }), []);

        const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
        otherTabWritesGeometry(490035);
        window.dispatchEvent(bfcacheRestore());
        const drops = removeItem.mock.calls.filter(([key]) => key === GEOMETRY_SEED_KEY);
        removeItem.mockRestore();

        // Two events, two drops — not four.
        expect(drops).toHaveLength(2);
    });

    it('never reads the geometry blob on a steady-state flush (#490)', () => {
        saveNewPuzzle(makeGameState({ seed: 490030 }), []);

        const getItem = vi.spyOn(Storage.prototype, 'getItem');
        saveProgress(makeGameState({ seed: 490030 }), [1]);
        saveProgress(makeGameState({ seed: 490030 }), [2]);

        // Two flushes, two ~10-byte reads, and the multi-MB blob untouched.
        expect(getItem.mock.calls.map(([key]) => key)).toEqual([
            GEOMETRY_SEED_KEY,
            GEOMETRY_SEED_KEY,
        ]);
        getItem.mockRestore();
    });

    it('ignores storage events for unrelated keys', () => {
        saveNewPuzzle(makeGameState({ seed: 490027 }), []);

        window.dispatchEvent(
            new StorageEvent('storage', {
                key: 'some-other-app-key',
                newValue: 'x',
                storageArea: localStorage,
            }),
        );

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490027');
    });
});

describe('unreadable save carries the raw blobs for download', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        localStorage.clear();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('attaches the raw geometry verbatim on corrupt JSON (reason: parse-error)', () => {
        localStorage.setItem(STORAGE_KEY, '{not valid json!!!');

        const outcome = loadSavedGame();
        expect(outcome.status).toBe('unreadable');
        if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
        expect(outcome.reason).toBe('parse-error');
        expect(outcome.raw.geometry).toBe('{not valid json!!!');
        expect(outcome.raw.progress).toBeNull();
    });

    it('reports parse-error for a v14 geometry blob with an edge path missing', () => {
        const state = makeGameState({ seed: 14 });
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        delete blob.pieces[0].edges[0].path;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(serializeProgress(state, [])));

        const outcome = loadSavedGame();
        expect(outcome.status).toBe('unreadable');
        if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
        expect(outcome.reason).toBe('parse-error');
    });

    it('still captures the progress blob when the geometry itself is corrupt', () => {
        // A corrupt geometry blob throws on parse before the progress key would
        // otherwise be decoded; the raw snapshot must still include progress so
        // the download is complete.
        localStorage.setItem(STORAGE_KEY, '{not valid json!!!');
        saveProgress(makeGameState({ seed: 7 }), [1]);
        const progressRaw = localStorage.getItem(PROGRESS_KEY);

        const outcome = loadSavedGame();
        if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
        expect(outcome.reason).toBe('parse-error');
        expect(outcome.raw.geometry).toBe('{not valid json!!!');
        expect(outcome.raw.progress).toBe(progressRaw);
    });

    it('attaches both raw blobs for a seed-mismatched pair (reason: seed-mismatch)', () => {
        saveGeometry(makeGameState({ seed: 1 }));
        // Install the mismatched progress blob directly (saveProgress now guards
        // against writing one); the load-time guard must still flag the pair.
        localStorage.setItem(
            PROGRESS_KEY,
            JSON.stringify(serializeProgress(makeGameState({ seed: 2 }), [])),
        );
        const staticRaw = localStorage.getItem(STORAGE_KEY);
        const progressRaw = localStorage.getItem(PROGRESS_KEY);

        const outcome = loadSavedGame();
        expect(outcome.status).toBe('unreadable');
        if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
        expect(outcome.reason).toBe('seed-mismatch');
        expect(outcome.raw.geometry).toBe(staticRaw);
        expect(outcome.raw.progress).toBe(progressRaw);
    });

    it('reports reason "torn-write" for geometry present with no progress', () => {
        saveGeometry(makeGameState({ seed: 5 }));
        const outcome = loadSavedGame();
        if (outcome.status !== 'unreadable') throw new Error('expected unreadable');
        expect(outcome.reason).toBe('torn-write');
    });

    it('leaves the save keys intact, so the recovery blobs survive to be downloaded', () => {
        // Not "does not modify localStorage": since #490 this path re-anchors the
        // seed token, so loadSavedGame is a writer. What the recovery dialog needs
        // is narrower — the two save keys are untouched and no extra key invented.
        localStorage.setItem(STORAGE_KEY, '{not valid json!!!');
        localStorage.setItem(PROGRESS_KEY, '{also not valid!!!');
        const geometryBefore = localStorage.getItem(STORAGE_KEY);
        const progressBefore = localStorage.getItem(PROGRESS_KEY);

        loadSavedGame();

        expect(localStorage.getItem(STORAGE_KEY)).toBe(geometryBefore);
        expect(localStorage.getItem(PROGRESS_KEY)).toBe(progressBefore);
        const touchedKeys = Array.from({ length: localStorage.length }, (_, i) =>
            localStorage.key(i),
        ).filter((key): key is string => key !== null && key !== GEOMETRY_SEED_KEY);
        expect(touchedKeys.sort()).toEqual([STORAGE_KEY, PROGRESS_KEY].sort());
    });

    it('reports "empty" (no raw) when nothing is saved', () => {
        expect(loadSavedGame()).toEqual({ status: 'empty' });
    });
});

describe('createDebouncedSave', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not save immediately', () => {
        const { save } = createDebouncedSave();
        const state = makeGameState();

        save(state);

        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
    });

    it('saves after the debounce interval', () => {
        const { save } = createDebouncedSave();
        const state = makeGameState();

        // Geometry must be present for loadSavedGame to recombine.
        saveGeometry(state);
        save(state);
        vi.advanceTimersByTime(500);

        expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();
        const restored = loadState();
        expect(restored!.imageUrl).toBe('test-image.jpg');
    });

    it('carries the selection captured at save time', () => {
        const { save } = createDebouncedSave();
        const state = makeGameState();

        saveGeometry(state);
        save(state, [1, 0]);
        vi.advanceTimersByTime(500);

        expect(loadedSelection()).toEqual([1, 0]);
    });

    it('persists an empty selection when called without one', () => {
        const { save } = createDebouncedSave();
        const state = makeGameState();

        // Pre-seed a selection, then a debounced save with none should overwrite
        // it with an empty selection.
        saveNewPuzzle(state, [0, 1]);
        save(state);
        vi.advanceTimersByTime(500);

        expect(loadedSelection()).toEqual([]);
    });

    it('resets the timer on repeated calls', () => {
        const { save } = createDebouncedSave();
        const state1 = makeGameState({ imageUrl: 'first.jpg' });
        const state2 = makeGameState({ imageUrl: 'second.jpg' });

        // Geometry for state2 (the one we expect to load).
        saveGeometry(state2);

        save(state1);
        vi.advanceTimersByTime(300);

        save(state2);
        vi.advanceTimersByTime(300);

        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();

        vi.advanceTimersByTime(200);
        const restored = loadState();
        expect(restored!.imageUrl).toBe('second.jpg');
    });

    it('flush saves immediately and clears pending', () => {
        const { save, flush } = createDebouncedSave();
        const state = makeGameState();

        save(state);
        flush();

        expect(localStorage.getItem(PROGRESS_KEY)).not.toBeNull();

        // Advancing timers should not cause a double-save
        const saveSpy = vi.spyOn(Storage.prototype, 'setItem');
        vi.advanceTimersByTime(1000);
        expect(saveSpy).not.toHaveBeenCalled();
        saveSpy.mockRestore();
    });

    it('flush is safe when nothing is pending', () => {
        const { flush } = createDebouncedSave();

        expect(() => flush()).not.toThrow();
    });

    it('cancel discards the pending save', () => {
        const { save, cancel } = createDebouncedSave();
        const state = makeGameState();

        save(state);
        cancel();
        vi.advanceTimersByTime(1000);

        expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
    });

    it('invokes onSaveFailed when a flushed save fails', () => {
        const onSaveFailed = vi.fn();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const setItemSpy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });

        const { save } = createDebouncedSave({ onSaveFailed });
        save(makeGameState());
        vi.advanceTimersByTime(500);

        expect(onSaveFailed).toHaveBeenCalledOnce();
        setItemSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('passes the flushed state to onSaveFailed, not whatever is current at flush time', () => {
        const onSaveFailed = vi.fn();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const setItemSpy = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });

        const queued = makeGameState({ seed: 7 });
        const { save } = createDebouncedSave({ onSaveFailed });
        save(queued);
        vi.advanceTimersByTime(500);

        expect(onSaveFailed).toHaveBeenCalledWith(queued);
        setItemSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('does not invoke onSaveFailed on a successful save', () => {
        const onSaveFailed = vi.fn();
        const { save } = createDebouncedSave({ onSaveFailed });

        save(makeGameState());
        vi.advanceTimersByTime(500);

        expect(onSaveFailed).not.toHaveBeenCalled();
    });

    it('invokes onSaveSkipped (not onSaveFailed) when a flushed save is skipped', () => {
        const onSaveFailed = vi.fn();
        const onSaveSkipped = vi.fn();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Stored geometry belongs to a different puzzle than the one autosaved —
        // a cross-tab takeover. saveProgress returns 'skipped'.
        saveGeometry(makeGameState({ seed: 1 }));
        const { save } = createDebouncedSave({ onSaveFailed, onSaveSkipped });

        const queued = makeGameState({ seed: 2 });
        save(queued);
        vi.advanceTimersByTime(500);
        warnSpy.mockRestore();

        expect(onSaveSkipped).toHaveBeenCalledOnce();
        // Attributed to the flushed state, for the same reason as onSaveFailed.
        expect(onSaveSkipped).toHaveBeenCalledWith(queued);
        expect(onSaveFailed).not.toHaveBeenCalled();
    });

    it('does not invoke onSaveSkipped on a normal save', () => {
        const onSaveSkipped = vi.fn();
        saveGeometry(makeGameState({ seed: 5 }));
        const { save } = createDebouncedSave({ onSaveSkipped });

        save(makeGameState({ seed: 5 }));
        vi.advanceTimersByTime(500);

        expect(onSaveSkipped).not.toHaveBeenCalled();
    });
});

describe('viewport persistence through storage', () => {
    beforeEach(() => localStorage.clear());

    const VP = { scale: 2, offset: { x: 10, y: 20 } };

    it('saveNewPuzzle round-trips a viewport through loadSavedGame', () => {
        saveNewPuzzle(makeGameState({ seed: 5 }), [], VP);
        expect(loadedViewport()).toEqual(VP);
    });

    it('returns undefined when no viewport was saved', () => {
        saveNewPuzzle(makeGameState({ seed: 5 }), []);
        expect(loadedViewport()).toBeUndefined();
    });

    it('saveProgress persists the viewport on top of existing geometry', () => {
        const state = makeGameState({ seed: 5 });
        saveNewPuzzle(state, []);
        saveProgress(state, [], VP);
        expect(loadedViewport()).toEqual(VP);
    });

    it('createDebouncedSave forwards the viewport captured at save time', () => {
        vi.useFakeTimers();
        try {
            const state = makeGameState({ seed: 5 });
            saveGeometry(state);
            const { save } = createDebouncedSave();
            save(state, [], VP);
            vi.advanceTimersByTime(500);
            expect(loadedViewport()).toEqual(VP);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still loads (default view) but warns when a present viewport is malformed', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const state = makeGameState({ seed: 5 });
        saveGeometry(state);
        // Viewport present but corrupt (non-finite scale). The save still loads
        // (default view), but the silent zoom loss should leave a trail, unlike
        // an absent-viewport pre-feature save.
        const progress = serializeProgress(state, [], {
            scale: Number.NaN,
            offset: { x: 0, y: 0 },
        });
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));

        const outcome = loadSavedGame();
        expect(outcome.status).toBe('ok');
        expect(loadedViewport()).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('does not warn when no viewport is present (pre-feature save)', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 5 }), []);
        expect(loadedViewport()).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});

// The `storage` event only reaches a fully active document, so a geometry write
// by a token-blind build (pre-#490 `/puzzle/` sharing `/puzzle/dev/`, a rollback,
// a stale PWA client) while this tab was closed leaves the token stale with
// nothing to correct it. Load is the re-anchor point.
describe('geometry seed token: re-anchored on load (#490)', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks(); // reset the vi.mock'd decompressFromStorage call count
    });

    /** Write a full save the way a build that ignores the token would. */
    function foreignBuildWritesSave(seed: number): void {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeStatic(makeGameState({ seed }))));
        localStorage.setItem(
            PROGRESS_KEY,
            JSON.stringify(serializeProgress(makeGameState({ seed }), [])),
        );
    }

    it('re-points a token left naming the previous puzzle at the geometry in the slot', () => {
        saveNewPuzzle(makeGameState({ seed: 490040 }), []); // we owned the slot…
        foreignBuildWritesSave(490041); // …until a token-blind build took it
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490040'); // stale

        expect(loadSavedGame().status).toBe('ok');

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490041');
        // The restored puzzle now autosaves. Without the re-anchor the stale
        // token skips every save all session, and a reload doesn't repair it.
        expect(saveProgress(makeGameState({ seed: 490041 }), [1])).not.toBe('skipped');
    });

    it('drops a token that claims the puzzle we are about to overwrite', () => {
        // The other direction: the token names *our* puzzle while the slot
        // holds someone else's. Trusting it writes the torn pair the guard
        // exists to prevent (#404).
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(serializeStatic(makeGameState({ seed: 490042 }))),
        );
        localStorage.setItem(GEOMETRY_SEED_KEY, '490043');

        loadSavedGame();

        expect(saveProgress(makeGameState({ seed: 490043 }), [1])).toBe('skipped');
        warnSpy.mockRestore();
    });

    it('drops the token when the geometry key is gone', () => {
        saveNewPuzzle(makeGameState({ seed: 490044 }), []);
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(PROGRESS_KEY);

        expect(loadSavedGame().status).toBe('empty');

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
    });

    it('drops the token when the geometry cannot be decoded', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        saveNewPuzzle(makeGameState({ seed: 490045 }), []);
        localStorage.setItem(STORAGE_KEY, '{not valid json!!!');

        expect(loadSavedGame().status).toBe('unreadable');

        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBeNull();
        warnSpy.mockRestore();
    });

    it('anchors to the geometry, not the pair, on a seed-mismatched save', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(serializeStatic(makeGameState({ seed: 490046 }))),
        );
        localStorage.setItem(
            PROGRESS_KEY,
            JSON.stringify(serializeProgress(makeGameState({ seed: 490047 }), [])),
        );

        expect(loadSavedGame().status).toBe('unreadable');

        // The token describes the geometry blob, which is intact and is 490046's.
        expect(localStorage.getItem(GEOMETRY_SEED_KEY)).toBe('490046');
        warnSpy.mockRestore();
    });

    it('costs no extra decode — the load already decoded the geometry', () => {
        saveNewPuzzle(makeGameState({ seed: 490048 }), []);
        const spy = vi.spyOn(compression, 'decompressFromStorage');

        loadSavedGame();

        // Geometry + progress, exactly as before the re-anchor was added.
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
    });
});

describe('v13 saves', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('resumes a v13 save without rewriting its geometry', () => {
        const geometry = JSON.stringify({ ...v13StaticBlob(), seed: 13 });
        localStorage.setItem(STORAGE_KEY, geometry);
        localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...v13Progress(), seed: 13 }));
        const setItem = vi.spyOn(Storage.prototype, 'setItem');

        expect(loadSavedGame().status).toBe('ok');

        const writtenKeys = setItem.mock.calls.map(([key]) => key);
        setItem.mockRestore();
        expect(writtenKeys).toContain(GEOMETRY_SEED_KEY);
        expect(writtenKeys).not.toContain(STORAGE_KEY);
        expect(localStorage.getItem(STORAGE_KEY)).toBe(geometry);
    });
});
