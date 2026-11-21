/**
 * Pressing it clears the selection but does NOT deactivate the tool.
 */

import type { SelectionManager } from '../interaction/selection-manager.js';
import { createDeselectIcon } from './tool-icons.js';

export interface DeselectButtonOptions {
    container: HTMLElement;
    selectionManager: SelectionManager;
}

export function createDeselectButton(
    options: DeselectButtonOptions,
): () => void {
    const { container, selectionManager } = options;

    const button = document.createElement('button');
    button.className = 'deselect-button';
    button.type = 'button';
    button.setAttribute('aria-label', 'Deselect all pieces');

    button.appendChild(createDeselectIcon());

    button.style.display = 'none';

    function updateVisibility(): void {
        if (selectionManager.hasSelection) {
            button.style.display = '';
        } else {
            button.style.display = 'none';
        }
    }

    function handleClick(): void {
        selectionManager.clearAll();
    }

    button.addEventListener('click', handleClick);

    const removeListener = selectionManager.onChange(() => {
        updateVisibility();
    });

    container.appendChild(button);

    return () => {
        button.removeEventListener('click', handleClick);
        removeListener();
        button.remove();
    };
}
