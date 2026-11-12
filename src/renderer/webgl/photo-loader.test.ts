/**
 * @vitest-environment jsdom
 */

import { describe, expect, test, vi } from 'vitest';
import { PhotoLoader } from './photo-loader.js';

function setup() {
    const images: HTMLImageElement[] = [];
    const onPhoto = vi.fn<(image: HTMLImageElement | null) => void>();
    const loader = new PhotoLoader(onPhoto, () => {
        const image = new Image();
        images.push(image);
        return image;
    });
    return { images, onPhoto, loader };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
    const marker = Symbol('pending');
    return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
}

describe('PhotoLoader', () => {
    test("loads in CORS mode and settles 'loaded' with the image on load", async () => {
        const { images, onPhoto, loader } = setup();
        loader.load('https://example.test/a.jpg');

        expect(images).toHaveLength(1);
        expect(images[0].crossOrigin).toBe('anonymous');
        expect(images[0].src).toBe('https://example.test/a.jpg');
        images[0].dispatchEvent(new Event('load'));

        await expect(loader.settled()).resolves.toBe('loaded');
        expect(onPhoto).toHaveBeenLastCalledWith(images[0]);
    });

    test("settles 'failed' on error", async () => {
        const { images, loader } = setup();
        loader.load('a.jpg');
        images[0].dispatchEvent(new Event('error'));

        await expect(loader.settled()).resolves.toBe('failed');
    });

    test("a new game with the same loaded photo settles 'loaded' again without reloading", async () => {
        const { images, onPhoto, loader } = setup();
        loader.load('a.jpg');
        images[0].dispatchEvent(new Event('load'));
        const calls = onPhoto.mock.calls.length;

        loader.load('a.jpg');

        await expect(loader.settled()).resolves.toBe('loaded');
        expect(images).toHaveLength(1);
        expect(onPhoto.mock.calls.length).toBe(calls);
    });

    test('a new game with the same photo retries it after a failure', async () => {
        const { images, loader } = setup();
        loader.load('a.jpg');
        images[0].dispatchEvent(new Event('error'));

        loader.load('a.jpg');
        expect(images).toHaveLength(2);
        images[1].dispatchEvent(new Event('load'));

        await expect(loader.settled()).resolves.toBe('loaded');
    });

    test("a different photo starts a new settle, clears the old photo and ignores the old image's late load", async () => {
        const { images, onPhoto, loader } = setup();
        loader.load('a.jpg');
        const first = loader.settled();

        loader.load('b.jpg');
        expect(onPhoto).toHaveBeenLastCalledWith(null);
        images[0].dispatchEvent(new Event('load'));
        images[1].dispatchEvent(new Event('error'));

        await expect(loader.settled()).resolves.toBe('failed');
        expect(onPhoto).not.toHaveBeenCalledWith(images[0]);
        expect(await isPending(first)).toBe(true);
    });

    test('a blank puzzle clears the photo and never settles, like the SVG renderer', async () => {
        const { images, onPhoto, loader } = setup();
        loader.load('a.jpg');
        images[0].dispatchEvent(new Event('load'));

        loader.load(null);

        expect(onPhoto).toHaveBeenLastCalledWith(null);
        expect(await isPending(loader.settled())).toBe(true);
    });

    test('prefetch requests in the same CORS mode, and loading that photo reuses the request', async () => {
        const { images, onPhoto, loader } = setup();
        loader.prefetch('a.jpg');
        expect(images).toHaveLength(1);
        expect(images[0].crossOrigin).toBe('anonymous');

        loader.load('a.jpg');
        expect(images).toHaveLength(1);
        images[0].dispatchEvent(new Event('load'));

        await expect(loader.settled()).resolves.toBe('loaded');
        expect(onPhoto).toHaveBeenLastCalledWith(images[0]);
    });

    test('dispose ignores a load that arrives later', () => {
        const { images, onPhoto, loader } = setup();
        loader.load('a.jpg');
        loader.dispose();
        onPhoto.mockClear();

        images[0].dispatchEvent(new Event('load'));

        expect(onPhoto).not.toHaveBeenCalled();
    });
});
