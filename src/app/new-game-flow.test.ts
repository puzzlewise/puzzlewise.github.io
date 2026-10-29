/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { GridSize } from '../model/types.js';
import type { StartNewGameOptions } from './start-new-game.js';

vi.mock('../ui/toast.js', () => ({ showToast: vi.fn() }));
// Only `createNewGameDialog` is stubbed; everything else passes through,
// including the rotation-preference load/save this suite exercises for real.
vi.mock('../ui/index.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../ui/index.js')>()),
    createNewGameDialog: vi.fn(),
}));
// `generator-registry.ts` registers `tracedTabGeneratorStub` from this module
// at import time, so pass the rest through or that registration is undefined
// and throws before any test runs.
vi.mock('../puzzle/topology/traced-tab-loader.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../puzzle/topology/traced-tab-loader.js')>();
    return { ...actual, preloadTracedTabGenerator: vi.fn() };
});
vi.mock('./download-offline-images.js', () => ({
    downloadOfflineImagesForCategory: vi.fn(),
}));
vi.mock('./fetch-candidate-images.js', () => ({
    fetchCandidateImages: vi.fn(),
}));

import { showToast } from '../ui/toast.js';
import {
    createNewGameDialog,
    loadRotationEnabledPreference,
    type NewGameSelection,
} from '../ui/index.js';
import { preloadTracedTabGenerator } from '../puzzle/topology/traced-tab-loader.js';
import { loadSizePreference } from '../game/puzzle-sizes.js';
import { loadCutStylePreference } from '../game/cut-styles.js';
import { loadComposableConfigPreference } from '../game/composable-config.js';
import { loadFractalConfigPreference } from '../game/fractal-config.js';
import { loadWavyConfigPreference } from '../game/wavy-config.js';
import { loadImageSourcePreference } from '../game/image-source.js';
import { loadImageCategoryPreference, loadVibrantPreference } from '../game/image-categories.js';
import { loadState, saveNewPuzzle } from '../persistence/index.js';
import { makeSavedGameState } from '../test-helpers/fixtures.js';
import { downloadOfflineImagesForCategory } from './download-offline-images.js';
import { fetchCandidateImages } from './fetch-candidate-images.js';
import { openNewGameDialog } from './new-game-flow.js';
import type { CandidateImage } from '../images/index.js';

function makeCandidate(): CandidateImage {
    return {
        imageUrl: 'https://images.unsplash.com/photo-abc?w=1080',
        imageSize: { width: 1080, height: 720 },
        attribution: { photographerName: 'A', photographerUrl: 'https://unsplash.com/@a', photoUrl: 'https://unsplash.com/photos/abc123' },
        downloadLocation: 'https://api.unsplash.com/photos/abc123/download',
        thumbUrl: 'https://images.unsplash.com/photo-abc?w=400',
    };
}

