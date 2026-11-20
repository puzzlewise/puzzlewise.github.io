import { PIECE_OUTLINE_COLOR_PRESETS } from './piece-outline-color.js';
import { createSwatchPicker } from './swatch-picker.js';

export interface PieceOutlineColorPickerOptions {
    container: HTMLElement;
    selectedId: string;
    onSelect: (id: string) => void;
}

export function createPieceOutlineColorPicker(
    options: PieceOutlineColorPickerOptions,
): () => void {
    const picker = createSwatchPicker({
        container: options.container,
        button: {
            // No glyph — the button's background previews the current color via
            // CSS (`.outline-color-button` = `var(--piece-outline-color)`).
            icon: null,
            title: 'Outline colour',
            className: 'outline-color-button',
        },
        ariaLabel: 'Outline colour',
        panelClassName: 'outline-color-panel',
        swatches: PIECE_OUTLINE_COLOR_PRESETS,
        selectedId: options.selectedId,
        onSelect: options.onSelect,
        columnCount: 20,
    });
    return () => picker.dispose();
}
