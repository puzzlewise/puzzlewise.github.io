/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createInfoModal } from './info-modal.js';
import { createSelectToolButton } from './select-tool-button.js';
import { createMarqueeToolButton } from './marquee-tool-button.js';
import { SelectionManager } from '../interaction/selection-manager.js';
import type { GameState } from '../model/types.js';
import { makeGameState } from '../test-helpers/fixtures.js';
import { DISTINCT_ID_KEY } from '../analytics/distinct-id.js';

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

afterEach(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
});

describe('createInfoModal', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        localStorage.clear();
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        document.documentElement.className = '';
    });

    it('wraps debug content in a <details> element that is collapsed by default', () => {
        createInfoModal({ container });

        const debug = container.querySelector<HTMLDetailsElement>(
            '[data-testid="debug-section"]',
        );
        expect(debug?.tagName.toLowerCase()).toBe('details');
        expect(debug?.open).toBe(false);
    });

    it('renders repro params as JSON inside the debug section', () => {
        createInfoModal({ container, getState: () => makeState() });

        const repro = container.querySelector<HTMLElement>(
            '[data-testid="repro-params"]',
        );
        expect(repro).not.toBeNull();

        const parsed = JSON.parse(repro!.textContent ?? '{}');
        expect(parsed).toEqual({
            seed: 12345,
            cutStyle: 'fractal',
            imageUrl: 'test.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            rotationMode: 'quarter-turn',
            fractalConfig: { borderless: true },
        });
    });

    it('hides the repro block when no state source is provided', () => {
        createInfoModal({ container });

        const setting = container.querySelector<HTMLElement>(
            '[data-testid="repro-params-setting"]',
        );
        expect(setting?.style.display).toBe('none');
    });

    it('omits undefined state fields from the repro block', () => {
        createInfoModal({
            container,
            getState: () =>
                makeState({
                    fractalConfig: undefined,
                    rotationMode: undefined,
                }),
        });

        const repro = container.querySelector<HTMLElement>(
            '[data-testid="repro-params"]',
        );
        const parsed = JSON.parse(repro!.textContent ?? '{}');
        expect(parsed.fractalConfig).toBeUndefined();
        expect(parsed.composableConfig).toBeUndefined();
        expect(parsed.rotationMode).toBeUndefined();
        expect(parsed.seed).toBe(12345);
    });

    it('includes wavyConfig in the repro block for a wavy-borderless puzzle', () => {
        createInfoModal({
            container,
            getState: () =>
                makeState({
                    cutStyle: 'wavy',
                    fractalConfig: undefined,
                    wavyConfig: { borderless: true },
                }),
        });

        const repro = container.querySelector<HTMLElement>(
            '[data-testid="repro-params"]',
        );
        expect(repro).not.toBeNull();

        const parsed = JSON.parse(repro!.textContent ?? '{}');
        expect(parsed.wavyConfig).toEqual({ borderless: true });
    });

    it('includes classicConfig in the repro block for a sine-based classic puzzle', () => {
        createInfoModal({
            container,
            getState: () =>
                makeState({
                    cutStyle: 'classic',
                    fractalConfig: undefined,
                    classicConfig: { traceSetVersion: 1 },
                }),
        });

        const parsed = JSON.parse(
            container.querySelector<HTMLElement>('[data-testid="repro-params"]')!.textContent ?? '{}',
        );
        // classicConfig presence is the generator discriminator: a repro block
        // without it describes the legacy straight-grid puzzle instead.
        expect(parsed.classicConfig).toEqual({ traceSetVersion: 1 });
    });

    it('omits classicConfig for a legacy classic puzzle', () => {
        createInfoModal({
            container,
            getState: () => makeState({ cutStyle: 'classic', fractalConfig: undefined }),
        });

        const parsed = JSON.parse(
            container.querySelector<HTMLElement>('[data-testid="repro-params"]')!.textContent ?? '{}',
        );
        expect(parsed.classicConfig).toBeUndefined();
    });

    it('toggles show-debug-pieces on <html> when the debug-pieces checkbox changes', () => {
        createInfoModal({ container });

        const toggle = container.querySelector<HTMLInputElement>(
            '[data-testid="debug-pieces-toggle"]',
        );
        expect(toggle).not.toBeNull();
        expect(
            document.documentElement.classList.contains('show-debug-pieces'),
        ).toBe(false);

        toggle!.checked = true;
        toggle!.dispatchEvent(new Event('change'));
        expect(
            document.documentElement.classList.contains('show-debug-pieces'),
        ).toBe(true);

        toggle!.checked = false;
        toggle!.dispatchEvent(new Event('change'));
        expect(
            document.documentElement.classList.contains('show-debug-pieces'),
        ).toBe(false);
    });

    it('gives every toggle checkbox the shared form-checkbox accent class', () => {
        // Pass state so the share section renders; its "Include my current
        // progress" checkbox is an .info-setting-toggle and must carry the
        // accent class too.
        createInfoModal({ container, state: makeState() });

        const checkboxes = container.querySelectorAll<HTMLInputElement>(
            '.info-setting-toggle input[type="checkbox"]',
        );
        expect(checkboxes.length).toBeGreaterThan(0);
        for (const checkbox of checkboxes) {
            expect(checkbox.classList.contains('form-checkbox')).toBe(true);
        }

        // Assert the share checkbox is covered, so the loop can't pass vacuously
        // if the share section doesn't render.
        const shareCheckbox = container.querySelector<HTMLInputElement>(
            '[data-testid="share-include-progress"]',
        );
        expect(shareCheckbox).not.toBeNull();
        expect(shareCheckbox!.classList.contains('form-checkbox')).toBe(true);
    });

    it('reflects pre-existing show-debug-pieces class as the checkbox state on open', () => {
        document.documentElement.classList.add('show-debug-pieces');
        createInfoModal({ container });

        const toggle = container.querySelector<HTMLInputElement>(
            '[data-testid="debug-pieces-toggle"]',
        );
        expect(toggle!.checked).toBe(true);
    });

    it('renders the share section as the first section in the modal content', () => {
        createInfoModal({ container, state: makeState() });

        const firstSection = container.querySelector<HTMLElement>(
            '.info-modal-content > section.info-section',
        );
        expect(firstSection?.classList.contains('share-section')).toBe(true);
    });

    it('describes rotation in the How to Play section', () => {
        createInfoModal({ container });

        const sections = container.querySelectorAll<HTMLElement>('section.info-section');
        const howToPlay = Array.from(sections).find(
            (s) => s.querySelector('h3')?.textContent === 'How to Play',
        );

        expect(howToPlay?.textContent).toContain('Free rotation');
    });

    it('does not render a Cut Styles section', () => {
        createInfoModal({ container });

        const headings = container.querySelectorAll<HTMLHeadingElement>(
            '.info-section > h3',
        );
        const match = [...headings].find((h) => h.textContent === 'Cut Styles');
        expect(match).toBeUndefined();
    });

    it('focuses the scrolling content so Space and the arrow keys scroll it', () => {
        createInfoModal({ container });

        expect(document.activeElement).toBe(container.querySelector('.info-modal-content'));
    });
});

