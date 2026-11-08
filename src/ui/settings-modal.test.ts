/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createSettingsModal } from './settings-modal.js';
import type { GameState } from '../model/types.js';
import { makeGameState } from '../test-helpers/fixtures.js';
import { DISTINCT_ID_KEY } from '../analytics/distinct-id.js';
import {
    describeAuto,
    getDetectedEffectsLevel,
    resetDetectedEffectsLevelForTests,
} from './effects.js';

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

describe('createSettingsModal', () => {
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
        createSettingsModal({ container });

        const debug = container.querySelector<HTMLDetailsElement>(
            '[data-testid="debug-section"]',
        );
        expect(debug?.tagName.toLowerCase()).toBe('details');
        expect(debug?.open).toBe(false);
    });

    it('renders repro params as JSON inside the debug section', () => {
        createSettingsModal({ container, getState: () => makeState() });

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
        createSettingsModal({ container });

        const setting = container.querySelector<HTMLElement>(
            '[data-testid="repro-params-setting"]',
        );
        expect(setting?.style.display).toBe('none');
    });

    it('omits undefined state fields from the repro block', () => {
        createSettingsModal({
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
        createSettingsModal({
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
        createSettingsModal({
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
        createSettingsModal({
            container,
            getState: () => makeState({ cutStyle: 'classic', fractalConfig: undefined }),
        });

        const parsed = JSON.parse(
            container.querySelector<HTMLElement>('[data-testid="repro-params"]')!.textContent ?? '{}',
        );
        expect(parsed.classicConfig).toBeUndefined();
    });

    it('toggles show-debug-pieces on <html> when the debug-pieces checkbox changes', () => {
        createSettingsModal({ container });

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

    it('marks <html> while the piece opacity slider is below 1', () => {
        createSettingsModal({ container });
        const slider = container.querySelector<HTMLInputElement>('[data-testid="piece-opacity-slider"]')!;
        const set = (value: string) => {
            slider.value = value;
            slider.dispatchEvent(new Event('input'));
        };

        set('0.5');
        expect(document.documentElement.classList.contains('pieces-translucent')).toBe(true);

        set('1');
        expect(document.documentElement.classList.contains('pieces-translucent')).toBe(false);
        document.documentElement.style.removeProperty('--piece-opacity');
    });

    it('gives every toggle checkbox the shared form-checkbox accent class', () => {
        createSettingsModal({ container });

        const checkboxes = container.querySelectorAll<HTMLInputElement>(
            '.info-setting-toggle input[type="checkbox"]',
        );
        expect(checkboxes.length).toBeGreaterThan(0);
        for (const checkbox of checkboxes) {
            expect(checkbox.classList.contains('form-checkbox')).toBe(true);
        }
    });

    it('is titled Settings with no Settings subheading', () => {
        createSettingsModal({ container });

        expect(container.querySelector('.info-modal-title')!.textContent).toBe('Settings');
        const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent);
        expect(headings).not.toContain('Settings');
    });

    it('puts the settings before Debug', () => {
        createSettingsModal({ container });

        const content = container.querySelector('.info-modal-content')!;
        expect(content.firstElementChild!.querySelector('[data-testid="tolerance-options"]')).not.toBeNull();
        expect(content.lastElementChild!.getAttribute('data-testid')).toBe('debug-section');
    });

    it('holds no help content', () => {
        createSettingsModal({ container });

        const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent);
        expect(headings).not.toContain('How to Play');
        expect(container.querySelector('.share-section')).toBeNull();
    });

    it('reflects pre-existing show-debug-pieces class as the checkbox state on open', () => {
        document.documentElement.classList.add('show-debug-pieces');
        createSettingsModal({ container });

        const toggle = container.querySelector<HTMLInputElement>(
            '[data-testid="debug-pieces-toggle"]',
        );
        expect(toggle!.checked).toBe(true);
    });
});

describe('createSettingsModal — Effects setting', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        localStorage.clear();
        resetDetectedEffectsLevelForTests();
        delete document.documentElement.dataset.effects;
    });

    afterEach(() => {
        container.remove();
    });

    it('renders Auto, Full and Simple with Auto selected by default', () => {
        createSettingsModal({ container });

        const buttons = Array.from(
            container.querySelectorAll<HTMLButtonElement>('[data-testid="effects-options"] button'),
        );
        expect(buttons.map((b) => b.dataset.testid)).toEqual([
            'effects-auto',
            'effects-full',
            'effects-simple',
        ]);
        expect(buttons[0].classList.contains('selected')).toBe(true);
    });

    it('shows what Auto resolved to on this device', () => {
        createSettingsModal({ container });

        const desc = container.querySelector(
            '[data-testid="effects-auto"] .preset-option-desc',
        )!.textContent;
        expect(desc).toBe(describeAuto(getDetectedEffectsLevel()));
        expect(desc).toBe('Full on this device');
    });

    it('saves a choice and moves the selection, leaving applying it to the caller', () => {
        createSettingsModal({ container });

        const simple = container.querySelector<HTMLButtonElement>('[data-testid="effects-simple"]')!;
        simple.click();

        expect(localStorage.getItem('puzzle-effects')).toBe('simple');
        expect(document.documentElement.dataset.effects).toBeUndefined();
        expect(simple.classList.contains('selected')).toBe(true);
        expect(
            container.querySelector('[data-testid="effects-auto"]')!.classList.contains('selected'),
        ).toBe(false);
    });

    it('reports the chosen option through onEffectsChanged', () => {
        const onEffectsChanged = vi.fn();
        createSettingsModal({ container, onEffectsChanged });

        container.querySelector<HTMLButtonElement>('[data-testid="effects-simple"]')!.click();
        container.querySelector<HTMLButtonElement>('[data-testid="effects-auto"]')!.click();

        expect(onEffectsChanged.mock.calls).toEqual([['simple'], ['auto']]);
    });

    it('sits right after the Piece outline setting', () => {
        createSettingsModal({ container });

        const outlineSetting = container
            .querySelector('[data-testid="piece-outline-options"]')!
            .closest('.info-setting')!;
        expect(
            outlineSetting.nextElementSibling!.querySelector('[data-testid="effects-options"]'),
        ).not.toBeNull();
    });
});

describe('createSettingsModal — Piece outline setting', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        localStorage.clear();
        document.documentElement.style.removeProperty('--piece-edge-filter');
        document.documentElement.style.removeProperty('--piece-outline-color');
        delete document.documentElement.dataset.pieceOutline;
        document.documentElement.removeAttribute('data-outline-constant-width');
    });

    afterEach(() => {
        container.remove();
    });

    it('renders three Piece outline buttons (None, Shadow, Outline)', () => {
        createSettingsModal({ container });

        const buttons = document.querySelectorAll(
            'button[data-testid^="piece-outline-"]',
        );
        expect(buttons.length).toBe(3);
        const labels = Array.from(buttons).map(
            (b) => b.querySelector('.preset-option-label')?.textContent,
        );
        expect(labels).toEqual(['None', 'Shadow', 'Outline']);
    });

    it('marks Outline as selected by default', () => {
        createSettingsModal({ container });

        const outlineBtn = document.querySelector(
            '[data-testid="piece-outline-outline"]',
        );
        expect(outlineBtn?.classList.contains('selected')).toBe(true);
    });

    it('clicking Shadow persists the choice and updates the CSS variable', () => {
        createSettingsModal({ container });

        const shadowBtn = document.querySelector(
            '[data-testid="piece-outline-shadow"]',
        ) as HTMLButtonElement;
        shadowBtn.click();

        expect(localStorage.getItem('puzzle-piece-outline')).toBe('shadow');
        expect(
            document.documentElement.style.getPropertyValue('--piece-edge-filter'),
        ).toMatch(/^drop-shadow\(/);
        expect(document.documentElement.dataset.pieceOutline).toBe('shadow');
        expect(shadowBtn.classList.contains('selected')).toBe(true);
    });

    it('clicking a second option deselects the first', () => {
        createSettingsModal({ container });

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

    it('shows the outline-colour row by default (Outline active)', () => {
        createSettingsModal({ container });
        const row = document.querySelector(
            '[data-testid="piece-outline-color-row"]',
        ) as HTMLElement;
        expect(row.hidden).toBe(false);
    });

    it('hides the outline-colour row when Shadow is the saved style', () => {
        localStorage.setItem('puzzle-piece-outline', 'shadow');
        createSettingsModal({ container });
        const row = document.querySelector(
            '[data-testid="piece-outline-color-row"]',
        ) as HTMLElement;
        expect(row).toBeTruthy();
        expect(row.hidden).toBe(true);
    });

    it('reveals the colour row when Outline is selected, hides it for None', () => {
        createSettingsModal({ container });
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
        createSettingsModal({ container });
        const row = document.querySelector(
            '[data-testid="piece-outline-color-row"]',
        ) as HTMLElement;
        expect(row.hidden).toBe(false);
    });

    it('offers an unchecked same-width toggle, shown only with Outline', () => {
        createSettingsModal({ container });
        const toggle = container.querySelector<HTMLInputElement>(
            '[data-testid="outline-constant-width-toggle"]',
        )!;
        const row = toggle.closest<HTMLElement>('[data-testid="outline-constant-width-row"]')!;
        expect(toggle.checked).toBe(false);
        expect(row.hidden).toBe(false);

        container.querySelector<HTMLButtonElement>('[data-testid="piece-outline-shadow"]')!.click();
        expect(row.hidden).toBe(true);
    });

    it('checking the same-width toggle persists it and flags the root element', () => {
        createSettingsModal({ container });
        const toggle = container.querySelector<HTMLInputElement>(
            '[data-testid="outline-constant-width-toggle"]',
        )!;

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(localStorage.getItem('puzzle-outline-constant-width')).toBe('true');
        expect(document.documentElement.hasAttribute('data-outline-constant-width')).toBe(true);
    });

    it('shows the saved same-width choice on open', () => {
        localStorage.setItem('puzzle-outline-constant-width', 'true');
        createSettingsModal({ container });
        expect(
            container.querySelector<HTMLInputElement>(
                '[data-testid="outline-constant-width-toggle"]',
            )!.checked,
        ).toBe(true);
    });

    it('selecting a swatch persists the colour and sets the CSS variable', () => {
        localStorage.setItem('puzzle-piece-outline', 'outline');
        createSettingsModal({ container });

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
        createSettingsModal({ container });
        container.querySelector<HTMLButtonElement>('button.outline-color-button')!.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(container.querySelector('.outline-color-panel')).toBeNull();
        expect(container.querySelector('.info-modal-overlay')).not.toBeNull();
    });

    it('toggles the marquee-contain preference from the settings checkbox', () => {
        createSettingsModal({ container });

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

describe('createSettingsModal — Device label setting', () => {
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
        createSettingsModal({ container });

        expect(
            el('debug-section').querySelector('[data-testid="device-label-setting"]'),
        ).not.toBeNull();
    });

    it('prefills the input with the stored label', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createSettingsModal({ container });

        expect(input().value).toBe('test-device');
    });

    it('leaves the input empty with a "no label" placeholder when none is set', () => {
        createSettingsModal({ container });

        expect(input().value).toBe('');
        expect(input().placeholder).toBe('No label set');
    });

    it('says a change applies from the next launch', () => {
        createSettingsModal({ container });

        expect(el('device-label-setting').textContent).toContain('next launch');
    });

    it('enables Save only while the input differs from the stored label', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createSettingsModal({ container });
        expect(saveButton().disabled).toBe(true);

        type('other-device');
        expect(saveButton().disabled).toBe(false);

        type(' test-device ');
        expect(saveButton().disabled).toBe(true);
    });

    it('saves a valid label, trimmed, and disables Save again', () => {
        createSettingsModal({ container });

        save(' test-device ');

        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBe('test-device');
        expect(input().value).toBe('test-device');
        expect(saveButton().disabled).toBe(true);
        expect(el('device-label-error').hidden).toBe(true);
    });

    it('removes the label when saved empty', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createSettingsModal({ container });

        save('');

        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBeNull();
        expect(el('device-label-error').hidden).toBe(true);
    });

    it.each(['Test', 'a_b', 'a'.repeat(33)])(
        'shows an inline error for the invalid label %j and keeps the stored one',
        (value) => {
            localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
            createSettingsModal({ container });

            save(value);

            const error = el('device-label-error');
            expect(error.hidden).toBe(false);
            expect(error.textContent).toContain('lowercase');
            expect(localStorage.getItem(DISTINCT_ID_KEY)).toBe('test-device');
        },
    );

    it('does not cap the input length, so an overlong label reaches the length error', () => {
        createSettingsModal({ container });

        expect(input().hasAttribute('maxlength')).toBe(false);
    });

    it('rejects "off" with a pointer to Clear', () => {
        createSettingsModal({ container });

        save('off');

        const error = el('device-label-error');
        expect(error.hidden).toBe(false);
        expect(error.textContent).toContain('Clear');
        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBeNull();
    });

    it('hides a previous error after a successful save', () => {
        createSettingsModal({ container });

        save('Bad');
        save('good');

        expect(el('device-label-error').hidden).toBe(true);
    });

    it('hides the error once the input is edited', () => {
        createSettingsModal({ container });

        save('Bad');
        type('bad');

        expect(el('device-label-error').hidden).toBe(true);
    });

    it('clears the stored label and the input', () => {
        localStorage.setItem(DISTINCT_ID_KEY, 'test-device');
        createSettingsModal({ container });

        el('device-label-clear').click();

        expect(localStorage.getItem(DISTINCT_ID_KEY)).toBeNull();
        expect(input().value).toBe('');
    });

    it('shows the label actually stored when storage rejects the write', () => {
        createSettingsModal({ container });
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
        createSettingsModal({ container });
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });

        el('device-label-clear').click();

        expect(input().value).toBe('test-device');
        expect(el('device-label-error').hidden).toBe(false);
        expect(el('device-label-error').textContent).toBe("Couldn't save the label.");
    });
});

