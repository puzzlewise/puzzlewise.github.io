import { describe, it, expect } from 'vitest';
import { withAutoFormat } from './unsplash-auto-format.js';

describe('withAutoFormat', () => {
    it('appends to an existing query without touching the other parameters', () => {
        expect(withAutoFormat('https://images.unsplash.com/photo-abc?fm=jpg&ixid=M3w_x-Y&q=80&w=1080'))
            .toBe('https://images.unsplash.com/photo-abc?fm=jpg&ixid=M3w_x-Y&q=80&w=1080&auto=format');
    });

    it('starts a query when the URL has none', () => {
        expect(withAutoFormat('https://images.unsplash.com/photo-abc'))
            .toBe('https://images.unsplash.com/photo-abc?auto=format');
    });
});
