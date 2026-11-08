import { createToolbarButton } from './toolbar-button.js';

export interface HelpButtonOptions {
    container: HTMLElement;
    onShowHelp: () => void;
}

export function createHelpButton(options: HelpButtonOptions): () => void {
    return createToolbarButton({
        container: options.container,
        className: 'help-button',
        label: '❓',
        title: 'Help',
        onClick: options.onShowHelp,
    });
}