describe('createInfoModal — How to Play section', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
    });

    function howToPlaySection(): HTMLElement {
        const headings = container.querySelectorAll<HTMLHeadingElement>(
            '.info-section > h3',
        );
        const match = [...headings].find((h) => h.textContent === 'How to Play');
        return match!.parentElement!;
    }

    it('does not mention "composable" in How to Play', () => {
        createInfoModal({ container });
        expect(howToPlaySection().textContent?.toLowerCase()).not.toContain('composable');
    });

    it('documents the Marquee button and its drag-a-box gesture', () => {
        createInfoModal({ container });
        const text = howToPlaySection().textContent ?? '';
        expect(text).toContain('Marquee');
        expect(text).toContain('drag a box');
    });

    it('documents the offline photo download', () => {
        createInfoModal({ container });
        const text = howToPlaySection().textContent ?? '';
        expect(text).toContain('Offline photos');
        expect(text).toContain('no connection');
    });

    it('shows the same multi-select and marquee icons as the toolbar buttons', () => {
        createInfoModal({ container });
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
        createInfoModal({ container });
        const text = howToPlaySection().textContent ?? '';
        const freeRotIdx = text.indexOf('Free rotation');
        expect(freeRotIdx).toBeGreaterThan(-1);
        const context = text.slice(freeRotIdx, freeRotIdx + 60);
        expect(context).toContain('Classic');
        expect(context).toContain('Wavy');
    });

    it('attributes 90° rotation to Fractal only', () => {
        createInfoModal({ container });
        const text = howToPlaySection().textContent ?? '';
        const ninetyIdx = text.indexOf('90° rotation');
        expect(ninetyIdx).toBeGreaterThan(-1);
        const context = text.slice(ninetyIdx, ninetyIdx + 60);
        expect(context).toContain('Fractal');
        expect(context).not.toContain('Classic');
    });
});