describe('openNewGameDialog', () => {
    let container: HTMLElement;
    let start: Mock<(gridSize: GridSize, options: StartNewGameOptions) => Promise<void>>;
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        localStorage.clear();
        vi.mocked(createNewGameDialog).mockClear();
        // `mockReset` (not `vi.clearAllMocks()`, which clears only call
        // records) so an earlier test's `mockRejectedValue` doesn't bleed in.
        vi.mocked(preloadTracedTabGenerator).mockReset().mockResolvedValue(undefined);
        vi.mocked(showToast).mockClear();

        container = document.createElement('div');
        start = vi.fn(async () => {});

        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
        vi.restoreAllMocks();
    });

    function open() {
        openNewGameDialog({ container, start });
        return vi.mocked(createNewGameDialog).mock.calls[0][0];
    }

    /**
     * The per-style configs are omitted by default, mirroring the real dialog:
     * it fills only the one matching the selected cut style.
     */
    function selectWith(overrides: Partial<NewGameSelection> = {}) {
        const opts = open();
        opts.onSelect({
            sizeId: opts.selectedSizeId,
            cutStyleId: 'wavy',
            rotationEnabled: true,
            imageChoice: { kind: 'surprise' },
            imageCategory: 'nature',
            vibrant: true,
            ...overrides,
        });
        return opts;
    }

    it('seeds the dialog from the saved preferences', () => {
        const opts = open();

        expect(opts.selectedSizeId).toBe(loadSizePreference());
        expect(opts.selectedCutStyleId).toBe(loadCutStylePreference());
        expect(opts.savedComposableConfig).toBe(loadComposableConfigPreference());
        expect(opts.savedFractalConfig).toBe(loadFractalConfigPreference());
        expect(opts.savedWavyConfig).toBe(loadWavyConfigPreference());
        expect(opts.savedRotationEnabled).toBe(loadRotationEnabledPreference());
        expect(opts.savedImageCategory).toBe(loadImageCategoryPreference());
        expect(opts.savedVibrant).toBe(loadVibrantPreference());
        // The real sine base-cut generator advertises borderless support.
        expect(opts.composableSupportsBorderless).toBe(true);
    });

    it('persists the chosen size', () => {
        selectWith({ sizeId: '96' });
        expect(loadSizePreference()).toBe('96');
    });

    it('persists the chosen cut style', () => {
        selectWith({ cutStyleId: 'fractal', fractalConfig: { borderless: true } });
        expect(loadCutStylePreference()).toBe('fractal');
    });

    it('persists the composable config when the cut style is composable', () => {
        const composableConfig: NonNullable<NewGameSelection['composableConfig']> = {
            baseCut: 'sine',
            horizontalAmplitude: 0.22,
            horizontalFrequency: 1.7,
            verticalAmplitude: 0.11,
            verticalFrequency: 2.3,
            tabGenerator: 'classic',
            borderless: true,
            jitter: 0.2,
            smooth: true,
        };
        selectWith({ cutStyleId: 'composable', composableConfig });
        expect(loadComposableConfigPreference()).toEqual(composableConfig);
    });

    it('persists the fractal config when the cut style is fractal', () => {
        selectWith({ cutStyleId: 'fractal', fractalConfig: { borderless: true } });
        expect(loadFractalConfigPreference()).toEqual({ borderless: true });
    });

    it('persists the wavy config when the cut style is wavy', () => {
        selectWith({ cutStyleId: 'wavy', wavyConfig: { borderless: true } });
        expect(loadWavyConfigPreference()).toEqual({ borderless: true });
    });

    it('persists the rotation-enabled preference', () => {
        selectWith({ rotationEnabled: true });
        expect(loadRotationEnabledPreference()).toBe(true);
    });

    it('persists the image source as blank when a blank puzzle is chosen', () => {
        // No UI reads this preference, but first-run detection depends on the
        // key existing and analytics classifies by it — pinned against the
        // real loader, not just key presence.
        selectWith({ imageChoice: { kind: 'blank' } });
        expect(loadImageSourcePreference()).toBe('blank');
    });

    it('persists the image source as random for a photo or surprise pick', () => {
        selectWith({ imageChoice: { kind: 'surprise' } });
        expect(loadImageSourcePreference()).toBe('random');
    });

    it('persists the chosen image category', () => {
        selectWith({ imageCategory: 'architecture' });
        expect(loadImageCategoryPreference()).toBe('architecture');
    });

    it('persists the vibrant preference', () => {
        selectWith({ vibrant: true });
        expect(loadVibrantPreference()).toBe(true);
    });

    it('leaves the previous save intact when the start is canceled (or throws)', () => {
        // The real `startNewGame` replaces the save only once generation fully
        // succeeds; a cancel (#489) or throw never reaches its
        // `persistNewPuzzle`. The default no-op `start` stub models that — it
        // never touches storage.
        saveNewPuzzle(makeSavedGameState());

        selectWith();

        expect(loadState()?.imageUrl).toBe('test-image.jpg');
    });

    it('replaces the previous save once the start actually succeeds', () => {
        // `startNewGame` persists the new puzzle itself once generation
        // succeeds; `new-game-flow.ts` no longer clears storage, so the stub
        // must model that to exercise "replaced" rather than "cleared".
        saveNewPuzzle(makeSavedGameState());
        start.mockImplementation(async () => {
            saveNewPuzzle({ ...makeSavedGameState(), imageUrl: 'new-puzzle.jpg' });
        });

        selectWith();

        expect(loadState()?.imageUrl).toBe('new-puzzle.jpg');
    });

    it('starts the game with the chosen size and options', () => {
        selectWith({ sizeId: '96', cutStyleId: 'wavy', wavyConfig: { borderless: true } });

        expect(start).toHaveBeenCalledWith(
            { cols: 12, rows: 8 },
            expect.objectContaining({
                cutStyle: 'wavy',
                rotationEnabled: true,
                vibrant: true,
                imageCategory: 'nature',
                wavyConfig: { borderless: true },
            }),
        );
    });

    it('passes the query override through to the start call', () => {
        selectWith({ queryOverride: 'red bicycles' });
        expect(start).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ queryOverride: 'red bicycles' }),
        );
    });

    it('omits the seed so every dialog game is a fresh random puzzle', () => {
        selectWith();
        expect(start.mock.calls[0][1]).not.toHaveProperty('seed');
    });

    it('passes a picked photo through', () => {
        const photo = {
            imageUrl: 'https://images.example/x.jpg',
            imageSize: { width: 100, height: 200 },
            attribution: { photographerName: 'A', photographerUrl: 'https://x', photoUrl: 'https://y' },
            downloadLocation: 'https://z',
            thumbUrl: 'https://thumb',
        };
        selectWith({ imageChoice: { kind: 'photo', photo, slot: 0 } });
        expect(start.mock.calls[0][1].pickedImage).toBe(photo);
    });

    it('translates the composable slider config into a generator config for the start call', () => {
        const composableConfig: NonNullable<NewGameSelection['composableConfig']> = {
            baseCut: 'triangular',
            horizontalAmplitude: 0.2,
            horizontalFrequency: 1.5,
            verticalAmplitude: 0.2,
            verticalFrequency: 1.5,
            tabGenerator: 'none',
            borderless: false,
            jitter: 0.3,
            smooth: true,
        };
        selectWith({ cutStyleId: 'composable', composableConfig });

        expect(start.mock.calls[0][1].composableConfig).toEqual(
            expect.objectContaining({ baseCutGenerator: 'triangular', tabGenerator: 'none' }),
        );
    });

    it('kicks off the traced-tab preload without leaking an unhandled rejection', async () => {
        vi.mocked(preloadTracedTabGenerator).mockReset().mockRejectedValue(new Error('chunk boom'));
        const opts = open();

        // Must not throw synchronously nor become an unhandled rejection —
        // vitest's process-level handler would fail the run, and this repo
        // sets no `dangerouslyIgnoreUnhandledErrors`.
        expect(() => opts.onPreloadTracedTabs?.()).not.toThrow();
        expect(preloadTracedTabGenerator).toHaveBeenCalledTimes(1);
        // Let the swallowed rejection's microtask settle before the test ends.
        await Promise.resolve();
        await Promise.resolve();
    });

    it('starts silently and reports nothing when the start succeeds', async () => {
        selectWith();
        await vi.waitFor(() => expect(start).toHaveBeenCalled());

        expect(showToast).not.toHaveBeenCalled();
        expect(umamiTrack).not.toHaveBeenCalledWith('new-game-failed', expect.anything());
    });

    it('toasts and reports new-game-failed, attributed to the failing cut style, when the start rejects', async () => {
        start.mockRejectedValue(new Error('chunk boom'));
        selectWith({ cutStyleId: 'wavy', wavyConfig: { borderless: false } });

        await vi.waitFor(() => {
            expect(showToast).toHaveBeenCalledWith("Couldn't start new game");
        });
        expect(umamiTrack).toHaveBeenCalledWith('new-game-failed', {
            reason: 'chunk boom',
            cutStyle: 'wavy',
        });
    });

    describe('offline images wiring', () => {
        const fakeCaches = {} as CacheStorage;

        afterEach(() => {
            vi.unstubAllEnvs();
            delete (globalThis as { caches?: CacheStorage }).caches;
        });

        it('offers offline downloads when the proxy and the Cache API are available', async () => {
            vi.stubEnv('VITE_IMAGE_PROXY_URL', 'https://proxy.example');
            (globalThis as { caches?: CacheStorage }).caches = fakeCaches;
            vi.mocked(downloadOfflineImagesForCategory).mockResolvedValue(8);

            const opts = open();

            expect(opts.offlineImages).toBeDefined();
            expect(opts.offlineImages!.count()).toBe(0);

            const onProgress = vi.fn();
            await opts.offlineImages!.download('nature', true, onProgress);
            expect(vi.mocked(downloadOfflineImagesForCategory)).toHaveBeenCalledWith(
                'https://proxy.example', 'nature', true, 'landscape', onProgress, undefined,
            );
        });

        it('threads the query override into the offline download', async () => {
            vi.stubEnv('VITE_IMAGE_PROXY_URL', 'https://proxy.example');
            (globalThis as { caches?: CacheStorage }).caches = fakeCaches;
            vi.mocked(downloadOfflineImagesForCategory).mockResolvedValue(8);

            const opts = open();

            const onProgress = vi.fn();
            await opts.offlineImages!.download('nature', true, onProgress, 'red bicycles');
            expect(vi.mocked(downloadOfflineImagesForCategory)).toHaveBeenCalledWith(
                'https://proxy.example', 'nature', true, 'landscape', onProgress, 'red bicycles',
            );
        });

        it('omits offline downloads when the Cache API is missing', () => {
            vi.stubEnv('VITE_IMAGE_PROXY_URL', 'https://proxy.example');

            expect(open().offlineImages).toBeUndefined();
        });

        it('omits offline downloads when no proxy is configured', () => {
            vi.stubEnv('VITE_IMAGE_PROXY_URL', '');
            (globalThis as { caches?: CacheStorage }).caches = fakeCaches;

            expect(open().offlineImages).toBeUndefined();
        });
    });

    describe('dialog visit analytics', () => {
        afterEach(() => {
            vi.unstubAllEnvs();
        });

        function events(name: string): unknown[] {
            return umamiTrack.mock.calls.filter(([n]) => n === name).map(([, d]) => d);
        }

        it('opens a visit with the current game state', () => {
            openNewGameDialog({ container, start, currentGame: () => ({ completed: true }) });

            expect(events('new-game-dialog-opened')[0]).toMatchObject({ hasPuzzle: true, puzzleCompleted: true });
        });

        it('opens a visit with no puzzle when none is installed', () => {
            open();

            expect(events('new-game-dialog-opened')[0]).toMatchObject({ hasPuzzle: false, puzzleCompleted: false });
        });

        it('closes the visit with the pick', () => {
            const opts = open();
            opts.onSelect({
                sizeId: '48',
                cutStyleId: 'classic',
                rotationEnabled: false,
                imageChoice: { kind: 'photo', photo: makeCandidate(), slot: 1 },
                imageCategory: 'nature',
                vibrant: false,
            });

            expect(events('new-game-dialog-closed')[0]).toMatchObject({ outcome: 'photo', pickedSlot: 1 });
        });

        it('closes the visit on cancel', () => {
            const opts = open();
            opts.onCancel!({ imageCategory: 'face', vibrant: true });

            expect(events('new-game-dialog-closed')[0]).toMatchObject({
                outcome: 'cancel',
                pickedSlot: -1,
                imageCategory: 'face',
                vibrant: true,
            });
        });

        it('reports each thumbnail batch', async () => {
            vi.stubEnv('VITE_IMAGE_PROXY_URL', 'https://proxy.example');
            vi.mocked(fetchCandidateImages).mockResolvedValue({ candidates: [], cause: 'http-error', source: 'none' });

            await open().fetchImageCandidates!('nature', false, undefined, 'open');

            expect(events('image-candidates-loaded')[0]).toMatchObject({
                trigger: 'open',
                outcome: 'error',
                cause: 'http-error',
                imageCategory: 'nature',
            });
        });

        it('reports thumbnail failures with the photo id', () => {
            open().analytics!.thumbnailFailed(2, makeCandidate(), 'nature');

            expect(events('image-thumbnail-failed')[0]).toEqual({ slot: 2, photoId: 'abc123', imageCategory: 'nature' });
        });
    });

    describe('candidate fetch wiring', () => {
        afterEach(() => {
            vi.unstubAllEnvs();
        });

        it('threads the query override into the candidate fetch', async () => {
            vi.stubEnv('VITE_IMAGE_PROXY_URL', 'https://proxy.example');
            vi.mocked(fetchCandidateImages).mockResolvedValue({ candidates: [], cause: 'http-error', source: 'none' });

            const opts = open();

            await opts.fetchImageCandidates!('nature', true, 'red bicycles', 'open');
            expect(vi.mocked(fetchCandidateImages)).toHaveBeenCalledWith(
                'https://proxy.example', 'nature', true, expect.any(String), 'red bicycles',
            );
        });
    });
});
