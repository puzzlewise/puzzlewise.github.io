import type { GameState } from '../model/types.js';
import { createModalShell } from './modal-shell.js';
import {
    getSortedPresets,
    loadTolerancePreference,
    saveTolerancePreference,
} from './merge-tolerance.js';
import {
    loadOffsetDragPreference,
    saveOffsetDragPreference,
} from './offset-drag.js';
import {
    loadMarqueeContainPreference,
    saveMarqueeContainPreference,
} from './marquee-contain.js';
import {
    PIECE_OUTLINE_PRESETS,
    loadPieceOutlinePreference,
    savePieceOutlinePreference,
    applyPieceOutline,
} from './piece-outline.js';
import {
    loadPieceOutlineColorPreference,
    savePieceOutlineColorPreference,
    applyPieceOutlineColor,
} from './piece-outline-color.js';
import { createPieceOutlineColorPicker } from './piece-outline-color-picker.js';
import {
    EFFECTS_PRESETS,
    getDetectedEffectsLevel,
    loadEffectsPreference,
    saveEffectsPreference,
} from './effects.js';
import {
    loadOutlineConstantWidthPreference,
    saveOutlineConstantWidthPreference,
    applyOutlineConstantWidth,
} from './outline-constant-width.js';
import {
    loadOutlineInsidePreference,
    saveOutlineInsidePreference,
    applyOutlineInside,
} from './outline-inside.js';
import { buildDebugSection } from './debug-section.js';
import { track } from '../analytics/index.js';
import type { SettingChangedData } from '../analytics/index.js';

export interface SettingsModalOptions {
    container: HTMLElement;
    onEffectsChanged?: (preference: string) => void;
    onOutlineChanged?: () => void;
    onSolve?: () => void;
    /** Used by the Debug panel's repro block; when absent the block is omitted. */
    getState?: () => GameState | null | undefined;
}

function trackSettingChange(data: SettingChangedData): void {
    if (data.from !== data.to) {
        track('setting-changed', data);
    }
}

function buildSettingsSection(
    onEffectsChanged?: (preference: string) => void,
    onOutlineChanged?: () => void,
): HTMLElement {
    const section = document.createElement('section');
    section.className = 'info-section';

    section.appendChild(buildToleranceSetting());
    section.appendChild(buildPieceOutlineSetting(onOutlineChanged));
    section.appendChild(buildEffectsSetting(onEffectsChanged));
    section.appendChild(buildOffsetDragSetting());
    section.appendChild(buildMarqueeContainSetting());

    return section;
}

interface SettingPreset {
    id: string;
    label: string;
    description: string | (() => string);
}

function buildPresetSetting(opts: {
    label: string;
    description: string;
    testidPrefix: string;
    presets: readonly SettingPreset[];
    load: () => string;
    onSelect: (id: string) => void;
}): HTMLElement {
    const setting = document.createElement('div');
    setting.className = 'info-setting';

    const label = document.createElement('label');
    label.className = 'info-setting-label';
    label.textContent = opts.label;
    setting.appendChild(label);

    const desc = document.createElement('p');
    desc.className = 'info-setting-description';
    desc.textContent = opts.description;
    setting.appendChild(desc);

    const container = document.createElement('div');
    container.className = 'preset-options';
    container.dataset.testid = `${opts.testidPrefix}-options`;

    const currentId = opts.load();
    for (const preset of opts.presets) {
        const button = document.createElement('button');
        button.className = 'preset-option';
        button.type = 'button';
        button.dataset.testid = `${opts.testidPrefix}-${preset.id}`;
        if (preset.id === currentId) {
            button.classList.add('selected');
        }

        const labelSpan = document.createElement('span');
        labelSpan.className = 'preset-option-label';
        labelSpan.textContent = preset.label;
        button.appendChild(labelSpan);

        const descSpan = document.createElement('span');
        descSpan.className = 'preset-option-desc';
        descSpan.textContent = typeof preset.description === 'function'
            ? preset.description()
            : preset.description;
        button.appendChild(descSpan);

        button.addEventListener('click', () => {
            opts.onSelect(preset.id);
            container
                .querySelectorAll('.preset-option')
                .forEach((btn) => btn.classList.remove('selected'));
            button.classList.add('selected');
        });

        container.appendChild(button);
    }

    setting.appendChild(container);
    return setting;
}

function buildToleranceSetting(): HTMLElement {
    return buildPresetSetting({
        label: 'Snap distance',
        description: 'How close pieces need to be before they snap together.',
        testidPrefix: 'tolerance',
        presets: getSortedPresets(),
        load: loadTolerancePreference,
        onSelect: (id) => {
            trackSettingChange({ setting: 'snap-distance', from: loadTolerancePreference(), to: id });
            saveTolerancePreference(id);
        },
    });
}

