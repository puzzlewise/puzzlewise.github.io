/**
 * Photographer credit is required by the Unsplash API guidelines.
 */

import type { ImageAttribution } from '../model/types.js';
import { isSafeHttpUrl } from '../sharing/safe-url.js';

const ATTRIBUTION_CLASS = 'image-attribution';

export function createAttributionElement(
    attribution: ImageAttribution,
    onLinkOpen?: (link: 'photographer' | 'photo') => void,
): HTMLElement {
    const container = document.createElement('div');
    container.className = ATTRIBUTION_CLASS;

    // Defense-in-depth: this href sink is reused beyond the decode path, so a
    // non-http(s) URL is dropped here too rather than smuggling a `javascript:`
    // scheme into the DOM (the anchor renders as plain text).
    const photographerLink = document.createElement('a');
    if (isSafeHttpUrl(attribution.photographerUrl)) {
        photographerLink.href = attribution.photographerUrl;
    }
    photographerLink.target = '_blank';
    photographerLink.rel = 'noopener noreferrer';
    photographerLink.textContent = attribution.photographerName;

    const unsplashLink = document.createElement('a');
    if (isSafeHttpUrl(attribution.photoUrl)) {
        unsplashLink.href = attribution.photoUrl;
    }
    unsplashLink.target = '_blank';
    unsplashLink.rel = 'noopener noreferrer';
    unsplashLink.textContent = 'Unsplash';

    if (onLinkOpen) {
        photographerLink.addEventListener('click', () => onLinkOpen('photographer'));
        unsplashLink.addEventListener('click', () => onLinkOpen('photo'));
    }

    container.appendChild(document.createTextNode('Photo by '));
    container.appendChild(photographerLink);
    container.appendChild(document.createTextNode(' on '));
    container.appendChild(unsplashLink);

    return container;
}

export function removeAttribution(container: HTMLElement): void {
    const existing = container.querySelector(`.${ATTRIBUTION_CLASS}`);

    if (existing) {
        existing.remove();
    }
}

export function formatAttributionText(attribution: ImageAttribution): string {
    return `Photo by ${attribution.photographerName} on Unsplash`;
}
