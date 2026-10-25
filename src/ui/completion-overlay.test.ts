/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showCompletionOverlay } from './completion-overlay.js';
import type { GameState } from '../model/types.js';
import { makeGameState } from '../test-helpers/fixtures.js';

function makeState(overrides: Partial<GameState> = {}): GameState {
    return makeGameState({
        groups: [
            {
                id: 0,
                pieces: new Map([[0, { x: 0, y: 0 }]]),
                position: { x: 0, y: 0 },
                rotation: 0,
            },
        ],
        imageUrl: null,
        imageSize: { width: 1080, height: 720 },
        gridSize: { cols: 4, rows: 3 },
        completed: true,
        seed: 1,
        cutStyle: 'classic',
        rotationMode: 'none',
        ...overrides,
    });
}

describe('showCompletionOverlay', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.replaceChildren(container);
        // Stub navigator.share so sharePuzzle doesn't hit jsdom's 'no share
        // mechanism' error toast; lets us assert the side-effects we care about.
        vi.stubGlobal('navigator', {
            share: vi.fn().mockResolvedValue(undefined),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        delete window.umami;
    });

    it('appends a .completion-overlay to the container and glows it', () => {
        showCompletionOverlay({ container, state: makeState() });
        expect(container.querySelector('.completion-overlay')).not.toBeNull();
        expect(container.classList.contains('completion-glow')).toBe(true);
    });

    it('renders the heading, well-done line, share button, and dismiss hint', () => {
        showCompletionOverlay({ container, state: makeState() });
        const overlay = container.querySelector('.completion-overlay')!;
        expect(overlay.querySelector('h1')?.textContent).toMatch(/Puzzle Complete/);
        expect(overlay.querySelector('.completion-share-btn')?.textContent)
            .toMatch(/Challenge a friend/);
        expect(overlay.querySelector('.completion-dismiss-hint')?.textContent)
            .toMatch(/dismiss/i);
    });

    it('places the share button before the dismiss hint inside the message', () => {
        showCompletionOverlay({ container, state: makeState() });
        const message = container.querySelector('.completion-message')!;
        const children = Array.from(message.children);
        const shareIdx = children.findIndex(c => c.classList.contains('completion-share-btn'));
        const hintIdx = children.findIndex(c => c.classList.contains('completion-dismiss-hint'));
        expect(shareIdx).toBeGreaterThanOrEqual(0);
        expect(hintIdx).toBeGreaterThan(shareIdx);
    });

    it('returns a hide function that removes the overlay and glow', () => {
        const hide = showCompletionOverlay({ container, state: makeState() });
        expect(container.querySelector('.completion-overlay')).not.toBeNull();
        hide();
        expect(container.querySelector('.completion-overlay')).toBeNull();
        expect(container.classList.contains('completion-glow')).toBe(false);
    });

    it('hide is idempotent', () => {
        const hide = showCompletionOverlay({ container, state: makeState() });
        hide();
        hide();
        expect(container.querySelector('.completion-overlay')).toBeNull();
    });

    it('does NOT fire onDismiss when the caller invokes hide()', () => {
        const onDismiss = vi.fn();
        const hide = showCompletionOverlay({ container, state: makeState(), onDismiss });
        hide();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('clicking the overlay dismisses it and fires onDismiss', () => {
        const onDismiss = vi.fn();
        showCompletionOverlay({ container, state: makeState(), onDismiss });
        const overlay = container.querySelector<HTMLElement>('.completion-overlay')!;
        overlay.click();
        expect(container.querySelector('.completion-overlay')).toBeNull();
        expect(container.classList.contains('completion-glow')).toBe(false);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('Escape dismisses it and fires onDismiss', () => {
        const onDismiss = vi.fn();
        showCompletionOverlay({ container, state: makeState(), onDismiss });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(container.querySelector('.completion-overlay')).toBeNull();
        expect(container.classList.contains('completion-glow')).toBe(false);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('share-button click tracks puzzle-shared with completion-overlay source', () => {
        const trackSpy = vi.fn();
        window.umami = { track: trackSpy };

        showCompletionOverlay({ container, state: makeState() });
        const btn = container.querySelector<HTMLButtonElement>('.completion-share-btn')!;
        btn.click();

        expect(trackSpy).toHaveBeenCalledWith('puzzle-shared', {
            source: 'completion-overlay',
            includesProgress: false,
        });
    });

    it('tracks share-failed when the share flow has no working mechanism', async () => {
        const umamiTrack = vi.fn();
        window.umami = { track: umamiTrack };
        // No native share, no clipboard => onError fires with 'No share mechanism available'.
        vi.stubGlobal('navigator', {});

        showCompletionOverlay({ container, state: makeState() });
        container.querySelector<HTMLButtonElement>('.completion-share-btn')!.click();

        await vi.waitFor(() => {
            expect(umamiTrack).toHaveBeenCalledWith('share-failed', {
                source: 'completion-overlay',
                reason: 'No share mechanism available',
            });
        });
    });

    it('sanitizes a URL-bearing error message before tracking share-failed', async () => {
        const umamiTrack = vi.fn();
        window.umami = { track: umamiTrack };
        // Clipboard write rejects with a URL-bearing message; the call site must
        // run it through sanitizeErrorReason before tracking.
        vi.stubGlobal('navigator', {
            clipboard: {
                writeText: () =>
                    Promise.reject(new Error('copy failed at https://example.com/secret?t=abc')),
            },
        });

        showCompletionOverlay({ container, state: makeState() });
        container.querySelector<HTMLButtonElement>('.completion-share-btn')!.click();

        await vi.waitFor(() => {
            expect(umamiTrack).toHaveBeenCalledWith('share-failed', {
                source: 'completion-overlay',
                reason: 'copy failed at <url>',
            });
        });
    });

    it('builds the share URL on the new site when VITE_MOVED_TO is set', () => {
        vi.stubEnv('VITE_MOVED_TO', 'https://puzzlewise.github.io/');
        const shareSpy = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share: shareSpy });

        showCompletionOverlay({ container, state: makeState() });
        container.querySelector<HTMLButtonElement>('.completion-share-btn')!.click();

        expect(shareSpy.mock.calls[0][0].url).toMatch(/^https:\/\/puzzlewise\.github\.io\/#p=/);
    });

    it('share-button click invokes navigator.share with a share URL and does not dismiss', () => {
        const shareSpy = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share: shareSpy });

        showCompletionOverlay({ container, state: makeState() });
        const btn = container.querySelector<HTMLButtonElement>('.completion-share-btn')!;
        btn.click();

        expect(shareSpy).toHaveBeenCalledTimes(1);
        const arg = shareSpy.mock.calls[0][0];
        expect(arg.url).toMatch(/#p=/);
        expect(arg.title).toBe('Puzzle');
        expect(arg.text).toMatch(/finished this puzzle/);

        // Click on the share button must not bubble up and dismiss the overlay.
        expect(container.querySelector('.completion-overlay')).not.toBeNull();
    });
});
