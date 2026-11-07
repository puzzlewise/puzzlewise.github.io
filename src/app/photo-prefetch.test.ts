/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefetchPhoto } from './photo-prefetch.js';

describe('prefetchPhoto', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('requests the URL through a no-cors image load', () => {
        const srcSetter = vi.spyOn(HTMLImageElement.prototype, 'src', 'set');
        const crossOriginSetter = vi.spyOn(HTMLImageElement.prototype, 'crossOrigin', 'set');

        prefetchPhoto('https://images.example/photo.jpg');

        expect(srcSetter).toHaveBeenCalledWith('https://images.example/photo.jpg');
        expect(crossOriginSetter).not.toHaveBeenCalled();
    });
});
