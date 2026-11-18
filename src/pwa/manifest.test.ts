import { describe, it, expect } from 'vitest';
import {
    createManifestConfig,
    validateManifestConfig,
    REQUIRED_ICON_SIZES,
} from './manifest.js';
import type { ManifestConfig } from './manifest.js';

describe('createManifestConfig', () => {
    it('returns a valid manifest config', () => {
        const config = createManifestConfig('/puzzle/');

        expect(config.name).toBe('Puzzlewise');
        expect(config.short_name).toBe('Puzzlewise');
        expect(config.description).toBe('A jigsaw puzzle web app');
    });

    it('sets display to standalone for home screen experience', () => {
        const config = createManifestConfig('/puzzle/');
        expect(config.display).toBe('standalone');
    });

    it('does not set orientation (respects device rotation lock)', () => {
        const config = createManifestConfig('/puzzle/');
        expect(config.orientation).toBeUndefined();
    });

    it('uses the provided base path for scope and start_url', () => {
        const config = createManifestConfig('/puzzle/');
        expect(config.scope).toBe('/puzzle/');
        expect(config.start_url).toBe('/puzzle/');
    });

    it('uses a custom base path', () => {
        const config = createManifestConfig('/my-app/');
        expect(config.scope).toBe('/my-app/');
        expect(config.start_url).toBe('/my-app/');
    });

    it('sets matching theme and background colors', () => {
        const config = createManifestConfig('/puzzle/');
        expect(config.theme_color).toBe('#1a1a2e');
        expect(config.background_color).toBe('#1a1a2e');
    });

    it('includes all required icon sizes', () => {
        const config = createManifestConfig('/puzzle/');
        const sizes = config.icons.map((icon) => icon.sizes);

        for (const requiredSize of REQUIRED_ICON_SIZES) {
            expect(sizes).toContain(requiredSize);
        }
    });

    it('includes a maskable icon', () => {
        const config = createManifestConfig('/puzzle/');
        const hasMaskable = config.icons.some(
            (icon) => icon.purpose === 'maskable',
        );
        expect(hasMaskable).toBe(true);
    });

    it('all icons have type image/png', () => {
        const config = createManifestConfig('/puzzle/');
        for (const icon of config.icons) {
            expect(icon.type).toBe('image/png');
        }
    });
});

describe('validateManifestConfig', () => {
    function validConfig(): ManifestConfig {
        return createManifestConfig('/puzzle/');
    }

    it('returns no errors for a valid config', () => {
        const errors = validateManifestConfig(validConfig());
        expect(errors).toEqual([]);
    });

    it('reports missing name', () => {
        const config = validConfig();
        config.name = '';
        const errors = validateManifestConfig(config);
        expect(errors).toContain('name is required');
    });

    it('reports missing short_name', () => {
        const config = validConfig();
        config.short_name = '';
        const errors = validateManifestConfig(config);
        expect(errors).toContain('short_name is required');
    });

    it('reports invalid display mode', () => {
        const config = validConfig();
        config.display = 'browser';
        const errors = validateManifestConfig(config);
        expect(errors).toContain(
            'display should be "standalone" or "fullscreen" for home screen apps',
        );
    });

    it('accepts fullscreen display mode', () => {
        const config = validConfig();
        config.display = 'fullscreen';
        const errors = validateManifestConfig(config);
        expect(errors).not.toContain(
            'display should be "standalone" or "fullscreen" for home screen apps',
        );
    });

    it('reports missing theme_color', () => {
        const config = validConfig();
        config.theme_color = '';
        const errors = validateManifestConfig(config);
        expect(errors).toContain('theme_color is required');
    });

    it('reports missing background_color', () => {
        const config = validConfig();
        config.background_color = '';
        const errors = validateManifestConfig(config);
        expect(errors).toContain('background_color is required');
    });

    it('reports missing start_url', () => {
        const config = validConfig();
        config.start_url = '';
        const errors = validateManifestConfig(config);
        expect(errors).toContain('start_url is required');
    });

    it('reports missing icons', () => {
        const config = validConfig();
        config.icons = [];
        const errors = validateManifestConfig(config);
        expect(errors).toContain('at least one icon is required');
    });

    it('reports missing required icon sizes', () => {
        const config = validConfig();
        config.icons = [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        ];
        const errors = validateManifestConfig(config);
        expect(errors).toContain('icon size 512x512 is required');
    });

    it('reports missing maskable icon', () => {
        const config = validConfig();
        config.icons = [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ];
        const errors = validateManifestConfig(config);
        expect(errors).toContain(
            'at least one maskable icon is recommended',
        );
    });

    it('can report multiple errors at once', () => {
        const config = validConfig();
        config.name = '';
        config.short_name = '';
        config.icons = [];
        const errors = validateManifestConfig(config);
        expect(errors.length).toBeGreaterThanOrEqual(3);
    });
});

describe('REQUIRED_ICON_SIZES', () => {
    it('includes 192x192 and 512x512', () => {
        expect(REQUIRED_ICON_SIZES).toContain('192x192');
        expect(REQUIRED_ICON_SIZES).toContain('512x512');
    });
});
