/**
 * For simple stateless buttons only — buttons owning their own state (visibility,
 * paired controls, confirm dialogs) need more than this helper covers.
 */

export interface ToolbarButtonOptions {
    container: HTMLElement;
    className: string;
    /** The button shows only `icon`; this is its accessible name and tooltip. */
    label: string;
    icon: SVGElement;
    onClick: () => void;
}

export function createToolbarButton(options: ToolbarButtonOptions): () => void {
    const { container, className, label, icon, onClick } = options;

    const button = document.createElement('button');
    button.className = className;
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(icon);

    button.addEventListener('click', onClick);
    container.appendChild(button);

    return () => {
        button.removeEventListener('click', onClick);
        button.remove();
    };
}