describe('createSettingsModal — analytics', () => {
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
        const sent = trackedData('settings-modal-closed');
        expect(sent).toHaveLength(1);
        return sent[0];
    }

    function clickClose(): void {
        container.querySelector<HTMLButtonElement>('.info-modal-close')!.click();
    }

    function nextTask(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('sends settings-modal-opened when the modal opens', () => {
        createSettingsModal({ container });

        expect(umamiTrack).toHaveBeenCalledExactlyOnceWith('settings-modal-opened', {});
    });

    it('reports closedBy solve when Solve closes the modal', () => {
        createSettingsModal({ container, onSolve: vi.fn() });

        container.querySelector<HTMLButtonElement>('.info-modal-solve-btn')!.click();

        expect(closedData()).toMatchObject({ closedBy: 'solve' });
    });

    it('reports view stats with debugOpened false when Debug stays collapsed', () => {
        createSettingsModal({ container });

        clickClose();

        expect(closedData()).toEqual({
            closedBy: 'button',
            openMs: expect.any(Number),
            seenPercent: 100,
            scrolled: false,
            debugOpened: false,
        });
    });

    it('reports debugOpened true once Debug was expanded, even if collapsed again', async () => {
        createSettingsModal({ container });
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
        ['piece-outline', 'piece-outline-none', 'outline', 'none'],
    ])('sends setting-changed for %s', (setting, testid, from, to) => {
        createSettingsModal({ container });

        container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();

        expect(trackedData('setting-changed')).toEqual([{ setting, from, to }]);
    });

    it('sends setting-changed for effects with what Auto detects on this device', () => {
        createSettingsModal({ container });

        container.querySelector<HTMLButtonElement>('[data-testid="effects-simple"]')!.click();

        expect(trackedData('setting-changed')).toEqual([
            { setting: 'effects', from: 'auto', to: 'simple', detected: getDetectedEffectsLevel() },
        ]);
    });

    it.each(['tolerance-normal', 'piece-outline-outline'])(
        'sends no setting-changed when the selected preset %s is clicked again',
        (testid) => {
            createSettingsModal({ container });

            container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();

            expect(trackedData('setting-changed')).toEqual([]);
        },
    );

    it('sends setting-changed for outline-color', () => {
        localStorage.setItem('puzzle-piece-outline', 'outline');
        createSettingsModal({ container });

        container.querySelector<HTMLButtonElement>('button.outline-color-button')!.click();
        container.querySelector<HTMLButtonElement>('[data-swatch-id="blue-default"]')!.click();

        expect(trackedData('setting-changed')).toEqual([
            { setting: 'outline-color', from: 'gray-darker-3', to: 'blue-default' },
        ]);
    });

    it.each([
        ['offset-drag', 'offset-drag-toggle'],
        ['enclose-to-select', 'marquee-contain-toggle'],
        ['outline-constant-width', 'outline-constant-width-toggle'],
    ])('sends setting-changed for %s', (setting, testid) => {
        createSettingsModal({ container });
        const checkbox = container.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!;

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

        expect(trackedData('setting-changed')).toEqual([{ setting, from: false, to: true }]);
    });
});
