import { describe, it, expect } from 'vitest';
import { selectPoolRecord, resolveFromPool, type BackupPoolRecord } from './backup-pool.js';
import poolJson from './backup-pool.json';
import { IMAGE_CATEGORY_OPTIONS } from '../game/image-categories.js';
import { isBlockedPhotographerUrl } from './blocked-photographers.js';

function rec(over: Partial<BackupPoolRecord>): BackupPoolRecord {
    return {
        id: 'id',
        category: 'nature',
        vibrant: false,
        orientation: 'landscape',
        imageUrl: 'https://images.unsplash.com/photo-1',
        width: 2000,
        height: 1000,
        photographerName: 'Ada',
        photographerUrl: 'https://u.example/ada',
        photoUrl: 'https://p.example/1',
        thumbUrl: 'https://images.unsplash.com/photo-1?w=400',
        downloadLocation: 'https://api.unsplash.com/photos/1/download',
        ...over,
    };
}

describe('selectPoolRecord', () => {
    it('filters by category, vibrant and orientation', () => {
        const records = [
            rec({ id: 'want', category: 'nature', vibrant: true, orientation: 'portrait' }),
            rec({ id: 'wrong-cat', category: 'food', vibrant: true, orientation: 'portrait' }),
            rec({ id: 'wrong-vibrant', category: 'nature', vibrant: false, orientation: 'portrait' }),
            rec({ id: 'wrong-orient', category: 'nature', vibrant: true, orientation: 'landscape' }),
        ];
        const picked = selectPoolRecord(records, 'nature', true, 'portrait', () => 0);
        expect(picked?.id).toBe('want');
    });

    it("treats 'any' as a union across categories, still honoring vibrant + orientation", () => {
        const records = [
            rec({ id: 'a', category: 'nature', vibrant: false, orientation: 'landscape' }),
            rec({ id: 'b', category: 'food', vibrant: false, orientation: 'landscape' }),
            rec({ id: 'skip-vibrant', category: 'food', vibrant: true, orientation: 'landscape' }),
        ];
        expect(selectPoolRecord(records, 'any', false, 'landscape', () => 0)?.id).toBe('a');
        expect(selectPoolRecord(records, 'any', false, 'landscape', () => 0.99)?.id).toBe('b');
    });

    it('returns null when no record matches the bucket', () => {
        const records = [rec({ category: 'nature', vibrant: false, orientation: 'landscape' })];
        expect(selectPoolRecord(records, 'astronomy', false, 'landscape')).toBeNull();
    });

    it('returns null when an out-of-contract random() lands past the last match', () => {
        const records = [rec({ category: 'nature', vibrant: false, orientation: 'landscape' })];
        expect(selectPoolRecord(records, 'nature', false, 'landscape', () => 1)).toBeNull();
    });
});

describe('backup-pool.json catalog', () => {
    const catalog = poolJson as unknown as BackupPoolRecord[];
    const categories = IMAGE_CATEGORY_OPTIONS.filter((c) => c.id !== 'any').map((c) => c.id);

    it('has at least one record in every (category × vibrant × orientation) bucket', () => {
        const missing: string[] = [];
        for (const category of categories) {
            for (const vibrant of [false, true]) {
                for (const orientation of ['landscape', 'portrait'] as const) {
                    const count = catalog.filter((r) =>
                        r.category === category && r.vibrant === vibrant && r.orientation === orientation,
                    ).length;
                    if (count === 0) missing.push(`${category}|${vibrant}|${orientation}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('every record carries the fields the display path reads', () => {
        for (const r of catalog) {
            expect(typeof r.imageUrl).toBe('string');
            expect(typeof r.width).toBe('number');
            expect(typeof r.height).toBe('number');
            expect(typeof r.downloadLocation).toBe('string');
            expect(typeof r.photographerName).toBe('string');
            expect(typeof r.photographerUrl).toBe('string');
            expect(typeof r.photoUrl).toBe('string');
        }
    });

    it('has unique ids', () => {
        const ids = catalog.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every record is in a valid (category, vibrant, orientation) domain', () => {
        const validCategories = new Set(categories);
        for (const r of catalog) {
            expect(validCategories.has(r.category)).toBe(true);
            expect(['landscape', 'portrait']).toContain(r.orientation);
            expect(typeof r.vibrant).toBe('boolean');
        }
    });

    // Guards a bad re-harvest: an off-domain URL would pass the shape checks
    // above but render a transparent piece (CSP img-src) or fail the Worker's
    // /download origin check at runtime, silently — catch it at CI instead.
    it('hotlinks only https unsplash hosts', () => {
        for (const r of catalog) {
            for (const url of [r.imageUrl, r.thumbUrl]) {
                const parsed = new URL(url);
                expect(parsed.protocol).toBe('https:');
                expect(parsed.host).toBe('images.unsplash.com');
            }
            const download = new URL(r.downloadLocation);
            expect(download.protocol).toBe('https:');
            expect(download.host).toBe('api.unsplash.com');
        }
    });

    it('requests every photo in a negotiated format', () => {
        const jpegOnly = catalog.filter((r) =>
            [r.imageUrl, r.thumbUrl].some((url) => new URL(url).searchParams.get('auto') !== 'format'),
        );
        expect(jpegOnly.map((r) => r.id)).toEqual([]);
    });

    it('contains no photos by blocked photographers', () => {
        const blocked = catalog.filter((r) =>
            isBlockedPhotographerUrl(r.photographerUrl),
        );
        expect(blocked.map((r) => r.id)).toEqual([]);
    });

    it('resolveFromPool maps a real catalog record to a DisplayImage', () => {
        const image = resolveFromPool('nature', false, 'landscape');
        expect(image).not.toBeNull();
        expect(typeof image?.imageUrl).toBe('string');
        expect(image?.imageSize.width).toBe(1080);
        expect(typeof image?.imageSize.height).toBe('number');
        expect(typeof image?.attribution.photographerName).toBe('string');
        expect(typeof image?.attribution.photographerUrl).toBe('string');
        expect(typeof image?.attribution.photoUrl).toBe('string');
        expect(typeof image?.downloadLocation).toBe('string');
    });
});
