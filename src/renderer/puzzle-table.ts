export const PUZZLE_TABLE_SELECTOR = '[data-puzzle-table]';

export function markPuzzleTable(table: HTMLElement): void {
    table.dataset.puzzleTable = 'true';
}

export function isOnPuzzleTable(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(PUZZLE_TABLE_SELECTOR) !== null;
}
