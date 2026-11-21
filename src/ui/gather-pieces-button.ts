import { createToolbarButton } from './toolbar-button.js';
import { createGatherPiecesIcon } from './tool-icons.js';

export interface GatherPiecesButtonOptions {
    container: HTMLElement;
    onGatherPieces: () => void;
}

export function createGatherPiecesButton(
    options: GatherPiecesButtonOptions,
): () => void {
    return createToolbarButton({
        container: options.container,
        className: 'gather-pieces-button',
        label: 'Gather Pieces',
        icon: createGatherPiecesIcon(),
        onClick: options.onGatherPieces,
    });
}
