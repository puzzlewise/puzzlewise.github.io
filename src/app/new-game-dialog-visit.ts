import { track } from '../analytics/index.js';
import type { ImageCandidatesLoadedData } from '../analytics/index.js';
import type { CandidateFetchResult } from '../images/index.js';
import { photoIdFromDownloadLocation } from '../images/photo-id.js';
import type { Orientation } from '../model/types.js';

export type BatchTrigger = ImageCandidatesLoadedData['trigger'];

export type DialogOutcome = 'photo' | 'surprise' | 'blank' | 'cancel';

export interface BatchParams {
    imageCategory: string;
    vibrant: boolean;
    custom: boolean;
    orientation: Orientation;
}

export interface NewGameDialogVisit {
    batchStarted(trigger: BatchTrigger, params: BatchParams): (result: CandidateFetchResult) => void;
    optionChanged(setting: 'category' | 'vibrant' | 'query', from: string, to: string): void;
    thumbnailLoaded(): void;
    thumbnailFailed(slot: number, photoId: string, imageCategory: string): void;
    creditOpened(photoId: string): void;
    offlineDownloadUsed(): void;
    closed(outcome: DialogOutcome, pickedSlot: number, final: { imageCategory: string; vibrant: boolean }): void;
}

export function createNewGameDialogVisit(opts: {
    hasPuzzle: boolean;
    puzzleCompleted: boolean;
    imageCategory: string;
    vibrant: boolean;
    picker: boolean;
    offlineDownload: boolean;
    now?: () => number;
}): NewGameDialogVisit {
    const now = opts.now ?? (() => performance.now());
    const openedAt = now();

    let closed = false;
    let latestBatch = 0;
    let batches = 0;
    let refreshes = 0;
    let optionChanges = 0;
    let thumbnailsOffered = 0;
    let thumbnailsLoaded = 0;
    let thumbnailsFailed = 0;
    let offlineDownloadUsed = false;
    let firstThumbnailsMs = -1;
    let firstThumbnailLoadedMs = -1;

    track('new-game-dialog-opened', {
        hasPuzzle: opts.hasPuzzle,
        puzzleCompleted: opts.puzzleCompleted,
        imageCategory: opts.imageCategory,
        vibrant: opts.vibrant,
        picker: opts.picker,
        offlineDownload: opts.offlineDownload,
    });

    return {
        batchStarted(trigger, params) {
            const id = ++latestBatch;
            const startedAt = now();
            batches++;
            if (trigger === 'refresh') refreshes++;

            return ({ candidates, cause, source, draw }) => {
                const settledAt = now();
                let outcome: ImageCandidatesLoadedData['outcome'];
                if (closed) outcome = 'abandoned';
                else if (id !== latestBatch) outcome = 'superseded';
                else if (candidates.length > 0) outcome = 'shown';
                else outcome = cause === 'threw' || cause === 'http-error' ? 'error' : 'empty';

                if (outcome === 'shown') {
                    thumbnailsOffered += candidates.length;
                    if (firstThumbnailsMs === -1) firstThumbnailsMs = Math.round(settledAt - openedAt);
                }

                track('image-candidates-loaded', {
                    trigger,
                    outcome,
                    cause,
                    source,
                    count: candidates.length,
                    ms: Math.round(settledAt - startedAt),
                    imageCategory: params.imageCategory,
                    vibrant: params.vibrant,
                    custom: params.custom,
                    orientation: params.orientation,
                    imagePage: draw?.page ?? 0,
                    imagePagesKnown: draw?.knownPages ?? 0,
                    sourceKind: draw?.sourceKind ?? 'none',
                    topic: draw?.topic ?? '',
                    photoIds: candidates
                        .map((c) => photoIdFromDownloadLocation(c.downloadLocation) ?? '')
                        .join(','),
                });
            };
        },
        optionChanged(setting, from, to) {
            optionChanges++;
            track('image-option-changed', { setting, from, to });
        },
        thumbnailLoaded() {
            thumbnailsLoaded++;
            if (firstThumbnailLoadedMs === -1) firstThumbnailLoadedMs = Math.round(now() - openedAt);
        },
        thumbnailFailed(slot, photoId, imageCategory) {
            thumbnailsFailed++;
            track('image-thumbnail-failed', { slot, photoId, imageCategory });
        },
        creditOpened(photoId) {
            track('photo-credit-opened', { where: 'picker', link: 'photographer', photoId });
        },
        offlineDownloadUsed() {
            offlineDownloadUsed = true;
        },
        closed(outcome, pickedSlot, final) {
            if (closed) return;
            closed = true;
            track('new-game-dialog-closed', {
                outcome,
                openMs: Math.round(now() - openedAt),
                firstThumbnailsMs,
                firstThumbnailLoadedMs,
                pickedSlot,
                refreshes,
                optionChanges,
                batches,
                thumbnailsOffered,
                thumbnailsLoaded,
                thumbnailsFailed,
                offlineDownloadUsed,
                imageCategory: final.imageCategory,
                vibrant: final.vibrant,
            });
        },
    };
}
