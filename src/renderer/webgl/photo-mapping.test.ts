import { describe, test, expect } from 'vitest';
import { sliceUv, textureSizeFor } from './photo-mapping.js';

describe('sliceUv', () => {
    test('same aspect → identity mapping', () => {
        const { scale, offset } = sliceUv({ width: 400, height: 300 }, { width: 800, height: 600 });
        expect(scale.x).toBeCloseTo(1);
        expect(scale.y).toBeCloseTo(1);
        expect(offset.x).toBeCloseTo(0);
        expect(offset.y).toBeCloseTo(0);
    });

    test('photo wider than imageSize crops left and right equally (xMid)', () => {
        const { scale, offset } = sliceUv({ width: 400, height: 300 }, { width: 1600, height: 600 });
        expect(scale.x).toBeCloseTo(0.5);
        expect(scale.y).toBeCloseTo(1);
        expect(offset.x).toBeCloseTo(0.25);
        expect(offset.y).toBeCloseTo(0);
    });

    test('photo taller crops top and bottom equally (YMid)', () => {
        const { scale, offset } = sliceUv({ width: 400, height: 300 }, { width: 800, height: 1200 });
        expect(scale.x).toBeCloseTo(1);
        expect(scale.y).toBeCloseTo(0.5);
        expect(offset.x).toBeCloseTo(0);
        expect(offset.y).toBeCloseTo(0.25);
    });
});

describe('textureSizeFor', () => {
    test('keeps aspect and fits 4096', () => {
        expect(textureSizeFor({ width: 8000, height: 6000 }, 4096)).toEqual({ width: 4096, height: 3072 });
        expect(textureSizeFor({ width: 3000, height: 9000 }, 4096)).toEqual({ width: 1365, height: 4096 });
    });

    test('long side is exactly the limit for awkward widths', () => {
        expect(textureSizeFor({ width: 4237, height: 4237 }, 4096)).toEqual({ width: 4096, height: 4096 });
        expect(textureSizeFor({ width: 4430, height: 3000 }, 4096).width).toBe(4096);
        expect(textureSizeFor({ width: 3000, height: 4430 }, 4096).height).toBe(4096);
    });

    test('leaves photos that already fit untouched', () => {
        expect(textureSizeFor({ width: 1000, height: 700 }, 4096)).toEqual({ width: 1000, height: 700 });
    });
});
