/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../images/offline-stash.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../images/offline-stash.js')>()),
    downloadOfflineImages: vi.fn(),
}));

import { downloadOfflineImages, OFFLINE_STASH_COUNT } from '../images/offline-stash.js';
import { downloadOfflineImagesForCategory } from './download-offline-images.js';

describe('downloadOfflineImagesForCategory', () => {
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.mocked(downloadOfflineImages).mockReset().mockResolvedValue({ saved: 5, reason: 'saved' });
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
    });

    it('builds the category query and passes the download through', async () => {
        const onProgress = vi.fn();

        const saved = await downloadOfflineImagesForCategory(
            'https://proxy.example', 'nature', true, 'portrait', onProgress,
        );

        expect(saved).toBe(5);
        expect(vi.mocked(downloadOfflineImages)).toHaveBeenCalledWith({
            proxyBaseUrl: 'https://proxy.example',
            context: { caller: 'stash', imageCategory: 'nature', vibrant: true, custom: false },
            query: 'nature vibrant colorful',
            orientation: 'portrait',
            onProgress,
        });
    });

    it('uses the query override in place of the category query', async () => {
        const onProgress = vi.fn();

        await downloadOfflineImagesForCategory(
            'https://proxy.example', 'nature', true, 'portrait', onProgress, 'red bicycles',
        );

        expect(vi.mocked(downloadOfflineImages)).toHaveBeenCalledWith({
            proxyBaseUrl: 'https://proxy.example',
            context: { caller: 'stash', imageCategory: 'nature', vibrant: true, custom: true },
            query: 'red bicycles vibrant colorful',
            orientation: 'portrait',
            onProgress,
        });
    });

    it('tracks the settled attempt', async () => {
        await downloadOfflineImagesForCategory('https://proxy.example', 'nature', false, 'landscape');

        expect(umamiTrack).toHaveBeenCalledWith('offline-images-saved', {
            requested: OFFLINE_STASH_COUNT,
            saved: 5,
            reason: 'saved',
            imageCategory: 'nature',
            orientation: 'landscape',
            vibrant: false,
        });
    });

    it('tracks a failed attempt as saved 0 with its reason', async () => {
        vi.mocked(downloadOfflineImages).mockResolvedValue({ saved: 0, reason: 'write-failed' });

        const saved = await downloadOfflineImagesForCategory('https://proxy.example', 'any', false, 'landscape');

        expect(saved).toBe(0);
        expect(umamiTrack).toHaveBeenCalledWith('offline-images-saved', {
            requested: OFFLINE_STASH_COUNT,
            saved: 0,
            reason: 'write-failed',
            imageCategory: 'any',
            orientation: 'landscape',
            vibrant: false,
        });
    });
});
