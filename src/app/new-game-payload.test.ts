/**
 * @vitest-environment jsdom
 *
 * classifyImageSource resolves relative URLs against window.location.href,
 * so the Unsplash-host cases below need a real DOM.
 */

import { describe, it, expect } from 'vitest';
import { makeGameState } from '../test-helpers/fixtures.js';
import { buildFreshGameData, buildSharedGameData } from './new-game-payload.js';

function freshOpts(overrides = {}) {
    return {
        state: makeGameState({ cutStyle: 'classic' }),
        cutStyle: 'classic',
        rotationMode: 'none' as const,
        orientation: 'landscape' as const,
        oriented: { cols: 8, rows: 6 },
        imageSource: 'random',
        imageCategory: 'any',
        vibrant: false,
        chunkDegraded: false,
        bootFallback: false,
        generation: { mode: 'worker' as const, durationMs: 120 },
        ...overrides,
    };
}

function sharedOpts(overrides = {}) {
    return {
        state: makeGameState({ gridSize: { cols: 4, rows: 7 } }),
        includesProgress: false,
        recipientHadSavedState: false,
        sharedColor: 'none' as const,
        generation: { mode: 'worker' as const, durationMs: 120 },
        ...overrides,
    };
}

describe('buildFreshGameData', () => {
    it('marks the source fresh and reports the oriented grid', () => {
        const data = buildFreshGameData(freshOpts({ oriented: { cols: 6, rows: 8 } }));
        expect(data.source).toBe('fresh');
        expect(data.cols).toBe(6);
        expect(data.rows).toBe(8);
    });

    it('flags a degraded traced-tab chunk', () => {
        expect(buildFreshGameData(freshOpts({ chunkDegraded: true })).tracedChunkDegraded).toBe(true);
    });

    it('omits tracedChunkDegraded rather than setting it false', () => {
        // Absence cannot be filtered in Umami; the query subtracts on presence.
        expect('tracedChunkDegraded' in buildFreshGameData(freshOpts())).toBe(false);
    });

    it('flags a boot-fallback game', () => {
        expect(buildFreshGameData(freshOpts({ bootFallback: true })).bootFallback).toBe(true);
    });

    it('omits bootFallback rather than setting it false', () => {
        // Same reasoning as tracedChunkDegraded above.
        expect('bootFallback' in buildFreshGameData(freshOpts())).toBe(false);
    });

    it('adds image fields only for an Unsplash photo', () => {
        const unsplash = makeGameState({ imageUrl: 'https://images.unsplash.com/photo-1' });
        const data = buildFreshGameData(freshOpts({
            state: unsplash, imageCategory: 'nature', vibrant: true,
        }));
        expect(data.imageSource).toBe('unsplash');
        expect(data.imageCategory).toBe('nature');
        expect(data.vibrant).toBe(true);
        expect(data.imagePicked).toBe(false);
    });

    it('reports the page an Unsplash photo was drawn from', () => {
        const unsplash = makeGameState({ imageUrl: 'https://images.unsplash.com/photo-1' });
        const data = buildFreshGameData(freshOpts({
            state: unsplash, pageDraw: { page: 84, knownPages: 166 },
        }));
        expect(data.imagePage).toBe(84);
        expect(data.imagePagesKnown).toBe(166);
    });

    it('omits the page fields when the photo came from no page draw', () => {
        const unsplash = makeGameState({ imageUrl: 'https://images.unsplash.com/photo-1' });
        const data = buildFreshGameData(freshOpts({ state: unsplash }));
        expect('imagePage' in data).toBe(false);
        expect('imagePagesKnown' in data).toBe(false);
    });

    it('reports imagePicked when the player chose a candidate', () => {
        const unsplash = makeGameState({ imageUrl: 'https://images.unsplash.com/photo-1' });
        const data = buildFreshGameData(freshOpts({
            state: unsplash,
            pickedImage: { imageUrl: 'x', imageSize: { width: 1, height: 1 } } as never,
        }));
        expect(data.imagePicked).toBe(true);
    });

    it('omits imageCategory, vibrant, and imagePicked when the source is not Unsplash', () => {
        // freshOpts()'s default state is non-Unsplash ('fallback'), so the
        // trio must be absent, not falsy.
        const data = buildFreshGameData(freshOpts());
        expect('imageCategory' in data).toBe(false);
        expect('vibrant' in data).toBe(false);
        expect('imagePicked' in data).toBe(false);
    });

    it('includes traceSetVersion when the generated state carries one', () => {
        const state = makeGameState({
            cutStyle: 'classic',
            classicConfig: { traceSetVersion: 4 },
        });
        expect(buildFreshGameData(freshOpts({ state })).traceSetVersion).toBe(4);
    });

    it('omits traceSetVersion when the generated state carries none', () => {
        // freshOpts()'s default is Classic with no classicConfig (legacy case).
        expect('traceSetVersion' in buildFreshGameData(freshOpts())).toBe(false);
    });

    it('stamps generation mode and duration', () => {
        const data = buildFreshGameData(freshOpts({
            generation: { mode: 'worker', durationMs: 250 },
        }));
        expect(data.generationMode).toBe('worker');
        expect(data.generationMs).toBe(250);
        expect(data.generationFallbackReason).toBeUndefined();
    });

    it('stamps the fallback kind and reason only when falling back', () => {
        const data = buildFreshGameData(freshOpts({
            generation: {
                mode: 'sync-fallback',
                durationMs: 900,
                fallbackKind: 'worker-error',
                fallbackReason: 'Generation worker error',
            },
        }));
        expect(data.generationMode).toBe('sync-fallback');
        // The kind is low-cardinality (operators segment on it); the reason is free text.
        expect(data.generationFallbackKind).toBe('worker-error');
        expect(data.generationFallbackReason).toBe('Generation worker error');
    });

    it('omits the fallback fields rather than setting them undefined', () => {
        // Umami cannot filter on absence, so an explicit `undefined` would
        // show as a value rather than a missing key.
        const data = buildFreshGameData(freshOpts({
            generation: { mode: 'worker', durationMs: 250 },
        }));
        expect('generationFallbackKind' in data).toBe(false);
        expect('generationFallbackReason' in data).toBe(false);
    });
});

