import { BACKGROUND_COLOR_PRESETS } from './background-color.js';
import { createSwatchPicker, type SwatchPickerHandle } from './swatch-picker.js';
import { createBackgroundIcon } from './tool-icons.js';

export interface BackgroundColorPickerOptions {
    container: HTMLElement;
    selectedId: string;
    onSelect: (id: string) => void;
}

export function createBackgroundColorPicker(
    options: BackgroundColorPickerOptions,
): SwatchPickerHandle {
    return createSwatchPicker({
        container: options.container,
        button: {
            icon: createBackgroundIcon(),
            title: 'Background colour',
            className: 'bg-color-button',
        },
        ariaLabel: 'Background colour',
        panelClassName: 'bg-color-panel',
        swatches: BACKGROUND_COLOR_PRESETS,
        selectedId: options.selectedId,
        onSelect: options.onSelect,
        columnCount: 20,
    });
}
