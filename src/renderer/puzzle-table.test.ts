/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { isOnPuzzleTable, markPuzzleTable } from './puzzle-table.js';

describe('isOnPuzzleTable', () => {
    it('is true for a marked table and its descendants', () => {
        const table = document.createElement('div');
        markPuzzleTable(table);
        const canvas = document.createElement('canvas');
        table.appendChild(canvas);
        expect(isOnPuzzleTable(table)).toBe(true);
        expect(isOnPuzzleTable(canvas)).toBe(true);
    });

    it('is false outside the table and for non-element targets', () => {
        expect(isOnPuzzleTable(document.createElement('button'))).toBe(false);
        expect(isOnPuzzleTable(window)).toBe(false);
        expect(isOnPuzzleTable(null)).toBe(false);
    });
});