describe('createInfoModal — Piece outline setting', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        localStorage.clear();
        document.documentElement.style.removeProperty('--piece-edge-filter');
        document.documentElement.style.removeProperty('--piece-outline-color');
    });

    afterEach(() => {
        container.remove();
    });

    it('renders three Piece outline buttons (None, Shadow, Outline)', () => {
        createInfoModal({ container });

        const buttons = document.querySelectorAll(
            'button[data-testid^="piece-outline-"]',
        );
        expect(buttons.length).toBe(3);
        const labels = Array.from(buttons).map(
            (b) => b.querySelector('.preset-option-label')?.textContent,
        );
        expect(labels).toEqual(['None', 'Shadow', 'Outline']);
    });

    it('marks Shadow as selected by default', () => {
        createInfoModal({ container });

        const shadowBtn = document.querySelector(
            '[data-testid="piece-outline-shadow"]',
        );
        expect(shadowBtn?.classList.contains('selected')).toBe(true);
    });

    it('clicking Outline persists the choice and updates the CSS variable', () => {
        createInfoModal({ container });

        const outlineBtn = document.querySelector(
            '[data-testid="piece-outline-outline"]',
        ) as HTMLButtonElement;
        outlineBtn.click();

        expect(localStorage.getItem('puzzle-piece-outline')).toBe('outline');
        expect(
            document.documentElement.style.getPropertyValue('--piece-edge-filter'),
        ).toBe('url(#piece-outline)');
        expect(outlineBtn.classList.contains('selected')).toBe(true);
    });

    it('clicking a second option deselects the first', () => {
        createInfoModal({ container });

        const noneBtn = document.querySelector(
            '[data-testid="piece-outline-none"]',
        ) as HTMLButtonElement;
        const outlineBtn = document.querySelector(
            '[data-testid="piece-outline-outline"]',
        ) as HTMLButtonElement;

        outlineBtn.click();
        noneBtn.click();

        expect(noneBtn.classList.contains('selected')).toBe(true);
        expect(outlineBtn.classList.contains('selected')).toBe(false);
    });

    it('hides the outline-colour row by default (Shadow active)', () => {
        createInfoModal({ container });
        const row = document.querySelector(
            '[data-testid="piece-outline-color-row"]',
        ) as HTMLElement;
        expect(row).toBeTruthy();
        expect(row.hidden).toBe(true);
    });

    it('reveals the colour row when Outline is selected, hides it for None', () => {
        createInfoModal({ container });
        const row = document.querySelector(
            '[data-testid="piece-outline-color-row"]',
        ) as HTMLElement;
        const outlineBtn = document.querySelector(
            '[data-testid="piece-outline-outline"]',
        ) as HTMLButtonElement;
        const noneBtn = document.querySelector(
            '[data-testid="piece-outline-none"]',
        ) as HTMLButtonElement;

        outlineBtn.click();
        expect(row.hidden).toBe(false);

        noneBtn.click();
        expect(row.hidden).toBe(true);
    });

    it('shows the colour row on open when Outline is the saved style', () => {
        localStorage.setItem('puzzle-piece-outline', 'outline');
        createInfoModal({ container });
        const row = document.querySelector(
            '[data-testid="piece-outline-color-row"]',
        ) as HTMLElement;
        expect(row.hidden).toBe(false);
    });

    it('selecting a swatch persists the colour and sets the CSS variable', () => {
        localStorage.setItem('puzzle-piece-outline', 'outline');
        createInfoModal({ container });

        (
            document.querySelector(
                'button.outline-color-button',
            ) as HTMLButtonElement
        ).click();
        (
            document.querySelector(
                '[data-swatch-id="blue-default"]',
            ) as HTMLButtonElement
        ).click();

        expect(localStorage.getItem('puzzle-piece-outline-color')).toBe(
            'blue-default',
        );
        expect(
            document.documentElement.style.getPropertyValue(
                '--piece-outline-color',
            ),
        ).toBe('var(--color-blue-default)');
    });

    it('closes only the outline-colour picker on Escape, not the modal', async () => {
        localStorage.setItem('puzzle-piece-outline', 'outline');
        createInfoModal({ container });
        container.querySelector<HTMLButtonElement>('button.outline-color-button')!.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(container.querySelector('.outline-color-panel')).toBeNull();
        expect(container.querySelector('.info-modal-overlay')).not.toBeNull();
    });

    it('toggles the marquee-contain preference from the settings checkbox', () => {
        createInfoModal({ container });

        const checkbox = container.querySelector<HTMLInputElement>(
            '[data-testid="marquee-contain-toggle"]',
        );
        expect(checkbox).not.toBeNull();
        expect(checkbox!.checked).toBe(false); // intersect default

        checkbox!.checked = true;
        checkbox!.dispatchEvent(new Event('change'));

        expect(localStorage.getItem('puzzle-marquee-contain')).toBe('true');
    });
});

