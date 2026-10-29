import { createDismissableOverlay } from './dismissable-overlay.js';

export interface ReceiveMoveScreen {
    showMessage(text: string, onContinue: () => void): void;
}

function moveButton(label: string, primary = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = primary ? 'move-btn move-btn--primary' : 'move-btn';
    button.textContent = label;
    return button;
}

export function createReceiveMoveScreen(container: HTMLElement): ReceiveMoveScreen {
    const { overlay } = createDismissableOverlay({
        container,
        className: 'move-overlay',
        dismissOn: 'none',
        dismissOnEscape: false,
    });

    const dialog = document.createElement('div');
    dialog.className = 'move-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Bringing your puzzle over');

    const title = document.createElement('h2');
    title.className = 'move-title';
    title.textContent = 'Bringing your puzzle over';

    const body = document.createElement('p');
    body.className = 'move-body';
    body.textContent = 'Receiving your puzzle…';

    const buttons = document.createElement('div');
    buttons.className = 'move-buttons';

    dialog.append(title, body, buttons);
    overlay.appendChild(dialog);

    return {
        showMessage(text, onContinue) {
            body.textContent = text;
            const button = moveButton('Continue to Puzzle', true);
            button.addEventListener('click', onContinue);
            buttons.replaceChildren(button);
        },
    };
}
