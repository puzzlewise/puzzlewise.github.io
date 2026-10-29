/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { moveSourceOrigin } from './move-config.js';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('moveSourceOrigin', () => {
    it('defaults to the legacy origin', () => {
        vi.stubEnv('VITE_MOVED_FROM', '');
        expect(moveSourceOrigin()).toBe('https://adrianschmidt.github.io');
    });

    it('reduces an override to its origin', () => {
        vi.stubEnv('VITE_MOVED_FROM', 'http://localhost:5173/puzzle/');
        expect(moveSourceOrigin()).toBe('http://localhost:5173');
    });
});
