/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

vi.mock('../ui/loading-overlay.js', () => ({
    showLoadingOverlay: vi.fn(),
    hideLoadingOverlay: vi.fn(),
}));

import { hideLoadingOverlay } from '../ui/loading-overlay.js';
import { SelectionManager, ViewportTransform } from '../interaction/index.js';
import { makeSavedGameState } from '../test-helpers/fixtures.js';
import { loadSavedGame, saveNewPuzzle, STORAGE_KEY } from '../persistence/index.js';
import { saveCutStylePreference } from '../game/cut-styles.js';
import { saveComposableConfigPreference } from '../game/composable-config.js';
import { saveFractalConfigPreference } from '../game/fractal-config.js';
import { saveWavyConfigPreference } from '../game/wavy-config.js';
import { saveImageSourcePreference } from '../game/image-source.js';
import { saveImageCategoryPreference, saveVibrantPreference } from '../game/image-categories.js';
import { saveRotationEnabledPreference } from '../ui/index.js';
import type { GameState, GridSize } from '../model/types.js';
import { runBootSequence, type BootSequenceDeps } from './boot-sequence.js';
import type { StartNewGameOptions } from './start-new-game.js';
import { createSaveCoordinator } from './save-coordinator.js';

function dismissCorruptSaveDialog(container: HTMLElement): void {
    const btn = Array.from(
        container.querySelectorAll<HTMLButtonElement>('.corrupt-save-btn'),
    ).find((b) => b.textContent === 'Start new game')!;
    btn.click();
}

/**
 * Poll a real condition rather than a fixed tick count: `runBootSequence`
 * defers past its `tryLoadShared()` await via the microtask queue, so state
 * right after calling (not awaiting) it proves nothing.
 */
async function flushUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error('flushUntil: condition never became true');
}

