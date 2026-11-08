/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildShareSection } from './share-section.js';
import type { GameState } from '../model/types.js';
import { makeGameState } from '../test-helpers/fixtures.js';

function state(overrides: Partial<GameState> = {}): GameState {
    return makeGameState({
        groups: [
            { id: 0, pieces: new Map([[0, { x: 0, y: 0 }]]),
              position: { x: 0, y: 0 }, rotation: 0 },
        ],
        imageUrl: null,
        imageSize: { width: 1080, height: 720 },
        gridSize: { cols: 4, rows: 3 },
        seed: 1,
        cutStyle: 'classic',
        rotationMode: 'none',
        ...overrides,
    });
}

describe('buildShareSection', () => {
    let host: HTMLElement;
    beforeEach(() => {
        host = document.createElement('div');
        document.body.replaceChildren(host);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete window.umami;
    });

    it('renders a heading, checkbox, primary button, and URL preview', () => {
        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        expect(host.querySelector('h3')?.textContent).toBe('Share this puzzle');
        expect(host.querySelector<HTMLInputElement>('[data-testid="share-include-progress"]')).not.toBeNull();
        expect(host.querySelector<HTMLButtonElement>('[data-testid="share-primary-btn"]')).not.toBeNull();
        expect(host.querySelector<HTMLElement>('[data-testid="share-url-preview"]')).not.toBeNull();
    });

    it('renders the URL preview as a single-line readonly input with the URL as its value', () => {
        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        const preview = host.querySelector<HTMLInputElement>('[data-testid="share-url-preview"]')!;
        expect(preview.tagName.toLowerCase()).toBe('input');
        expect(preview.type).toBe('text');
        expect(preview.readOnly).toBe(true);
        expect(preview.value).toMatch(/^https:\/\/example\.com\/#p=/);
    });

    it('selects the full URL when the preview input receives focus', () => {
        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        const preview = host.querySelector<HTMLInputElement>('[data-testid="share-url-preview"]')!;
        document.body.appendChild(preview);
        preview.focus();
        expect(preview.selectionStart).toBe(0);
        expect(preview.selectionEnd).toBe(preview.value.length);
    });

    it('disables the progress checkbox when no pieces are merged', () => {
        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        const cb = host.querySelector<HTMLInputElement>('[data-testid="share-include-progress"]')!;
        expect(cb.disabled).toBe(true);
        expect(host.querySelector('[data-testid="share-progress-hint"]')?.textContent)
            .toMatch(/Make some progress/i);
    });

    it('disables the progress checkbox when the puzzle is complete', () => {
        const s = state({ completed: true });
        host.appendChild(buildShareSection(s, 'https://example.com/'));
        const cb = host.querySelector<HTMLInputElement>('[data-testid="share-include-progress"]')!;
        expect(cb.disabled).toBe(true);
        expect(host.querySelector('[data-testid="share-progress-hint"]')?.textContent)
            .toMatch(/already complete/i);
    });

    it('enables the checkbox when there is progress', () => {
        const s = state({
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
                { id: 2, pieces: new Map([[2, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        host.appendChild(buildShareSection(s, 'https://example.com/'));
        const cb = host.querySelector<HTMLInputElement>('[data-testid="share-include-progress"]')!;
        expect(cb.disabled).toBe(false);
    });

    it('updates the URL preview when the checkbox toggles', () => {
        const s = state({
            groups: [
                { id: 0, pieces: new Map([[0, { x: 0, y: 0 }], [1, { x: 0, y: 0 }]]),
                  position: { x: 0, y: 0 }, rotation: 0 },
            ],
        });
        host.appendChild(buildShareSection(s, 'https://example.com/'));
        const preview = host.querySelector<HTMLInputElement>('[data-testid="share-url-preview"]')!;
        const urlBefore = preview.value;

        const cb = host.querySelector<HTMLInputElement>('[data-testid="share-include-progress"]')!;
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));

        const urlAfter = preview.value;
        expect(urlAfter).not.toBe(urlBefore);
        expect(urlAfter.length).toBeGreaterThan(urlBefore.length);
    });

    it('tracks share-failed when the share flow has no working mechanism', async () => {
        const umamiTrack = vi.fn();
        window.umami = { track: umamiTrack };
        // No native share, no clipboard => onError fires with 'No share mechanism available'.
        vi.stubGlobal('navigator', {});

        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        host.querySelector<HTMLButtonElement>('[data-testid="share-primary-btn"]')!.click();

        await vi.waitFor(() => {
            expect(umamiTrack).toHaveBeenCalledWith('share-failed', {
                source: 'help-modal',
                reason: 'No share mechanism available',
            });
        });
    });

    it('sanitizes a URL-bearing error message before tracking share-failed', async () => {
        const umamiTrack = vi.fn();
        window.umami = { track: umamiTrack };
        // No native share; clipboard write rejects with a URL-bearing message.
        // The call site must run it through sanitizeErrorReason before tracking.
        vi.stubGlobal('navigator', {
            clipboard: {
                writeText: () =>
                    Promise.reject(new Error('copy failed at https://example.com/secret?t=abc')),
            },
        });

        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        host.querySelector<HTMLButtonElement>('[data-testid="share-primary-btn"]')!.click();

        await vi.waitFor(() => {
            expect(umamiTrack).toHaveBeenCalledWith('share-failed', {
                source: 'help-modal',
                reason: 'copy failed at <url>',
            });
        });
    });

    it('primary button label is "Share…" when navigator.share is available', () => {
        vi.stubGlobal('navigator', { share: () => {} });
        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        expect(host.querySelector<HTMLButtonElement>('[data-testid="share-primary-btn"]')!.textContent)
            .toMatch(/Share/);
    });

    it('primary button label is "Copy link" when navigator.share is unavailable', () => {
        vi.stubGlobal('navigator', {});
        host.appendChild(buildShareSection(state(), 'https://example.com/'));
        expect(host.querySelector<HTMLButtonElement>('[data-testid="share-primary-btn"]')!.textContent)
            .toBe('Copy link');
    });
});
