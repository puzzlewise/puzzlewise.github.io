import { describe, it, expect } from 'vitest';
import { chooseRenderer } from './start-renderer.js';

describe('chooseRenderer', () => {
    it('chooseRenderer defaults to svg', () => {
        expect(chooseRenderer('')).toBe('svg');
        expect(chooseRenderer('?renderer=svg')).toBe('svg');
        expect(chooseRenderer('?renderer=WebGL')).toBe('svg');
        expect(chooseRenderer('?userid=x')).toBe('svg');
    });

    it('chooseRenderer honours ?renderer=webgl', () => {
        expect(chooseRenderer('?renderer=webgl')).toBe('webgl');
        expect(chooseRenderer('?userid=x&renderer=webgl')).toBe('webgl');
    });
});
