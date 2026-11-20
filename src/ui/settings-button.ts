import { createToolbarButton } from './toolbar-button.js';
import { createSettingsIcon } from './tool-icons.js';

export interface SettingsButtonOptions {
    container: HTMLElement;
    onShowSettings: () => void;
}

export function createSettingsButton(options: SettingsButtonOptions): () => void {
    return createToolbarButton({
        container: options.container,
        className: 'settings-button',
        label: 'Settings',
        icon: createSettingsIcon(),
        onClick: options.onShowSettings,
    });
}