function buildPieceOutlineSetting(onOutlineChanged?: () => void): HTMLElement {
    const setting = buildPresetSetting({
        label: 'Piece outline',
        description:
            'The visual edge drawn around each piece group. With "Outline" ' +
            'selected, pick its colour below.',
        testidPrefix: 'piece-outline',
        presets: PIECE_OUTLINE_PRESETS,
        load: loadPieceOutlinePreference,
        onSelect: (id) => {
            trackSettingChange({ setting: 'piece-outline', from: loadPieceOutlinePreference(), to: id });
            savePieceOutlinePreference(id);
            applyPieceOutline(id);
            updateOutlineOnlyRows(id);
            onOutlineChanged?.();
        },
    });

    const colorRow = document.createElement('div');
    colorRow.className = 'outline-color-row';
    colorRow.dataset.testid = 'piece-outline-color-row';

    const colorLabel = document.createElement('span');
    colorLabel.className = 'info-setting-label';
    colorLabel.textContent = 'Outline colour';
    colorRow.appendChild(colorLabel);

    createPieceOutlineColorPicker({
        container: colorRow,
        selectedId: loadPieceOutlineColorPreference(),
        onSelect: (colorId) => {
            trackSettingChange({
                setting: 'outline-color',
                from: loadPieceOutlineColorPreference(),
                to: colorId,
            });
            savePieceOutlineColorPreference(colorId);
            applyPieceOutlineColor(colorId);
        },
    });

    const widthRow = buildOutlineConstantWidthToggle();
    const insideRow = buildOutlineInsideToggle(onOutlineChanged);

    function updateOutlineOnlyRows(styleId: string): void {
        for (const row of [colorRow, widthRow, insideRow]) row.hidden = styleId !== 'outline';
    }
    updateOutlineOnlyRows(loadPieceOutlinePreference());

    setting.append(colorRow, widthRow, insideRow);
    return setting;
}

function buildEffectsSetting(onEffectsChanged?: (preference: string) => void): HTMLElement {
    return buildPresetSetting({
        label: 'Effects',
        description:
            'Simple draws shadows and the selection glow as plain rings, ' +
            'which is much lighter work for older devices.',
        testidPrefix: 'effects',
        presets: EFFECTS_PRESETS,
        load: loadEffectsPreference,
        onSelect: (id) => {
            trackSettingChange({
                setting: 'effects',
                from: loadEffectsPreference(),
                to: id,
                detected: getDetectedEffectsLevel(),
            });
            saveEffectsPreference(id);
            onEffectsChanged?.(id);
        },
    });
}

function buildOutlineConstantWidthToggle(): HTMLElement {
    const row = buildCheckboxSetting({
        testid: 'outline-constant-width-toggle',
        label: 'Same width at any zoom',
        description:
            'Keep the outline equally thick on screen when you zoom, so it stays visible zoomed out.',
        setting: 'outline-constant-width',
        load: loadOutlineConstantWidthPreference,
        save: (on) => {
            saveOutlineConstantWidthPreference(on);
            applyOutlineConstantWidth(on);
        },
    });
    row.className = 'outline-option-row';
    row.dataset.testid = 'outline-constant-width-row';
    return row;
}

function buildOutlineInsideToggle(onOutlineChanged?: () => void): HTMLElement {
    const row = buildCheckboxSetting({
        testid: 'outline-inside-toggle',
        label: 'Draw inside the edge',
        description:
            'Draw the outline over the edge of the picture instead of around it, ' +
            'so tabs look their true size.',
        setting: 'outline-inside',
        load: loadOutlineInsidePreference,
        save: (on) => {
            saveOutlineInsidePreference(on);
            applyOutlineInside(on);
            onOutlineChanged?.();
        },
    });
    row.className = 'outline-option-row';
    row.dataset.testid = 'outline-inside-row';
    return row;
}

function buildOffsetDragSetting(): HTMLElement {
    return buildCheckboxSetting({
        testid: 'offset-drag-toggle',
        label: 'Offset drag',
        description: "Shift the dragged piece or group upward, so your finger doesn't block the view.",
        setting: 'offset-drag',
        load: loadOffsetDragPreference,
        save: saveOffsetDragPreference,
    });
}

function buildMarqueeContainSetting(): HTMLElement {
    return buildCheckboxSetting({
        testid: 'marquee-contain-toggle',
        label: 'Enclose to select',
        description:
            'When dragging a selection box, select only pieces fully inside the ' +
            'box instead of every piece the box touches.',
        setting: 'enclose-to-select',
        load: loadMarqueeContainPreference,
        save: saveMarqueeContainPreference,
    });
}

function buildCheckboxSetting(opts: {
    testid: string;
    label: string;
    description: string;
    setting: Extract<SettingChangedData, { to: boolean }>['setting'];
    load: () => boolean;
    save: (value: boolean) => void;
}): HTMLElement {
    const setting = document.createElement('div');
    setting.className = 'info-setting';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'info-setting-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-checkbox';
    checkbox.dataset.testid = opts.testid;
    checkbox.checked = opts.load();
    checkbox.addEventListener('change', () => {
        trackSettingChange({ setting: opts.setting, from: opts.load(), to: checkbox.checked });
        opts.save(checkbox.checked);
    });

    const text = document.createElement('span');
    text.className = 'info-setting-label';
    text.textContent = opts.label;

    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(text);
    setting.appendChild(toggleLabel);

    const desc = document.createElement('p');
    desc.className = 'info-setting-description';
    desc.textContent = opts.description;
    setting.appendChild(desc);

    return setting;
}

export function createSettingsModal(options: SettingsModalOptions): void {
    const { container, onEffectsChanged, onOutlineChanged, getState, onSolve } = options;
    let debugOpened = false;

    createModalShell<'solve'>({
        container,
        title: 'Settings',
        buildContent: (close) => {
            const debugSection = buildDebugSection({
                state: getState?.(),
                onSolve: onSolve && (() => {
                    close('solve');
                    onSolve();
                }),
            });
            debugSection.addEventListener('toggle', () => {
                if (debugSection.open) {
                    debugOpened = true;
                }
            });
            return [buildSettingsSection(onEffectsChanged, onOutlineChanged), debugSection];
        },
        onClosed: (closedBy, stats) => track('settings-modal-closed', { closedBy, ...stats, debugOpened }),
    });

    track('settings-modal-opened', {});
}
