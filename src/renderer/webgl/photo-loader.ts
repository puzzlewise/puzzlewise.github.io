export type PhotoOutcome = 'loaded' | 'failed';

interface Settle {
    promise: Promise<PhotoOutcome>;
    resolve(outcome: PhotoOutcome): void;
}

function createSettle(): Settle {
    let resolve!: (outcome: PhotoOutcome) => void;
    const promise = new Promise<PhotoOutcome>((r) => { resolve = r; });
    return { promise, resolve };
}

/**
 * Texture uploads need a CORS-clean image, so every request, prefetches
 * included, is made in `anonymous` mode; a prefetch in another mode would
 * miss the cache.
 */
export class PhotoLoader {
    private readonly onPhoto: (image: HTMLImageElement | null) => void;
    private readonly createImage: () => HTMLImageElement;
    private url: string | null = null;
    private outcome: PhotoOutcome | null = null;
    private settle = createSettle();
    private detach: (() => void) | null = null;
    private prefetched: { url: string; image: HTMLImageElement } | null = null;

    constructor(
        onPhoto: (image: HTMLImageElement | null) => void,
        createImage: () => HTMLImageElement = () => new Image(),
    ) {
        this.onPhoto = onPhoto;
        this.createImage = createImage;
    }

    /** Call once per new game; a blank puzzle (`null`) never settles, as with the SVG renderer. */
    load(url: string | null): void {
        this.settle = createSettle();
        if (url !== null && url === this.url && this.outcome === 'loaded') {
            this.settle.resolve('loaded');
            return;
        }
        this.detach?.();
        this.detach = null;
        this.url = url;
        this.outcome = null;
        this.onPhoto(null);
        if (url === null) return;

        const image = this.takePrefetched(url) ?? this.request(url);
        const settle = this.settle;
        const onLoad = (): void => {
            this.detach?.();
            this.detach = null;
            this.outcome = 'loaded';
            settle.resolve('loaded');
            this.onPhoto(image);
        };
        const onError = (): void => {
            this.detach?.();
            this.detach = null;
            this.outcome = 'failed';
            settle.resolve('failed');
        };
        image.addEventListener('load', onLoad);
        image.addEventListener('error', onError);
        this.detach = () => {
            image.removeEventListener('load', onLoad);
            image.removeEventListener('error', onError);
        };
        if (image.complete && image.naturalWidth > 0) onLoad();
    }

    settled(): Promise<PhotoOutcome> {
        return this.settle.promise;
    }

    prefetch(url: string): void {
        if (url === this.url || url === this.prefetched?.url) return;
        this.prefetched = { url, image: this.request(url) };
    }

    dispose(): void {
        this.detach?.();
        this.detach = null;
        this.prefetched = null;
    }

    private takePrefetched(url: string): HTMLImageElement | null {
        const prefetched = this.prefetched;
        if (prefetched?.url !== url) return null;
        this.prefetched = null;
        const failed = prefetched.image.complete && prefetched.image.naturalWidth === 0;
        return failed ? null : prefetched.image;
    }

    private request(url: string): HTMLImageElement {
        const image = this.createImage();
        image.crossOrigin = 'anonymous';
        image.decoding = 'async';
        image.src = url;
        return image;
    }
}
