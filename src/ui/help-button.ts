import { createToolbarButton } from './toolbar-button.js';
import { createHelpIcon } from './tool-icons.js';

export interface HelpButtonOptions {
    container: HTMLElement;
    onShowHelp: () => void;
}

export function createHelpButton(options: HelpButtonOptions): () => void {
    return createToolbarButton({
        container: options.container,
        className: 'help-button',
        label: 'Help',
        icon: createHelpIcon(),
        onClick: options.onShowHelp,
    });
}
