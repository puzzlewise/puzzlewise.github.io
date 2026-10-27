import { track } from '../analytics/index.js';
import { findImageCategory, buildImageQuery, resolveQueryOverride, isCustomQuery } from '../game/image-categories.js';
import { downloadOfflineImages, OFFLINE_STASH_COUNT } from '../images/offline-stash.js';
import type { Orientation } from '../model/types.js';

export async function downloadOfflineImagesForCategory(
    proxyBaseUrl: string,
    imageCategory: string,
    vibrant: boolean,
    orientation: Orientation,
    onProgress?: (done: number, total: number) => void,
    queryOverride?: string,
): Promise<number> {
    const category = findImageCategory(imageCategory);
    const query = buildImageQuery(resolveQueryOverride(category.query, queryOverride), vibrant);
    const { saved, reason } = await downloadOfflineImages({
        proxyBaseUrl,
        context: { caller: 'stash', imageCategory, vibrant, custom: isCustomQuery(queryOverride) },
        query,
        orientation,
        onProgress,
    });
    track('offline-images-saved', {
        requested: OFFLINE_STASH_COUNT,
        saved,
        reason,
        imageCategory,
        orientation,
        vibrant,
    });
    return saved;
}