describe('createInfoModal — Device label setting', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        localStorage.clear();
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        vi.restoreAllMocks();
    });

    function el(testid: string): HTMLElement {
        const found = container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
        expect(found).not.toBeNull();
        return found!;
    }

    function input(): HTMLInputElement {
        return el('device-label-input') as HTMLInputElement;
    }

    function saveButton(): HTMLButtonElement {
        return el('device-label-save') as HTMLButtonElement;
    }

    function type(value: string): void {
        input().value = value;
        input().dispatchEvent(new Event('input'));
    }

    function save(value: string): void {
        type(value);
        saveButton().click();
    }

    it('lives in the Debug section', () => {
        createInfoModal({ container });

        expect(
            el('debug-section').querySelector('[data-testid="device-label-setting"]'),
        ).not.toBeNull();
    });

    it('prefills the input with the stored label', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createInfoModal({ container });

        expect(input().value).toBe('test-device');
    });

    it('leaves the input empty with a "no label" placeholder when none is set', () => {
        createInfoModal({ container });

        expect(input().value).toBe('');
        expect(input().placeholder).toBe('No label set');
    });

    it('says a change applies from the next launch', () => {
        createInfoModal({ container });

        expect(el('device-label-setting').textContent).toContain('next launch');
    });

    it('enables Save only while the input differs from the stored label', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createInfoModal({ container });
        expect(saveButton().disabled).toBe(true);

        type('other-device');
        expect(saveButton().disabled).toBe(false);

        type(' test-device ');
        expect(saveButton().disabled).toBe(true);
    });

    it('saves a valid label, trimmed, and disables Save again', () => {
        createInfoModal({ container });

        save(' test-device ');

        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBe('test-device');
        expect(input().value).toBe('test-device');
        expect(saveButton().disabled).toBe(true);
        expect(el('device-label-error').hidden).toBe(true);
    });

    it('removes the label when saved empty', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createInfoModal({ container });

        save('');

        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBeNull();
        expect(el('device-label-error').hidden).toBe(true);
    });

    it.each(['Test', 'a_b', 'a'.repeat(33)])(
        'shows an inline error for the invalid label %j and keeps the stored one',
        (value) => {
            localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
            createInfoModal({ container });

            save(value);

            const error = el('device-label-error');
            expect(error.hidden).toBe(false);
            expect(error.textContent).toContain('lowercase');
            expect(localStorage.getItem(DISTINCT_ID_KEY)).toBe('test-device');
        },
    );

    it('does not cap the input length, so an overlong label reaches the length error', () => {
        createInfoModal({ container });

        expect(input().hasAttribute('maxlength')).toBe(false);
    });

    it('rejects "off" with a pointer to Clear', () => {
        createInfoModal({ container });

        save('off');

        const error = el('device-label-error');
        expect(error.hidden).toBe(false);
        expect(error.textContent).toContain('Clear');
        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBeNull();
    });

    it('hides a previous error after a successful save', () => {
        createInfoModal({ container });

        save('Bad');
        save('good');

        expect(el('device-label-error').hidden).toBe(true);
    });

    it('hides the error once the input is edited', () => {
        createInfoModal({ container });

        save('Bad');
        type('bad');

        expect(el('device-label-error').hidden).toBe(true);
    });

    it('clears the stored label and the input', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createInfoModal({ container });

        el('device-label-clear').click();

        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBeNull();
        expect(input().value).toBe('');
    });

    it('shows the label actually stored when storage rejects the write', () => {
        createInfoModal({ container });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('full', 'QuotaExceededError');
        });

        save('test-device');

        expect(input().value).toBe('');
        expect(el('device-label-error').hidden).toBe(false);
        expect(el('device-label-error').textContent).toBe("Couldn't save the label.");
    });

    it('reports a failed clear', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createInfoModal({ container });
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });

        el('device-label-clear').click();

        expect(input().value).toBe('test-device');
        expect(el('device-label-error').hidden).toBe(false);
        expect(el('device-label-error').textContent).toBe("Couldn't save the label.");
    });
});

