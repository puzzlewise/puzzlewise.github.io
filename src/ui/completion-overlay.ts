import type { GameState } from '../model/types.js';
import { gameStateToPayload, buildShareUrl } from '../sharing/index.js';
import { track, sanitizeErrorReason } from '../analytics/index.js';
import { createDismissableOverlay } from './dismissable-overlay.js';
import { sharePuzzle } from './share.js';
import { showToast } from './toast.js';
import { loadColorPreference } from './background-color.js';

export interface CompletionOverlayOptions {
    /** Also receives the glow class. */
    container: HTMLElement;
    state: GameState;
    /**
     * Fires when the user dismisses, not when the caller invokes the returned
     * `hide`.
     */
    onDismiss?: () => void;
}

export function showCompletionOverlay(
    opts: CompletionOverlayOptions,
): () => void {
    const { container, state, onDismiss } = opts;

    container.classList.add('completion-glow');

    function cleanup(): void {
        container.classList.remove('completion-glow');
    }

    const handle = createDismissableOverlay({
        container,
        className: 'completion-overlay',
        dismissOn: 'any-click',
        onDismiss: () => {
            cleanup();
            onDismiss?.();
        },
    });

    const message = document.createElement('div');
    message.className = 'completion-message';

    const heading = document.createElement('h1');
    heading.textContent = '🧩 Puzzle Complete!';
    message.appendChild(heading);

    const wellDone = document.createElement('p');
    wellDone.textContent = 'Well done!';
    message.appendChild(wellDone);

    const challengeBtn = document.createElement('button');
    challengeBtn.type = 'button';
    challengeBtn.className = 'completion-share-btn';
    challengeBtn.textContent = 'Challenge a friend — share this puzzle!';
    challengeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        track('puzzle-shared', { source: 'completion-overlay', includesProgress: false });
        const payload = gameStateToPayload(state, {
            includeProgress: false,
            backgroundColorId: loadColorPreference(),
        });
        const url = buildShareUrl(window.location.href, payload);
        void sharePuzzle({
            url,
            title: 'Puzzle',
            text: 'I finished this puzzle — can you?',
            onClipboardFallback: () => showToast('Link copied to clipboard'),
            onError: (err) => {
                track('share-failed', {
                    source: 'completion-overlay',
                    reason: sanitizeErrorReason(err),
                });
                showToast(`Couldn't share: ${err.message}`);
            },
        });
    });
    message.appendChild(challengeBtn);

    const dismissHint = document.createElement('p');
    dismissHint.className = 'completion-dismiss-hint';
    dismissHint.textContent = 'Tap anywhere to dismiss';
    message.appendChild(dismissHint);

    handle.overlay.appendChild(message);

    let hidden = false;
    return function hide(): void {
        if (hidden) return;
        hidden = true;
        handle.dismiss();
        cleanup();
    };
}
