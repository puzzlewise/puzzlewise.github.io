/**
 * Color-source agnostic (swatches passed as data), so it backs both the
 * background and piece-outline color pickers.
 */

import { attachDismissablePopover } from './dismissable-overlay.js';

/**
 * All fields must be caller-trusted: `color` → `style.backgroundColor`, `label` →
 * `aria-label`/`title`. Never pass untrusted strings.
 */
export interface SwatchEntry {
    id: string;
    label: string;
    color: string;
}

export interface SwatchPickerOptions {
    container: HTMLElement;
    /** `className` positions the button. */
    button: { icon: string; title: string; className: string };
    ariaLabel: string;
    /**
     * Extra class on the grid panel (alongside `swatch-grid`), positioning it
     * against the `.swatch-anchor` around the button.
     */
    panelClassName?: string;
    swatches: readonly SwatchEntry[];
    selectedId: string;
    onSelect: (id: string) => void;
    columnCount?: number;
}

const DEFAULT_COLUMNS = 20;

export function createSwatch(
    entry: SwatchEntry,
    isSelected: boolean,
): HTMLButtonElement {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    swatch.type = 'button';
    swatch.style.backgroundColor = entry.color;
    swatch.setAttribute('role', 'option');
    swatch.setAttribute('aria-label', entry.label);
    swatch.setAttribute('aria-selected', String(isSelected));
    swatch.title = entry.label;
    swatch.dataset.swatchId = entry.id;

    if (isSelected) {
        swatch.classList.add('swatch--selected');
    }

    return swatch;
}

export function createSwatchGrid(
    swatches: readonly SwatchEntry[],
    selectedId: string,
    onSelect: (id: string) => void,
    onDismiss: () => void,
    opts: { ariaLabel: string; columnCount?: number; panelClassName?: string },
): HTMLDivElement {
    const grid = document.createElement('div');
    grid.className = opts.panelClassName
        ? `swatch-grid ${opts.panelClassName}`
        : 'swatch-grid';
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-label', opts.ariaLabel);
    grid.style.setProperty(
        '--swatch-columns',
        String(opts.columnCount ?? DEFAULT_COLUMNS),
    );

    for (const entry of swatches) {
        const swatch = createSwatch(entry, entry.id === selectedId);
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            onSelect(entry.id);
            onDismiss();
        });
        grid.appendChild(swatch);
    }

    return grid;
}

export interface SwatchPickerHandle {
    /**
     * Update the highlighted swatch for an external selection change. Does NOT fire
     * `onSelect`; dismisses any open panel (the grid rebuilds from the current id
     * on next open).
     */
    setSelected: (id: string) => void;
    dispose: () => void;
}

export function createSwatchPicker(options: SwatchPickerOptions): SwatchPickerHandle {
    const { container, swatches, onSelect, ariaLabel, columnCount, panelClassName } =
        options;
    let currentId = options.selectedId;

    const anchor = document.createElement('div');
    anchor.className = 'swatch-anchor';

    const button = document.createElement('button');
    button.className = options.button.className;
    button.type = 'button';
    button.title = options.button.title;
    button.setAttribute('aria-label', options.button.title);
    button.textContent = options.button.icon;

    let grid: HTMLDivElement | null = null;
    let dismissPopover: (() => void) | null = null;

    function dismissPanel(): void {
        if (dismissPopover) {
            dismissPopover();
            dismissPopover = null;
        }
        grid = null;
    }

    function showPanel(): void {
        if (grid) {
            dismissPanel();
            return;
        }

        grid = createSwatchGrid(
            swatches,
            currentId,
            (id) => {
                currentId = id;
                onSelect(id);
            },
            dismissPanel,
            { ariaLabel, columnCount, panelClassName },
        );

        button.after(grid);

        const handle = attachDismissablePopover({
            panel: grid,
            anchor: button,
            onDismiss: () => {
                grid = null;
                dismissPopover = null;
            },
        });
        dismissPopover = handle.dismiss;
    }

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        showPanel();
    });

    anchor.appendChild(button);
    container.appendChild(anchor);

    return {
        setSelected(id) {
            if (id === currentId) return;
            currentId = id;
            dismissPanel();
        },
        dispose() {
            dismissPanel();
            anchor.remove();
        },
    };
}
