/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createImagePicker } from './image-picker.js';
import type { CandidateFetchResult, CandidateImage } from '../images/index.js';

function ok(candidates: CandidateImage[]): CandidateFetchResult {
    return { candidates, cause: 'none', source: 'unsplash' };
}

const FAILED: CandidateFetchResult = { candidates: [], cause: 'http-error', source: 'none' };

function makeCandidate(n: number): CandidateImage {
    return {
        imageUrl: `https://images.unsplash.com/photo-${n}?w=1080`,
        thumbUrl: `https://images.unsplash.com/photo-${n}?w=400`,
        imageSize: { width: 1080, height: 720 },
        attribution: {
            photographerName: `Photographer ${n}`,
            photographerUrl: `https://unsplash.com/@p${n}`,
            photoUrl: `https://unsplash.com/photos/${n}`,
        },
        downloadLocation: `https://api.unsplash.com/photos/${n}/download`,
        description: `photo ${n}`,
    };
}

/** Flush pending microtasks so a resolved fetch promise applies. */
async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('createImagePicker', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it("passes 'open' on the first load and 'refresh' for ↻", async () => {
        const fetchCandidates = vi.fn().mockResolvedValue(ok([makeCandidate(1)]));
        const picker = createImagePicker({ fetchCandidates, onPick: vi.fn() });
        container.appendChild(picker.element);
        await flush();

        container.querySelector<HTMLButtonElement>('[data-testid="image-picker-refresh"]')!.click();

        expect(fetchCandidates.mock.calls.map(([trigger]) => trigger)).toEqual(['open', 'refresh']);
    });

    it('reports the picked tile slot', async () => {
        const onPick = vi.fn();
        const candidates = [1, 2, 3].map(makeCandidate);
        const picker = createImagePicker({ fetchCandidates: vi.fn().mockResolvedValue(ok(candidates)), onPick });
        container.appendChild(picker.element);
        await flush();

        container.querySelectorAll<HTMLButtonElement>('[data-testid="image-picker-tile"]')[2].click();

        expect(onPick).toHaveBeenCalledWith({ kind: 'photo', photo: candidates[2], slot: 2 });
    });

    it('reports thumbnail loads and errors by slot', async () => {
        const onThumbnailLoad = vi.fn();
        const onThumbnailError = vi.fn();
        const candidates = [1, 2].map(makeCandidate);
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockResolvedValue(ok(candidates)),
            onPick: vi.fn(),
            onThumbnailLoad,
            onThumbnailError,
        });
        container.appendChild(picker.element);
        await flush();

        const thumbs = container.querySelectorAll<HTMLImageElement>('.image-picker-thumb');
        thumbs[0].dispatchEvent(new Event('load'));
        thumbs[1].dispatchEvent(new Event('error'));

        expect(onThumbnailLoad).toHaveBeenCalledWith(0);
        expect(onThumbnailError).toHaveBeenCalledWith(1, candidates[1]);
    });

    it('reports a credit tap without preventing navigation', async () => {
        const onCreditOpen = vi.fn();
        const candidates = [makeCandidate(1)];
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockResolvedValue(ok(candidates)),
            onPick: vi.fn(),
            onCreditOpen,
        });
        container.appendChild(picker.element);
        await flush();

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        container.querySelector<HTMLAnchorElement>('[data-testid="image-picker-credit"]')!.dispatchEvent(event);

        expect(onCreditOpen).toHaveBeenCalledWith(candidates[0]);
        expect(event.defaultPrevented).toBe(false);
    });

    it('renders heading, four tiles, refresh, and both action buttons', () => {
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockResolvedValue(ok([])),
            onPick: vi.fn(),
        });
        container.appendChild(picker.element);

        expect(container.querySelector('.size-picker-subtitle')?.textContent)
            .toBe('Pick an image to start');
        expect(container.querySelectorAll('[data-testid="image-picker-tile"]')).toHaveLength(4);
        expect(container.querySelector('[data-testid="image-picker-refresh"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="image-picker-surprise"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="image-picker-blank"]')).not.toBeNull();
    });

    it('fetches candidates on creation and shows loading tiles meanwhile', () => {
        const fetchCandidates = vi.fn().mockReturnValue(new Promise(() => {}));
        const picker = createImagePicker({ fetchCandidates, onPick: vi.fn() });
        container.appendChild(picker.element);

        expect(fetchCandidates).toHaveBeenCalledOnce();
        const tiles = container.querySelectorAll<HTMLButtonElement>('[data-testid="image-picker-tile"]');
        for (const tile of tiles) {
            expect(tile.disabled).toBe(true);
            expect(tile.classList.contains('image-picker-tile--loading')).toBe(true);
        }
    });

    it('renders thumbnails and enables tiles once candidates arrive', async () => {
        const candidates = [1, 2, 3, 4].map(makeCandidate);
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockResolvedValue(ok(candidates)),
            onPick: vi.fn(),
        });
        container.appendChild(picker.element);
        await flush();

        const imgs = container.querySelectorAll<HTMLImageElement>('.image-picker-thumb');
        expect(imgs).toHaveLength(4);
        expect(imgs[0].src).toBe('https://images.unsplash.com/photo-1?w=400');
        expect(imgs[0].alt).toBe('photo 1');
        const tiles = container.querySelectorAll<HTMLButtonElement>('[data-testid="image-picker-tile"]');
        expect(tiles[0].disabled).toBe(false);
    });

    it('hides surplus tiles when fewer candidates than tiles arrive', async () => {
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockResolvedValue(ok([makeCandidate(1), makeCandidate(2)])),
            onPick: vi.fn(),
        });
        container.appendChild(picker.element);
        await flush();

        // Hidden-slot logic lives on the cell wrapper, not the tile button.
        const cells = container.querySelectorAll<HTMLElement>('.image-picker-cell');
        expect(cells[1].hidden).toBe(false);
        expect(cells[2].hidden).toBe(true);
        expect(cells[3].hidden).toBe(true);
    });

    it('reports a photo pick with the full candidate', async () => {
        const onPick = vi.fn();
        const candidates = [1, 2, 3, 4].map(makeCandidate);
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockResolvedValue(ok(candidates)),
            onPick,
        });
        container.appendChild(picker.element);
        await flush();

        container.querySelectorAll<HTMLButtonElement>('[data-testid="image-picker-tile"]')[2].click();

        expect(onPick).toHaveBeenCalledWith({ kind: 'photo', photo: candidates[2], slot: 2 });
    });

    it('reports surprise and blank picks without any fetch dependency', () => {
        const onPick = vi.fn();
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockReturnValue(new Promise(() => {})),
            onPick,
        });
        container.appendChild(picker.element);

        container.querySelector<HTMLButtonElement>('[data-testid="image-picker-surprise"]')!.click();
        expect(onPick).toHaveBeenCalledWith({ kind: 'surprise' });

        container.querySelector<HTMLButtonElement>('[data-testid="image-picker-blank"]')!.click();
        expect(onPick).toHaveBeenCalledWith({ kind: 'blank' });
    });

    it('shows the error message when the fetch returns no candidates and retries on refresh', async () => {
        const fetchCandidates = vi.fn()
            .mockResolvedValueOnce(FAILED)
            .mockResolvedValueOnce(ok([1, 2, 3, 4].map(makeCandidate)));
        const picker = createImagePicker({ fetchCandidates, onPick: vi.fn() });
        container.appendChild(picker.element);
        await flush();

        const error = container.querySelector<HTMLElement>('.image-picker-error')!;
        expect(error.hidden).toBe(false);

        container.querySelector<HTMLButtonElement>('[data-testid="image-picker-refresh"]')!.click();
        await flush();

        expect(error.hidden).toBe(true);
        expect(container.querySelectorAll('.image-picker-thumb')).toHaveLength(4);
    });

    it('shows the error message when the fetch rejects', async () => {
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockRejectedValue(new Error('boom')),
            onPick: vi.fn(),
        });
        container.appendChild(picker.element);
        await flush();

        expect(container.querySelector<HTMLElement>('.image-picker-error')!.hidden).toBe(false);
    });

    it('ignores a stale response that resolves after a newer refresh', async () => {
        let resolveFirst!: (v: CandidateFetchResult) => void;
        const first = new Promise<CandidateFetchResult>((r) => { resolveFirst = r; });
        const second = [1, 2, 3, 4].map(makeCandidate);
        const fetchCandidates = vi.fn()
            .mockReturnValueOnce(first)
            .mockResolvedValueOnce(ok(second));

        const picker = createImagePicker({ fetchCandidates, onPick: vi.fn() });
        container.appendChild(picker.element);

        container.querySelector<HTMLButtonElement>('[data-testid="image-picker-refresh"]')!.click();
        await flush();
        expect(container.querySelectorAll('.image-picker-thumb')).toHaveLength(4);

        // The stale first fetch finally resolves with different (old) data —
        // it must not clobber the newer result.
        resolveFirst(ok([makeCandidate(9)]));
        await flush();

        const imgs = container.querySelectorAll<HTMLImageElement>('.image-picker-thumb');
        expect(imgs).toHaveLength(4);
        expect(imgs[0].src).toBe('https://images.unsplash.com/photo-1?w=400');
    });

    it('hides the grid and refresh button when no fetchCandidates is provided', () => {
        const picker = createImagePicker({ onPick: vi.fn() });
        container.appendChild(picker.element);

        expect(container.querySelector<HTMLElement>('.image-picker-grid')!.hidden).toBe(true);
        expect(container.querySelector<HTMLElement>('[data-testid="image-picker-refresh"]')!.hidden).toBe(true);
        expect(container.querySelector('[data-testid="image-picker-surprise"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="image-picker-blank"]')).not.toBeNull();
    });

    it('marks the error message as an aria-live region', () => {
        const picker = createImagePicker({
            fetchCandidates: vi.fn().mockResolvedValue(ok([])),
            onPick: vi.fn(),
        });
        container.appendChild(picker.element);

        const error = container.querySelector<HTMLElement>('.image-picker-error')!;
        expect(error.getAttribute('aria-live')).toBe('polite');
    });

    describe('photographer credits', () => {
        function credits(root: HTMLElement): HTMLAnchorElement[] {
            return Array.from(
                root.querySelectorAll<HTMLAnchorElement>('[data-testid="image-picker-credit"]'),
            );
        }

        it('shows a linked credit for each candidate once loaded', async () => {
            const candidates = [1, 2, 3, 4].map(makeCandidate);
            const picker = createImagePicker({
                fetchCandidates: vi.fn().mockResolvedValue(ok(candidates)),
                onPick: vi.fn(),
            });
            container.appendChild(picker.element);
            await flush();

            const links = credits(container);
            expect(links).toHaveLength(4);
            links.forEach((credit, i) => {
                expect(credit.hidden).toBe(false);
                expect(credit.textContent).toBe(`Photographer ${i + 1}`);
                expect(credit.href).toBe(candidates[i].attribution.photographerUrl);
                // A link inside a button is invalid HTML — the credit must be a
                // sibling of the tile, not a descendant.
                expect(credit.closest('button')).toBeNull();
            });
        });

        it('does not fire onPick when a credit is clicked', async () => {
            const onPick = vi.fn();
            const candidates = [1, 2, 3, 4].map(makeCandidate);
            const picker = createImagePicker({
                fetchCandidates: vi.fn().mockResolvedValue(ok(candidates)),
                onPick,
            });
            container.appendChild(picker.element);
            await flush();

            const credit = credits(container)[0];
            // jsdom logs "Not implemented: navigation" for anchor clicks with an
            // href; swallow it in the capture phase to keep test output clean.
            const stopNav = (e: Event) => e.preventDefault();
            document.addEventListener('click', stopNav, true);
            credit.click();
            document.removeEventListener('click', stopNav, true);

            expect(onPick).not.toHaveBeenCalled();
        });

        it('drops a non-http(s) credit href but still shows the name', async () => {
            const candidate = makeCandidate(1);
            candidate.attribution.photographerUrl = 'javascript:alert(1)';
            const picker = createImagePicker({
                fetchCandidates: vi.fn().mockResolvedValue(ok([candidate])),
                onPick: vi.fn(),
            });
            container.appendChild(picker.element);
            await flush();

            const credit = credits(container)[0];
            expect(credit.getAttribute('href')).toBeNull();
            expect(credit.hidden).toBe(false);
            expect(credit.textContent).toBe('Photographer 1');
        });

        it('hides credits while loading', () => {
            const fetchCandidates = vi.fn().mockReturnValue(new Promise(() => {}));
            const picker = createImagePicker({ fetchCandidates, onPick: vi.fn() });
            container.appendChild(picker.element);

            for (const credit of credits(container)) {
                expect(credit.hidden).toBe(true);
            }
        });

        it('hides credits after an error', async () => {
            const picker = createImagePicker({
                fetchCandidates: vi.fn().mockRejectedValue(new Error('boom')),
                onPick: vi.fn(),
            });
            container.appendChild(picker.element);
            await flush();

            for (const credit of credits(container)) {
                expect(credit.hidden).toBe(true);
            }
        });
    });
});
