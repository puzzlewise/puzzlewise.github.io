/**
 * The game-start trigger: every tile and action button fires `onPick` and the
 * dialog dismisses itself. There is no selected state.
 */

import { isSafeHttpUrl } from '../sharing/safe-url.js';
import { CANDIDATE_COUNT, type CandidateFetchResult, type CandidateImage } from '../images/index.js';

export type NewGameImageChoice =
    | { kind: 'photo'; photo: CandidateImage; slot: number }
    | { kind: 'surprise' }
    | { kind: 'blank' };

export interface ImagePickerOptions {
    /**
     * Absent when no image proxy is configured — the grid and refresh button
     * are then hidden, leaving only Surprise me / Blank puzzle.
     */
    fetchCandidates?: (trigger: CandidateTrigger) => Promise<CandidateFetchResult>;
    onPick: (choice: NewGameImageChoice) => void;
    onThumbnailLoad?: (slot: number) => void;
    onThumbnailError?: (slot: number, candidate: CandidateImage) => void;
    onCreditOpen?: (candidate: CandidateImage) => void;
}

export type CandidateTrigger = 'open' | 'refresh' | 'options';

export interface ImagePicker {
    element: HTMLElement;
    refresh(trigger: 'refresh' | 'options'): void;
}

export function createImagePicker(options: ImagePickerOptions): ImagePicker {
    const section = document.createElement('div');
    section.className = 'image-picker';

    const header = document.createElement('div');
    header.className = 'image-picker-header';

    const heading = document.createElement('h3');
    heading.className = 'size-picker-subtitle';
    heading.textContent = 'Pick an image to start';
    header.appendChild(heading);

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'image-picker-refresh';
    refreshButton.dataset.testid = 'image-picker-refresh';
    refreshButton.title = 'Show different images';
    refreshButton.setAttribute('aria-label', 'Show different images');
    refreshButton.textContent = '↻';
    refreshButton.addEventListener('click', () => refresh('refresh'));
    header.appendChild(refreshButton);

    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'image-picker-grid';
    interface Slot {
        cell: HTMLDivElement;
        tile: HTMLButtonElement;
        credit: HTMLAnchorElement;
    }
    const slots: Slot[] = [];
    for (let i = 0; i < CANDIDATE_COUNT; i++) {
        const cell = document.createElement('div');
        cell.className = 'image-picker-cell';

        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'image-picker-tile';
        tile.dataset.testid = 'image-picker-tile';
        tile.disabled = true;
        cell.appendChild(tile);

        // A link inside a button is invalid HTML, so the credit is a sibling of
        // the tile — outside its tap target, so clicking it never starts a game.
        const credit = document.createElement('a');
        credit.className = 'image-picker-credit';
        credit.dataset.testid = 'image-picker-credit';
        credit.target = '_blank';
        credit.rel = 'noopener';
        credit.hidden = true;
        cell.appendChild(credit);

        slots.push({ cell, tile, credit });
        grid.appendChild(cell);
    }
    section.appendChild(grid);

    const error = document.createElement('p');
    error.className = 'image-picker-error';
    error.textContent = "Couldn't load images — tap ↻ to try again.";
    error.hidden = true;
    error.setAttribute('aria-live', 'polite');
    section.appendChild(error);

    const actions = document.createElement('div');
    actions.className = 'image-picker-actions';

    const surpriseButton = document.createElement('button');
    surpriseButton.type = 'button';
    surpriseButton.className = 'image-picker-action';
    surpriseButton.dataset.testid = 'image-picker-surprise';
    surpriseButton.textContent = '🎲 Surprise me';
    surpriseButton.addEventListener('click', () => options.onPick({ kind: 'surprise' }));
    actions.appendChild(surpriseButton);

    const blankButton = document.createElement('button');
    blankButton.type = 'button';
    blankButton.className = 'image-picker-action';
    blankButton.dataset.testid = 'image-picker-blank';
    blankButton.textContent = 'Blank puzzle';
    blankButton.addEventListener('click', () => options.onPick({ kind: 'blank' }));
    actions.appendChild(blankButton);

    section.appendChild(actions);

    // Stale-response guard: each refresh bumps the token; only the newest
    // in-flight fetch may apply its result, so a slow superseded response is dropped.
    let fetchToken = 0;

    function hideCredit(credit: HTMLAnchorElement): void {
        credit.hidden = true;
        credit.removeAttribute('href');
        credit.textContent = '';
    }

    function setLoading(): void {
        error.hidden = true;
        for (const { cell, tile, credit } of slots) {
            cell.hidden = false;
            tile.replaceChildren();
            tile.disabled = true;
            tile.classList.add('image-picker-tile--loading');
            hideCredit(credit);
        }
    }

    function showCandidates(candidates: CandidateImage[]): void {
        for (let i = 0; i < slots.length; i++) {
            const { cell, tile, credit } = slots[i];
            const candidate = candidates[i];
            tile.replaceChildren();
            tile.classList.remove('image-picker-tile--loading');

            // Unsplash may return fewer photos than requested; hide the empty slots.
            if (!candidate) {
                cell.hidden = true;
                tile.disabled = true;
                hideCredit(credit);
                continue;
            }

            cell.hidden = false;
            tile.disabled = false;

            const img = document.createElement('img');
            img.className = 'image-picker-thumb';
            img.src = candidate.thumbUrl;
            img.alt = candidate.description ?? 'Puzzle image';
            img.draggable = false;
            img.addEventListener('load', () => options.onThumbnailLoad?.(i));
            img.addEventListener('error', () => options.onThumbnailError?.(i, candidate));
            tile.appendChild(img);

            // Property assignment (not addEventListener) so each refresh replaces
            // the previous handler — tiles are reused, so listeners would
            // otherwise accumulate and fire onPick once per stale candidate too.
            // eslint-disable-next-line unicorn/prefer-add-event-listener
            tile.onclick = () => options.onPick({ kind: 'photo', photo: candidate, slot: i });

            // The photographer URL already carries the utm_source=puzzle referral
            // params from the API layer — don't append. Defense-in-depth parity
            // with createAttributionElement: only assign an http(s) href, else
            // the name still renders as text.
            credit.hidden = false;
            if (isSafeHttpUrl(candidate.attribution.photographerUrl)) {
                credit.href = candidate.attribution.photographerUrl;
            } else {
                credit.removeAttribute('href');
            }
            credit.textContent = candidate.attribution.photographerName;
            credit.title = candidate.attribution.photographerName;
            // eslint-disable-next-line unicorn/prefer-add-event-listener
            credit.onclick = () => options.onCreditOpen?.(candidate);
        }
    }

    function showError(): void {
        error.hidden = false;
        for (const { tile, credit } of slots) {
            tile.replaceChildren();
            tile.classList.remove('image-picker-tile--loading');
            tile.disabled = true;
            hideCredit(credit);
        }
    }

    function refresh(trigger: CandidateTrigger): void {
        const fetchCandidates = options.fetchCandidates;
        if (!fetchCandidates) return;

        const token = ++fetchToken;
        setLoading();
        fetchCandidates(trigger).then(
            ({ candidates }) => {
                if (token !== fetchToken) return;
                if (candidates.length === 0) {
                    showError();
                    return;
                }
                showCandidates(candidates);
            },
            () => {
                if (token === fetchToken) showError();
            },
        );
    }

    if (options.fetchCandidates) {
        refresh('open');
    } else {
        grid.hidden = true;
        refreshButton.hidden = true;
    }

    return { element: section, refresh };
}