describe('buildSharedGameData', () => {
    it('marks the source shared and reads geometry off the generated state', () => {
        const data = buildSharedGameData(sharedOpts({
            state: makeGameState({ gridSize: { cols: 4, rows: 7 } }),
            includesProgress: true,
            recipientHadSavedState: false,
            sharedColor: 'adopted',
        }));
        expect(data.source).toBe('shared');
        expect(data.cols).toBe(4);
        expect(data.rows).toBe(7);
        expect(data.includesProgress).toBe(true);
        expect(data.sharedColor).toBe('adopted');
    });

    it('derives orientation from the post-transpose grid, squares reading landscape', () => {
        // Link stores the post-transpose grid (matches orientGridSize).
        expect(buildSharedGameData(sharedOpts({
            state: makeGameState({ gridSize: { cols: 4, rows: 9 } }),
        })).orientation).toBe('portrait');

        expect(buildSharedGameData(sharedOpts({
            state: makeGameState({ gridSize: { cols: 5, rows: 5 } }),
        })).orientation).toBe('landscape');
    });

    it('includes traceSetVersion when the generated state carries one', () => {
        const state = makeGameState({
            cutStyle: 'classic',
            classicConfig: { traceSetVersion: 5 },
        });
        const data = buildSharedGameData(sharedOpts({ state }));
        expect(data.traceSetVersion).toBe(5);
    });

    it('omits traceSetVersion when the generated state carries none', () => {
        // Pre-upgrade Classic link (no matching config block) carries no key.
        const state = makeGameState({ gridSize: { cols: 4, rows: 7 } });
        const data = buildSharedGameData(sharedOpts({ state }));
        expect('traceSetVersion' in data).toBe(false);
    });

    it('stamps generation mode and duration', () => {
        const data = buildSharedGameData(sharedOpts({
            generation: { mode: 'worker', durationMs: 250 },
        }));
        expect(data.generationMode).toBe('worker');
        expect(data.generationMs).toBe(250);
        expect(data.generationFallbackReason).toBeUndefined();
    });

    it('stamps the fallback kind and reason only when falling back', () => {
        const data = buildSharedGameData(sharedOpts({
            generation: {
                mode: 'sync-fallback',
                durationMs: 900,
                fallbackKind: 'worker-error',
                fallbackReason: 'Generation worker error',
            },
        }));
        expect(data.generationMode).toBe('sync-fallback');
        // The kind is low-cardinality (operators segment on it); the reason is free text.
        expect(data.generationFallbackKind).toBe('worker-error');
        expect(data.generationFallbackReason).toBe('Generation worker error');
    });

    it('omits the fallback fields rather than setting them undefined', () => {
        // Umami cannot filter on absence, so an explicit `undefined` would
        // show as a value rather than a missing key.
        const data = buildSharedGameData(sharedOpts({
            generation: { mode: 'worker', durationMs: 250 },
        }));
        expect('generationFallbackKind' in data).toBe(false);
        expect('generationFallbackReason' in data).toBe(false);
    });
});
