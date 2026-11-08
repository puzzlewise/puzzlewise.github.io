import type { GameState } from '../model/types.js';
import { buildReproParams } from '../sharing/index.js';
import {
    isValidDistinctId,
    readDistinctId,
    writeDistinctId,
} from '../analytics/distinct-id.js';

/** HTML class toggled on <html> to switch pieces into debug (white) view. */
const DEBUG_PIECES_CLASS = 'show-debug-pieces';

const TRANSLUCENT_PIECES_CLASS = 'pieces-translucent';

export function buildDebugSection(args: {
    state: GameState | null | undefined;
    onSolve?: () => void;
}): HTMLDetailsElement {
    const details = document.createElement('details');
    details.className = 'info-section info-section--debug';
    details.dataset.testid = 'debug-section';

    const summary = document.createElement('summary');
    summary.className = 'info-section-summary';
    summary.textContent = 'Debug';
    details.appendChild(summary);

    details.appendChild(buildReproSetting(args.state));

    details.appendChild(buildDeviceLabelSetting());

    details.appendChild(buildOpacitySetting());

    details.appendChild(
        buildDebugToggleSetting({
            testid: 'mateless-edges-toggle',
            label: 'Show mateless edges',
            description:
                'Highlight edges with no mate (mateEdgeId = -1) in pink.',
            htmlClass: 'show-mateless-edges',
        }),
    );

    details.appendChild(
        buildDebugToggleSetting({
            testid: 'debug-pieces-toggle',
            label: 'Debug piece view',
            description:
                'Show pieces as white outlines with their piece IDs and an arrow indicating each piece\'s original "up" direction.',
            htmlClass: DEBUG_PIECES_CLASS,
        }),
    );

    // Kept inside Debug so all debug tools stay together.
    const { onSolve } = args;
    if (onSolve) {
        const solveBtn = document.createElement('button');
        solveBtn.className = 'info-modal-solve-btn';
        solveBtn.textContent = '🧩 Solve Puzzle';
        solveBtn.type = 'button';
        solveBtn.addEventListener('click', () => onSolve());
        details.appendChild(solveBtn);
    }

    return details;
}

function buildReproSetting(state: GameState | null | undefined): HTMLElement {
    const setting = document.createElement('div');
    setting.className = 'info-setting';
    setting.dataset.testid = 'repro-params-setting';

    const label = document.createElement('label');
    label.className = 'info-setting-label';
    label.textContent = 'Reproduction parameters';
    setting.appendChild(label);

    const desc = document.createElement('p');
    desc.className = 'info-setting-description';
    desc.textContent =
        'Parameters needed to regenerate this exact puzzle. Include in bug '
        + 'reports, or paste into __reproPuzzle(...) in the browser console '
        + 'to replay it.';
    setting.appendChild(desc);

    const block = document.createElement('pre');
    block.className = 'info-repro-block';
    block.dataset.testid = 'repro-params';
    setting.appendChild(block);

    if (state) {
        block.textContent = JSON.stringify(buildReproParams(state), null, 2);
    } else {
        setting.style.display = 'none';
    }

    return setting;
}

function buildDeviceLabelSetting(): HTMLElement {
    const setting = document.createElement('div');
    setting.className = 'info-setting';
    setting.dataset.testid = 'device-label-setting';

    const label = document.createElement('label');
    label.className = 'info-setting-label';
    label.htmlFor = 'device-label-input';
    label.textContent = 'Device label';
    setting.appendChild(label);

    const desc = document.createElement('p');
    desc.className = 'info-setting-description';
    desc.textContent =
        'Tags this device\'s analytics events. Changes apply from the next launch.';
    setting.appendChild(desc);

    const form = document.createElement('form');
    form.className = 'info-device-label-form';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'device-label-input';
    input.dataset.testid = 'device-label-input';
    input.placeholder = 'No label set';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'none');
    input.setAttribute('autocorrect', 'off');
    form.appendChild(input);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.dataset.testid = 'device-label-save';
    saveBtn.textContent = 'Save';
    form.appendChild(saveBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.dataset.testid = 'device-label-clear';
    clearBtn.textContent = 'Clear';
    form.appendChild(clearBtn);

    setting.appendChild(form);

    const error = document.createElement('p');
    error.className = 'info-device-label-error';
    error.dataset.testid = 'device-label-error';
    error.hidden = true;
    error.setAttribute('aria-live', 'polite');
    setting.appendChild(error);

    function syncSaveButton(): void {
        saveBtn.disabled = input.value.trim() === (readDistinctId() ?? '');
    }

    function showError(message: string): void {
        error.textContent = message;
        error.hidden = false;
    }

    function apply(id: string | undefined): void {
        writeDistinctId(id);
        const stored = readDistinctId();
        input.value = stored ?? '';
        syncSaveButton();
        if (stored === id) {
            error.hidden = true;
        } else {
            showError("Couldn't save the label.");
        }
    }

    input.addEventListener('input', () => {
        error.hidden = true;
        syncSaveButton();
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (value === '' || isValidDistinctId(value)) {
            apply(value || undefined);
            return;
        }
        showError(value === 'off'
            ? '"off" is reserved. Use Clear to remove the label.'
            : 'Use 1–32 lowercase letters, digits or hyphens.');
    });
    clearBtn.addEventListener('click', () => apply(undefined));

    input.value = readDistinctId() ?? '';
    syncSaveButton();
    return setting;
}

function buildOpacitySetting(): HTMLElement {
    const setting = document.createElement('div');
    setting.className = 'info-setting';

    const label = document.createElement('label');
    label.className = 'info-setting-label';
    label.htmlFor = 'piece-opacity-slider';
    label.textContent = 'Piece opacity';
    setting.appendChild(label);

    const desc = document.createElement('p');
    desc.className = 'info-setting-description';
    desc.textContent = 'Adjust puzzle piece transparency.';
    setting.appendChild(desc);

    const row = document.createElement('div');
    row.className = 'info-setting-slider';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'piece-opacity-slider';
    slider.dataset.testid = 'piece-opacity-slider';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.05';
    slider.value = '1';

    const value = document.createElement('span');
    value.className = 'info-setting-slider-value';
    value.dataset.testid = 'piece-opacity-value';
    value.textContent = '1';

    const current = getComputedStyle(document.documentElement)
        .getPropertyValue('--piece-opacity')
        .trim();
    if (current) {
        slider.value = current;
        value.textContent = current;
    }
    slider.addEventListener('input', () => {
        value.textContent = slider.value;
        document.documentElement.style.setProperty('--piece-opacity', slider.value);
        document.documentElement.classList.toggle(TRANSLUCENT_PIECES_CLASS, Number(slider.value) < 1);
    });

    row.appendChild(slider);
    row.appendChild(value);
    setting.appendChild(row);

    return setting;
}

function buildDebugToggleSetting(args: {
    testid: string;
    label: string;
    description: string;
    htmlClass: string;
}): HTMLElement {
    const setting = document.createElement('div');
    setting.className = 'info-setting';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'info-setting-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-checkbox';
    checkbox.dataset.testid = args.testid;
    checkbox.checked = document.documentElement.classList.contains(args.htmlClass);
    checkbox.addEventListener('change', () => {
        document.documentElement.classList.toggle(args.htmlClass, checkbox.checked);
    });

    const text = document.createElement('span');
    text.className = 'info-setting-label';
    text.textContent = args.label;

    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(text);
    setting.appendChild(toggleLabel);

    const desc = document.createElement('p');
    desc.className = 'info-setting-description';
    desc.textContent = args.description;
    setting.appendChild(desc);

    return setting;
}