describe('runBootSequence', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;
    let install: Mock<(state: GameState) => void>;
    let restoreSelection: Mock<(saved: readonly number[]) => void>;
    let onResumed: Mock<(state: GameState) => void>;
    let start: Mock<(gridSize: GridSize, options: StartNewGameOptions) => Promise<void>>;
    let hasGame: boolean;

    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
        install = vi.fn();
        restoreSelection = vi.fn();
        onResumed = vi.fn();
        start = vi.fn(async () => { hasGame = true; });
        hasGame = false;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    function deps(overrides: Partial<BootSequenceDeps> = {}): BootSequenceDeps {
        return {
            container: document.createElement('div'),
            session: { install, restoreSelection, hasGame: () => hasGame },
            viewportTransform: new ViewportTransform(),
            applyTransform: vi.fn(),
            tryLoadShared: vi.fn(async () => false),
            isRescueReloadPending: () => false,
            start,
            onResumed,
            ...overrides,
        };
    }

    it('stops after a share link handled the boot, even with a readable save waiting', async () => {
        // Seed a save so asserting `install` was never called actually pins
        // share > saved, not just "saved handling found nothing".
        saveNewPuzzle(makeSavedGameState(), [0]);
        const d = deps({ tryLoadShared: vi.fn(async () => true) });
        await runBootSequence(d);
        expect(start).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
        expect(onResumed).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it('starts a fresh puzzle when there is no save', async () => {
        await runBootSequence(deps());
        expect(start).toHaveBeenCalledTimes(1);
        expect(onResumed).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it('marks a brand-new visitor as first-run', async () => {
        // No save and no touched image preference: gets the bundled image,
        // not a random one.
        await runBootSequence(deps());
        expect(start.mock.calls[0][1].imageSource).toBe('first-run');
        expect(console.error).not.toHaveBeenCalled();
    });

    it('is not first-run when an image-source preference exists, even with no save', async () => {
        saveImageSourcePreference('unsplash');
        await runBootSequence(deps());
        // Assert the concrete value, not `not.toBe('first-run')` — that would
        // pass for `undefined` too and prove nothing was read.
        expect(start.mock.calls[0][1].imageSource).toBe('unsplash');
        expect(console.error).not.toHaveBeenCalled();
    });

    it('is not first-run when an image-category preference exists, even with no save', async () => {
        saveImageCategoryPreference('nature');
        await runBootSequence(deps());
        // No image-source preference saved, so the non-first-run reading is
        // `undefined` (unset), not the 'first-run' sentinel.
        expect(start.mock.calls[0][1].imageSource).toBeUndefined();
        expect(console.error).not.toHaveBeenCalled();
    });

    it('hides the loading overlay when boot finishes', async () => {
        await runBootSequence(deps());
        expect(hideLoadingOverlay).toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it('leaves the overlay up when a rescue reload is pending', async () => {
        // Otherwise the page flashes blank for the gap before the reload lands.
        await runBootSequence(deps({
            tryLoadShared: vi.fn(async () => true),
            isRescueReloadPending: () => true,
        }));
        expect(hideLoadingOverlay).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it('substitutes a Classic puzzle when the preferred start fails', async () => {
        const failing = vi.fn()
            .mockRejectedValueOnce(new Error('chunk boom'))
            .mockImplementationOnce(async () => { hasGame = true; });
        await runBootSequence(deps({ start: failing }));
        expect(failing).toHaveBeenCalledTimes(2);
        expect(failing.mock.calls[1][1].bootFallback).toBe(true);
    });

    it('drops the per-style configs but keeps size, image, vibrancy and rotation in the fallback', async () => {
        // Seed both the per-style preferences the fallback must drop and the
        // ones it must keep.
        saveCutStylePreference('fractal');
        saveFractalConfigPreference({ borderless: true });
        saveWavyConfigPreference({ borderless: true });
        saveImageSourcePreference('blank');
        saveImageCategoryPreference('nature');
        saveVibrantPreference(true);
        saveRotationEnabledPreference(true);

        const failing = vi.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockImplementationOnce(async () => { hasGame = true; });
        await runBootSequence(deps({ start: failing }));

        // Contrast case: the preferred start must still carry the per-style
        // configs, or dropping them from both calls would also pass.
        const preferredOptions = failing.mock.calls[0][1];
        expect(preferredOptions).toEqual({
            cutStyle: 'fractal',
            composableConfig: undefined,
            imageSource: 'blank',
            imageCategory: 'nature',
            fractalConfig: { borderless: true },
            wavyConfig: { borderless: true },
            vibrant: true,
            rotationEnabled: true,
        });

        const fallbackOptions = failing.mock.calls[1][1];
        expect(fallbackOptions).toEqual({
            bootFallback: true,
            imageSource: 'blank',
            imageCategory: 'nature',
            vibrant: true,
            rotationEnabled: true,
        });

        // The fallback keeps the grid size, doesn't resize it.
        expect(failing.mock.calls[1][0]).toEqual(failing.mock.calls[0][0]);
    });

    it('converts a composable slider preference into the generator config for the preferred start', async () => {
        saveCutStylePreference('composable');
        saveComposableConfigPreference({
            baseCut: 'sine',
            horizontalAmplitude: 0.2,
            horizontalFrequency: 1.5,
            verticalAmplitude: 0.3,
            verticalFrequency: 2,
            tabGenerator: 'classic',
            borderless: true,
            jitter: 0.15,
            smooth: false,
        });
        await runBootSequence(deps());
        expect(start.mock.calls[0][1].composableConfig).toEqual({
            baseCutGenerator: 'sine',
            baseCutConfig: { ha: 0.2, hf: 1.5, va: 0.3, vf: 2 },
            tabGenerator: 'classic',
            tabConfig: {},
            borderless: true,
        });
    });

    it('does not convert a stale composable preference when the cut style is not composable', async () => {
        // A stale composable slider preference (player switched to Fractal)
        // must not leak into a Fractal start.
        saveCutStylePreference('fractal');
        saveComposableConfigPreference({
            baseCut: 'sine',
            horizontalAmplitude: 0.2,
            horizontalFrequency: 1.5,
            verticalAmplitude: 0.3,
            verticalFrequency: 2,
            tabGenerator: 'classic',
            borderless: true,
            jitter: 0.15,
            smooth: false,
        });
        await runBootSequence(deps());
        expect(start.mock.calls[0][1].composableConfig).toBeUndefined();
        expect(console.error).not.toHaveBeenCalled();
    });

    describe('a readable saved game', () => {
        it('installs the state and restores the selection', async () => {
            saveNewPuzzle(makeSavedGameState(), [0]);
            await runBootSequence(deps());
            expect(install).toHaveBeenCalledWith(
                expect.objectContaining({ imageUrl: 'test-image.jpg' }),
            );
            expect(restoreSelection).toHaveBeenCalledWith([0]);
            expect(start).not.toHaveBeenCalled();
            expect(console.error).not.toHaveBeenCalled();
        });

        it('reports the installed state as resumed, after installing it', async () => {
            // #507: `install` clears the cached analytics, so restoring them
            // before it would be wiped.
            saveNewPuzzle(makeSavedGameState(), [0]);
            await runBootSequence(deps());
            expect(onResumed).toHaveBeenCalledTimes(1);
            expect(onResumed.mock.calls[0][0]).toBe(install.mock.calls[0][0]);
            expect(install.mock.invocationCallOrder[0]).toBeLessThan(
                onResumed.mock.invocationCallOrder[0],
            );
        });

        it('applies a saved viewport', async () => {
            saveNewPuzzle(makeSavedGameState(), [], { scale: 2, offset: { x: 10, y: 20 } });
            const d = deps();
            await runBootSequence(d);
            expect(d.viewportTransform.getState()).toEqual({ scale: 2, offset: { x: 10, y: 20 } });
            expect(d.applyTransform).toHaveBeenCalled();
            expect(console.error).not.toHaveBeenCalled();
        });

        it('writes back the saved viewport when restoring the selection arms an autosave', async () => {
            const viewport = { scale: 2.5, offset: { x: 10, y: 20 } };
            saveNewPuzzle(makeSavedGameState(), [0], viewport);
            const d = deps();
            const selectionManager = new SelectionManager();
            const saveCoordinator = createSaveCoordinator({
                selectionManager,
                viewportTransform: d.viewportTransform,
            });
            selectionManager.onChange(() => saveCoordinator.autoSave(install.mock.calls[0][0]));
            restoreSelection.mockImplementation((ids) => {
                for (const id of ids) selectionManager.select(id);
            });

            await runBootSequence(d);
            saveCoordinator.flush();

            expect(loadSavedGame()).toMatchObject({ status: 'ok', selection: [0], viewport });
            expect(console.error).not.toHaveBeenCalled();
        });

        it('keeps the default view for a pre-feature save with no viewport', async () => {
            saveNewPuzzle(makeSavedGameState(), []);
            const d = deps();
            await runBootSequence(d);
            expect(d.viewportTransform.getState()).toEqual({ scale: 1, offset: { x: 0, y: 0 } });
            expect(d.applyTransform).not.toHaveBeenCalled();
            expect(console.error).not.toHaveBeenCalled();
        });
    });

    describe('an unreadable saved game', () => {
        beforeEach(() => {
            localStorage.setItem(STORAGE_KEY, '{not valid json!!!');
        });

        it('reports save-unreadable, hides the overlay, and opens the corrupt-save dialog', async () => {
            const d = deps();
            const promise = runBootSequence(d);
            await flushUntil(() => d.container.querySelector('.corrupt-save-dialog') !== null);

            expect(umamiTrack).toHaveBeenCalledWith(
                'save-unreadable',
                expect.objectContaining({ reason: 'parse-error' }),
            );
            expect(hideLoadingOverlay).toHaveBeenCalled();
            expect(console.error).not.toHaveBeenCalled();

            dismissCorruptSaveDialog(d.container);
            await promise;
        });

        it('does not start a fresh puzzle while the dialog is open, only after it is dismissed', async () => {
            const d = deps();
            const promise = runBootSequence(d);
            await flushUntil(() => d.container.querySelector('.corrupt-save-dialog') !== null);

            expect(start).not.toHaveBeenCalled();

            dismissCorruptSaveDialog(d.container);
            await promise;

            expect(start).toHaveBeenCalledTimes(1);
            expect(console.error).not.toHaveBeenCalled();
        });

        it('reports save-recovery and is not first-run for this returning user', async () => {
            const d = deps();
            const promise = runBootSequence(d);
            await flushUntil(() => d.container.querySelector('.corrupt-save-dialog') !== null);
            dismissCorruptSaveDialog(d.container);
            await promise;

            expect(umamiTrack).toHaveBeenCalledWith(
                'save-recovery',
                expect.objectContaining({ downloaded: false }),
            );
            // A returning user (unreadable save) keeps random-image behavior,
            // not first-run. No source preference saved here, so it reads
            // `undefined` (unset).
            expect(start.mock.calls[0][1].imageSource).toBeUndefined();
            expect(console.error).not.toHaveBeenCalled();
        });
    });
});
