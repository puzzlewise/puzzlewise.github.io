/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NewGameData } from './umami.js';
import {
    GAME_CONTEXT_KEY,
    clearGameContext,
    loadGameContext,
    loadGameStartedAt,
    saveGameContext,
} from './game-context.js';

const startedAt = 1_790_000_000_000;

const freshData: NewGameData = {
    source: 'fresh',
    cutStyle: 'classic',
    rotationMode: 'none',
    orientation: 'portrait',
    cols: 12,
    rows: 16,
    pieceCount: 192,
    imageSource: 'unsplash',
    imageCategory: 'nature',
    vibrant: true,
    imagePicked: false,
    traceSetVersion: 2,
    generationMode: 'sync-fallback',
    generationMs: 812,
    generationFallbackKind: 'worker-error',
    generationFallbackReason: 'worker failed',
};

const sharedData: NewGameData = {
    source: 'shared',
    cutStyle: 'wavy',
    rotationMode: 'quarter-turn',
    orientation: 'landscape',
    cols: 8,
    rows: 6,
    pieceCount: 48,
    imageSource: 'unsplash',
    includesProgress: true,
    recipientHadSavedState: false,
    sharedColor: 'adopted',
    generationMode: 'worker',
    generationMs: 120,
};

function writeRaw(value: unknown): void {
    localStorage.setItem(GAME_CONTEXT_KEY, JSON.stringify(value));
}

describe('game context store', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('round-trips a fresh game payload for the same seed', () => {
        saveGameContext(42, freshData, startedAt);

        expect(loadGameContext(42)).toEqual(freshData);
    });

    it('round-trips a shared game payload for the same seed', () => {
        saveGameContext(7, sharedData, startedAt);

        expect(loadGameContext(7)).toEqual(sharedData);
    });

    it('round-trips the boot-fallback flag', () => {
        const fallback: NewGameData = { ...freshData, bootFallback: true };
        saveGameContext(42, fallback, startedAt);

        expect(loadGameContext(42)).toEqual(fallback);
    });

    it('reads back the start time saved for the same seed', () => {
        saveGameContext(42, freshData, startedAt);

        expect(loadGameStartedAt(42)).toBe(startedAt);
    });

    it('has no start time for another puzzle', () => {
        saveGameContext(42, freshData, startedAt);

        expect(loadGameStartedAt(43)).toBeUndefined();
    });

    it('has no start time for a seedless puzzle', () => {
        saveGameContext(42, freshData, startedAt);

        expect(loadGameStartedAt(undefined)).toBeUndefined();
    });

    it('keeps the context of a record saved before start times were', () => {
        writeRaw({ seed: 42, data: freshData });

        expect(loadGameStartedAt(42)).toBeUndefined();
        expect(loadGameContext(42)).toEqual(freshData);
    });

    it.each(['1790000000000', null])('ignores a start time stored as %j', (stored) => {
        writeRaw({ seed: 42, startedAt: stored, data: freshData });

        expect(loadGameStartedAt(42)).toBeUndefined();
    });

    it('returns null when the stored context belongs to another puzzle', () => {
        saveGameContext(42, freshData, startedAt);

        expect(loadGameContext(43)).toBeNull();
    });

    it('returns null for a seedless puzzle', () => {
        saveGameContext(42, freshData, startedAt);

        expect(loadGameContext(undefined)).toBeNull();
    });

    it('does not write a context for a seedless puzzle', () => {
        saveGameContext(undefined, freshData, startedAt);

        expect(localStorage.getItem(GAME_CONTEXT_KEY)).toBeNull();
    });

    it('clears a stored context', () => {
        saveGameContext(42, freshData, startedAt);

        clearGameContext();

        expect(loadGameContext(42)).toBeNull();
    });

    it('survives a storage removal that throws', () => {
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });

        expect(() => clearGameContext()).not.toThrow();
    });

    it('returns null when nothing is stored', () => {
        expect(loadGameContext(42)).toBeNull();
    });

    it('returns null for unparseable JSON', () => {
        localStorage.setItem(GAME_CONTEXT_KEY, '{not json');

        expect(loadGameContext(42)).toBeNull();
    });

    it('returns null when the record is not an object', () => {
        writeRaw('hello');

        expect(loadGameContext(42)).toBeNull();
    });

    it('keeps the other fields when a required one is missing', () => {
        // A record written before a required field was added to NewGameData.
        const { generationMs: _dropped, ...rest } = freshData;
        writeRaw({ seed: 42, data: rest });

        expect(loadGameContext(42)).toEqual(rest);
    });

    it('drops a field with the wrong type and keeps the rest', () => {
        const { vibrant: _dropped, ...rest } = freshData;
        writeRaw({ seed: 42, data: { ...freshData, vibrant: 'yes' } });

        expect(loadGameContext(42)).toEqual(rest);
    });

    it('returns null when the stored data is not an object', () => {
        writeRaw({ seed: 42, data: null });

        expect(loadGameContext(42)).toBeNull();
    });

    it('drops keys that are not NewGameData fields', () => {
        writeRaw({ seed: 42, data: { ...freshData, injected: 'x' } });

        expect(loadGameContext(42)).toEqual(freshData);
    });

    it('survives a storage write that throws', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => saveGameContext(42, freshData, startedAt)).not.toThrow();
    });

    it('drops the previous record when the write fails', () => {
        // A share link replays its originator's seed, so a stale record for
        // the same seed would otherwise be read back as this game's context.
        saveGameContext(42, freshData, startedAt);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        saveGameContext(42, sharedData, startedAt);

        expect(loadGameContext(42)).toBeNull();
    });

    it('survives a storage read that throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });

        expect(loadGameContext(42)).toBeNull();
    });
});
