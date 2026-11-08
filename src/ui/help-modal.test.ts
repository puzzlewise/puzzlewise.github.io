/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createHelpModal } from './help-modal.js';
import { createSelectToolButton } from './select-tool-button.js';
import { createMarqueeToolButton } from './marquee-tool-button.js';
import { SelectionManager } from '../interaction/selection-manager.js';
import type { GameState } from '../model/types.js';
import { makeGameState } from '../test-helpers/fixtures.js';

function toolbarButtonIcon(
    create: (opts: {
        container: HTMLElement;
        selectionManager: SelectionManager;
    }) => unknown,
): string {
    const host = document.createElement('div');
    create({ container: host, selectionManager: new SelectionManager() });
    return host.querySelector('button')!.querySelector('svg')!.outerHTML;
}

function makeState(overrides?: Partial<GameState>): GameState {
    return makeGameState({
        seed: 12345,
        cutStyle: 'fractal',
        rotationMode: 'quarter-turn',
        fractalConfig: { borderless: true },
        ...overrides,
    });
}

let container: HTMLElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
    }
});

function sectionHeadings(): string[] {
    return [...container.querySelectorAll<HTMLHeadingElement>('.info-section > h3')].map(
        (h) => h.textContent ?? '',
    );
}

describe('createHelpModal', () => {
    it('is titled Help', () => {
        createHelpModal({ container });

        expect(container.querySelector('.info-modal-title')!.textContent).toBe('Help');
    });

    it('holds no settings or debug', () => {
        createHelpModal({ container, state: makeState() });

        expect(container.querySelector('[data-testid="tolerance-options"]')).toBeNull();
        expect(container.querySelector('[data-testid="debug-section"]')).toBeNull();
        expect(container.querySelector('.info-modal-solve-btn')).toBeNull();
    });

    it('renders Credits and About after How to Play', () => {
        createHelpModal({ container });

        expect(sectionHeadings()).toEqual(['How to Play', 'Credits', 'About']);
    });

    it('renders the share section first when there is a game', () => {
        createHelpModal({ container, state: makeState() });

        expect(sectionHeadings()).toEqual(['Share this puzzle', 'How to Play', 'Credits', 'About']);
        const firstSection = container.querySelector<HTMLElement>(
            '.info-modal-content > section.info-section',
        );
        expect(firstSection?.classList.contains('share-section')).toBe(true);
    });

    it('opens without a game', () => {
        expect(() => createHelpModal({ container })).not.toThrow();

        expect(container.querySelector('.share-section')).toBeNull();
    });

    it('does not render a Cut Styles section', () => {
        createHelpModal({ container });

        expect(sectionHeadings()).not.toContain('Cut Styles');
    });
});

describe('createHelpModal — How to Play section', () => {
    function howToPlaySection(): HTMLElement {
        const headings = container.querySelectorAll<HTMLHeadingElement>(
            '.info-section > h3',
        );
        const match = [...headings].find((h) => h.textContent === 'How to Play');
        return match!.parentElement!;
    }

    it('describes rotation', () => {
        createHelpModal({ container });
        expect(howToPlaySection().textContent).toContain('Free rotation');
    });

    it('points to the Settings button', () => {
        createHelpModal({ container });
        const text = howToPlaySection().textContent ?? '';
        expect(text).toContain('⚙️');
        expect(text).toContain('Settings');
    });

    it('does not mention "composable"', () => {
        createHelpModal({ container });
        expect(howToPlaySection().textContent?.toLowerCase()).not.toContain('composable');
    });

    it('documents the Marquee button and its drag-a-box gesture', () => {
        createHelpModal({ container });
        const text = howToPlaySection().textContent ?? '';
        expect(text).toContain('Marquee');
        expect(text).toContain('drag a box');
    });

    it('documents the offline photo download', () => {
        createHelpModal({ container });
        const text = howToPlaySection().textContent ?? '';
        expect(text).toContain('Offline photos');
        expect(text).toContain('no connection');
    });

    it('shows the same multi-select and marquee icons as the toolbar buttons', () => {
        createHelpModal({ container });
        const rendered = [
            ...howToPlaySection().querySelectorAll<SVGElement>('svg.info-inline-icon'),
        ].map((svg) => {
            const clone = svg.cloneNode(true) as SVGElement;
            clone.classList.remove('info-inline-icon');
            clone.removeAttribute('class');
            return clone.outerHTML;
        });
        expect(rendered).toContain(toolbarButtonIcon(createSelectToolButton));
        expect(rendered).toContain(toolbarButtonIcon(createMarqueeToolButton));
    });

    it('mentions Wavy and Classic alongside Free rotation', () => {
        createHelpModal({ container });
        const text = howToPlaySection().textContent ?? '';
        const freeRotIdx = text.indexOf('Free rotation');
        expect(freeRotIdx).toBeGreaterThan(-1);
        const context = text.slice(freeRotIdx, freeRotIdx + 60);
        expect(context).toContain('Classic');
        expect(context).toContain('Wavy');
    });

    it('attributes 90° rotation to Fractal only', () => {
        createHelpModal({ container });
        const text = howToPlaySection().textContent ?? '';
        const ninetyIdx = text.indexOf('90° rotation');
        expect(ninetyIdx).toBeGreaterThan(-1);
        const context = text.slice(ninetyIdx, ninetyIdx + 60);
        expect(context).toContain('Fractal');
        expect(context).not.toContain('Classic');
    });
});

describe('createHelpModal — analytics', () => {
    let umamiTrack: Mock<NonNullable<Window['umami']>['track']>;

    beforeEach(() => {
        umamiTrack = vi.fn();
        window.umami = { track: umamiTrack };
    });

    afterEach(() => {
        delete window.umami;
    });

    it('sends help-modal-opened when the modal opens', () => {
        createHelpModal({ container });

        expect(umamiTrack).toHaveBeenCalledExactlyOnceWith('help-modal-opened', {});
    });

    it('reports view stats without debugOpened when closed', () => {
        createHelpModal({ container });

        container.querySelector<HTMLButtonElement>('.info-modal-close')!.click();

        const sent = umamiTrack.mock.calls.filter(([name]) => name === 'help-modal-closed');
        expect(sent).toEqual([
            [
                'help-modal-closed',
                { closedBy: 'button', openMs: expect.any(Number), seenPercent: 100, scrolled: false },
            ],
        ]);
    });
});
