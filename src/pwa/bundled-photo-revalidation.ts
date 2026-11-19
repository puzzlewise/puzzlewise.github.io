import { BUNDLED_IMAGE_URL, BUNDLED_PORTRAIT_IMAGE_URL } from '../images/bundled-image-urls.js';

export function createBundledPhotoRevalidation(base: string): {
    requestWillFetch: (options: { request: Request }) => Promise<Request>;
} {
    const photoPaths = new Set([
        `${base}${BUNDLED_IMAGE_URL}`,
        `${base}${BUNDLED_PORTRAIT_IMAGE_URL}`,
    ]);
    return {
        requestWillFetch: async ({ request }) => {
            if (!photoPaths.has(new URL(request.url).pathname)) return request;
            // Workbox's `reload` downloads the photo the page has just loaded a
            // second time. Not `default`: Pages serves `max-age=600`, so a
            // pre-deploy copy could be stored under the new revision.
            return new Request(request, { cache: 'no-cache' });
        },
    };
}
