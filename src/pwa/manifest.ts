/** Extracted so it can be unit-tested and imported by vite.config.ts. */

export interface ManifestIcon {
    src: string;
    sizes: string;
    type: string;
    purpose?: string;
}

export interface ManifestConfig {
    name: string;
    short_name: string;
    description: string;
    theme_color: string;
    background_color: string;
    display: string;
    orientation?: string;
    scope: string;
    start_url: string;
    icons: ManifestIcon[];
}

/** 192×192 and 512×512 are the minimum a valid PWA manifest requires. */
export const REQUIRED_ICON_SIZES = ['192x192', '512x512'];

export function createManifestConfig(basePath: string): ManifestConfig {
    return {
        name: 'Puzzlewise',
        short_name: 'Puzzlewise',
        description: 'A jigsaw puzzle web app',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',

        scope: basePath,
        start_url: basePath,
        icons: [
            {
                src: 'icon-192.png',
                sizes: '192x192',
                type: 'image/png',
            },
            {
                src: 'icon-512.png',
                sizes: '512x512',
                type: 'image/png',
            },
            {
                src: 'icon-512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
            },
        ],
    };
}

export function validateManifestConfig(config: ManifestConfig): string[] {
    const errors: string[] = [];

    if (!config.name) {
        errors.push('name is required');
    }

    if (!config.short_name) {
        errors.push('short_name is required');
    }

    if (config.display !== 'standalone' && config.display !== 'fullscreen') {
        errors.push(
            'display should be "standalone" or "fullscreen" for home screen apps',
        );
    }

    if (!config.theme_color) {
        errors.push('theme_color is required');
    }

    if (!config.background_color) {
        errors.push('background_color is required');
    }

    if (!config.start_url) {
        errors.push('start_url is required');
    }

    if (!config.icons || config.icons.length === 0) {
        errors.push('at least one icon is required');
    } else {
        const iconSizes = config.icons.map((icon) => icon.sizes);
        for (const size of REQUIRED_ICON_SIZES) {
            if (!iconSizes.includes(size)) {
                errors.push(`icon size ${size} is required`);
            }
        }

        const hasMaskable = config.icons.some(
            (icon) => icon.purpose === 'maskable',
        );
        if (!hasMaskable) {
            errors.push('at least one maskable icon is recommended');
        }
    }

    return errors;
}
