import { describe, it, expect } from 'vitest';
import { createBundledPhotoRevalidation } from './bundled-photo-revalidation.js';

const ORIGIN = 'https://puzzlewise.github.io';

describe('createBundledPhotoRevalidation', () => {
    it.each(['first-puzzle.jpg', 'first-puzzle-portrait.jpg'])(
        'revalidates %s',
        async (file) => {
            const request = new Request(`${ORIGIN}/${file}`, { cache: 'reload', credentials: 'same-origin' });
            const result = await createBundledPhotoRevalidation('/').requestWillFetch({ request });
            expect(result.url).toBe(request.url);
            expect(result.cache).toBe('no-cache');
            expect(result.credentials).toBe('same-origin');
        },
    );

    it('matches the photos under a non-root base', async () => {
        const plugin = createBundledPhotoRevalidation('/dev/');
        const inBase = new Request(`${ORIGIN}/dev/first-puzzle.jpg`, { cache: 'reload' });
        const sibling = new Request(`${ORIGIN}/first-puzzle.jpg`, { cache: 'reload' });
        expect((await plugin.requestWillFetch({ request: inBase })).cache).toBe('no-cache');
        expect(await plugin.requestWillFetch({ request: sibling })).toBe(sibling);
    });

    it.each(['index.html', 'manifest.webmanifest', 'puzzle-image.jpg', 'assets/first-puzzle.jpg'])(
        'returns the request for %s untouched',
        async (path) => {
            const request = new Request(`${ORIGIN}/${path}`, { cache: 'reload' });
            expect(await createBundledPhotoRevalidation('/').requestWillFetch({ request })).toBe(request);
        },
    );

    it('accepts a no-cors photo request', async () => {
        const request = new Request(`${ORIGIN}/first-puzzle.jpg`, { mode: 'no-cors' });
        const result = await createBundledPhotoRevalidation('/').requestWillFetch({ request });
        expect(result.cache).toBe('no-cache');
        expect(result.mode).toBe('no-cors');
    });
});
