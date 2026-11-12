import { describe, expect, test } from 'vitest';
import * as shaders from './shaders.js';

describe('shaders', () => {
    test('no shader uses flat varyings (Safari 17 provoking-vertex bug)', () => {
        const sources = Object.entries(shaders).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].startsWith('#version'),
        );
        expect(sources.length).toBeGreaterThan(1);
        for (const [name, source] of sources) {
            expect(source, name).not.toMatch(/\bflat\b/);
        }
    });
});
