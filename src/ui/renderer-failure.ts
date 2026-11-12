import { createDismissableOverlay } from './dismissable-overlay.js';

export type RendererFailureKind = 'unsupported' | 'lost';

const MESSAGE_ID = 'renderer-failure-message';

const MESSAGES: Record<RendererFailureKind, string> = {
    unsupported: "Puzzlewise needs WebGL 2, which this browser doesn't support.",
    lost: 'Graphics stopped working.',
};

export function showRendererFailure(
    container: HTMLElement,
    kind: RendererFailureKind,
    reload: () => void = () => location.reload(),
): void {
    const { overlay } = createDismissableOverlay({
        container,
        className: 'renderer-failure-overlay',
        dismissOn: 'none',
        dismissOnEscape: false,
    });

    const dialog = document.createElement('div');
    dialog.className = 'renderer-failure-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-label', 'Graphics problem');
    dialog.setAttribute('aria-describedby', MESSAGE_ID);

    const body = document.createElement('p');
    body.id = MESSAGE_ID;
    body.className = 'renderer-failure-body';
    body.textContent = MESSAGES[kind];
    dialog.appendChild(body);

    if (kind === 'lost') {
        const buttons = document.createElement('div');
        buttons.className = 'renderer-failure-buttons';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'renderer-failure-btn renderer-failure-btn--primary';
        button.textContent = 'Reload';
        button.addEventListener('click', () => reload());
        buttons.appendChild(button);
        dialog.appendChild(buttons);
    }

    overlay.appendChild(dialog);
    dialog.querySelector('button')?.focus();
}
