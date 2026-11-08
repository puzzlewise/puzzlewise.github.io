import type { GameState } from '../model/types.js';
import {
    buildShareUrl,
    gameStateToPayload,
    hasShareableProgress,
} from '../sharing/index.js';
import { isWebShareAvailable, sharePuzzle } from './share.js';
import { showToast } from './toast.js';
import { track, sanitizeErrorReason } from '../analytics/index.js';
import { loadColorPreference } from './background-color.js';

export function buildShareSection(state: GameState, baseUrl: string): HTMLElement {
    const webShareAvailable = isWebShareAvailable();

    const section = document.createElement('section');
    section.className = 'info-section share-section';

    const h = document.createElement('h3');
    h.textContent = 'Share this puzzle';
    section.appendChild(h);

    const explainer = document.createElement('p');
    explainer.textContent = 'Send this link to share the same puzzle with a friend.';
    section.appendChild(explainer);

    const label = document.createElement('label');
    label.className = 'info-setting-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-checkbox';
    checkbox.dataset.testid = 'share-include-progress';

    const labelText = document.createElement('span');
    labelText.className = 'info-setting-label';
    labelText.textContent = 'Include my current progress';

    label.appendChild(checkbox);
    label.appendChild(labelText);
    section.appendChild(label);

    const hint = document.createElement('p');
    hint.className = 'info-setting-description';
    hint.dataset.testid = 'share-progress-hint';
    section.appendChild(hint);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'share-primary-btn';
    button.dataset.testid = 'share-primary-btn';
    button.textContent = webShareAvailable ? 'Share\u2026' : 'Copy link';
    section.appendChild(button);

    // <input readonly> (not a <div>) gives Chrome Android a long-press "Copy"
    // toolbar; auto-select on focus so one tap selects the whole URL.
    const preview = document.createElement('input');
    preview.type = 'text';
    preview.readOnly = true;
    preview.className = 'share-url-preview';
    preview.dataset.testid = 'share-url-preview';
    preview.addEventListener('focus', () => preview.select());
    section.appendChild(preview);

    const progressAvailable = hasShareableProgress(state);
    const completed = state.completed;
    if (!progressAvailable && completed) {
        checkbox.disabled = true;
        hint.textContent = 'Puzzle is already complete.';
    } else if (!progressAvailable) {
        checkbox.disabled = true;
        hint.textContent = 'Make some progress first, then you can share it.';
    } else {
        checkbox.disabled = false;
        hint.textContent = 'Off by default. Turning this on makes the link longer.';
    }

    function currentUrl(): string {
        const payload = gameStateToPayload(state, {
            includeProgress: checkbox.checked && !checkbox.disabled,
            backgroundColorId: loadColorPreference(),
        });
        return buildShareUrl(baseUrl, payload);
    }

    function refreshPreview(): void {
        preview.value = currentUrl();
    }
    refreshPreview();
    checkbox.addEventListener('change', refreshPreview);

    button.addEventListener('click', () => {
        const includesProgress = checkbox.checked && !checkbox.disabled;
        track('puzzle-shared', { source: 'help-modal', includesProgress });
        void sharePuzzle({
            url: currentUrl(),
            title: 'Puzzle',
            text: 'Have a go at this puzzle!',
            onClipboardFallback: () => showToast('Link copied to clipboard'),
            onError: (e) => {
                track('share-failed', {
                    source: 'help-modal',
                    reason: sanitizeErrorReason(e),
                });
                showToast(`Couldn't share: ${e.message}`);
            },
        });
    });

    return section;
}
