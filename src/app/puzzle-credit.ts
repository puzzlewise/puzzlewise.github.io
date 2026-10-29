import { track } from '../analytics/index.js';

export function reportPuzzleCreditOpened(link: 'photographer' | 'photo', photoId: string | undefined): void {
    track('photo-credit-opened', { where: 'puzzle', link, photoId: photoId ?? '' });
}
