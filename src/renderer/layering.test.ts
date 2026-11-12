import { describe, expect, test } from 'vitest';

const sources = import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
});

describe('renderer layering', () => {
    test('renderer sources import nothing from src/app or src/ui', () => {
        const offending = Object.entries(sources).flatMap(([path, source]) =>
            [...source.matchAll(/from\s+'((?:\.\.\/)+(?:app|ui)\/[^']*)'/g)].map((match) => `${path}: ${match[1]}`));

        expect(Object.keys(sources).length).toBeGreaterThan(10);
        expect(offending).toEqual([]);
    });
});
