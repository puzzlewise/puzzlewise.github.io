import { describe, it, expect } from 'vitest';
import { photoIdFromDownloadLocation } from './photo-id.js';
import { resolveUpstream } from '../worker/image-proxy.js';
import { HOSTILE_DOWNLOAD_LOCATIONS, VALID_DOWNLOAD_LOCATIONS } from '../worker/download-location-samples.js';

describe('photoIdFromDownloadLocation', () => {
    it.each([
        ['https://api.unsplash.com/photos/abc123/download?ixid=x', 'abc123'],
        ['https://api.unsplash.com/photos/_p-nqrlCcyE/download', '_p-nqrlCcyE'],
    ])('reads the id from %s', (url, id) => {
        expect(photoIdFromDownloadLocation(url)).toBe(id);
    });

    it.each([
        undefined,
        '',
        'not a url',
        'https://evil.example/photos/abc/download',
        'https://api.unsplash.com/photos/abc',
    ])('returns undefined for %s', (url) => {
        expect(photoIdFromDownloadLocation(url)).toBeUndefined();
    });
});

describe('agreement with the image proxy', () => {
    // The proxy's check fails loudly (HTTP 400) when Unsplash changes the
    // format; this keeps the client's silent copy from drifting after it.
    it.each([
        ...VALID_DOWNLOAD_LOCATIONS,
        ...HOSTILE_DOWNLOAD_LOCATIONS.map(([, url]) => url),
    ])('accepts %s exactly when the proxy does', (url) => {
        const proxyAccepts = resolveUpstream(
            new URL(`https://proxy.example/download?url=${encodeURIComponent(url)}`),
        ).ok;

        expect(photoIdFromDownloadLocation(url) !== undefined).toBe(proxyAccepts);
    });
});
