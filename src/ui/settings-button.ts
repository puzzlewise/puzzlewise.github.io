import { createToolbarButton } from './toolbar-button.js';

export interface SettingsButtonOptions {
    container: HTMLElement;
    onShowSettings: () => void;
}

export function createSettingsButton(options: SettingsButtonOptions): () => void {
    return createToolbarButton({
        container: options.container,
        className: 'settings-button',
        label: '⚙️',
        title: 'Settings',
        onClick: options.onShowSettings,
    });
}