describe('createInfoModal — analytics', () => {
    let container: HTMLElement;
    let umamiTrack: Mock<NonNullable<Window['umami']>['track']>;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        localStorage.clear();
        umamiTrack = vi.fn();
        window.umami = { track: umamiTrack };
    });

    afterEach(() => {
        container.remove();
        delete window.umami;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    function trackedData(name: string): unknown[] {
        return umamiTrack.mock.calls
            .filter(([eventName]) => eventName === name)
            .map(([, data]) => data);
    }

    function closedData(): unknown {
        const sent = trackedData('info-modal-closed');
        expect(sent).toHaveLength(1);
        return sent[0];
    }

    function stubContentGeometry(scrollHeight: number, clientHeight: number): void {
        vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
        vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
    }

    function scrollContentTo(top: number): void {
        const content = container.querySelector<HTMLElement>('.info-modal-content')!;
        content.scrollTop = top;
        content.dispatchEvent(new Event('scroll'));
    }

    function clickClose(): void {
        container.querySelector<HTMLButtonElement>('.info-modal-close')!.click();
    }

    function nextTask(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('sends info-modal-opened when the modal opens', () => {
        createInfoModal({ container });

        expect(umamiTrack).toHaveBeenCalledExactlyOnceWith('info-modal-opened', {});
    });

    it.each([
        ['button', () => clickClose()],
        ['backdrop', () => container.querySelector<HTMLElement>('.info-modal-overlay')!.click()],
        ['escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    ])('reports closedBy %s', (closedBy, close) => {
        createInfoModal({ container });

        close();

        expect(closedData()).toMatchObject({ closedBy });
    });

    it('reports closedBy solve when Solve closes the modal', () => {
        createInfoModal({ container, onSolve: vi.fn() });

        container.querySelector<HTMLButtonElement>('.info-modal-solve-btn')!.click();

        expect(closedData()).toMatchObject({ closedBy: 'solve' });
    });

    it('reports how long the modal was open', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        createInfoModal({ container });

        vi.setSystemTime(1_004_200);
        clickClose();

        expect(closedData()).toMatchObject({ openMs: 4200 });
    });

    it('reports everything seen and no scroll when the content fits', () => {
        stubContentGeometry(400, 400);
        createInfoModal({ container });

        clickClose();

        expect(closedData()).toMatchObject({ seenPercent: 100, scrolled: false });
    });

    it('reports the share visible on open when the content is never scrolled', () => {
        stubContentGeometry(1000, 400);
        createInfoModal({ container });

        clickClose();

        expect(closedData()).toMatchObject({ seenPercent: 40, scrolled: false });
    });

    it('reports the furthest point reached, even after scrolling back up', () => {
        stubContentGeometry(1000, 400);
        createInfoModal({ container });

        scrollContentTo(300);
        scrollContentTo(0);
        clickClose();

        expect(closedData()).toMatchObject({ seenPercent: 70, scrolled: true });
    });

    it('caps seenPercent at 100 when an overscroll reports a scrollTop past the end', () => {
        stubContentGeometry(1000, 400);
        createInfoModal({ container });

        scrollContentTo(700);
        clickClose();

        expect(closedData()).toMatchObject({ seenPercent: 100 });
    });

    it('reports debugOpened false when Debug stays collapsed', () => {
        createInfoModal({ container });

        clickClose();

        expect(closedData()).toMatchObject({ debugOpened: false });
    });

    it('reports debugOpened true once Debug was expanded, even if collapsed again', async () => {
        createInfoModal({ container });
        const summary = container.querySelector<HTMLElement>('[data-testid="debug-section"] > summary')!;

        summary.click();
        await nextTask();
        summary.click();
        await nextTask();
        clickClose();

        expect(closedData()).toMatchObject({ debugOpened: true });
    });

    it.each([
        ['snap-distance', 'tolerance-strict', 'normal', 'strict'],
        ['piece-outline', 'piece-outline-none', 'shadow', 'none'],
    ])('sends setting-changed for %s', (setting, testid, from, to) => {
        createInfoModal({ container });

        container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();

        expect(trackedData('setting-changed')).toEqual([{ setting, from, to }]);
    });

    it.each(['tolerance-normal', 'piece-outline-shadow'])(
        'sends no setting-changed when the selected preset %s is clicked again',
        (testid) => {
            createInfoModal({ container });

            container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();

            expect(trackedData('setting-changed')).toEqual([]);
        },
    );

    it('sends setting-changed for outline-color', () => {
        localStorage.setItem('puzzle-piece-outline', 'outline');
        createInfoModal({ container });

        container.querySelector<HTMLButtonElement>('button.outline-color-button')!.click();
        container.querySelector<HTMLButtonElement>('[data-swatch-id="blue-default"]')!.click();

        expect(trackedData('setting-changed')).toEqual([
            { setting: 'outline-color', from: 'gray-darker-3', to: 'blue-default' },
        ]);
    });

    it.each([
        ['offset-drag', 'offset-drag-toggle'],
        ['enclose-to-select', 'marquee-contain-toggle'],
    ])('sends setting-changed for %s', (setting, testid) => {
        createInfoModal({ container });
        const checkbox = container.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!;

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

        expect(trackedData('setting-changed')).toEqual([{ setting, from: false, to: true }]);
    });
});
