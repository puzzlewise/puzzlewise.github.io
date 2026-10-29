/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ImageAttribution } from '../model/types.js';
import {
    createAttributionElement,
    removeAttribution,
    formatAttributionText,
} from './attribution.js';

const testAttribution: ImageAttribution = {
    photographerName: 'Jane Doe',
    photographerUrl: 'https://unsplash.com/@janedoe?utm_source=puzzle&utm_medium=referral',
    photoUrl: 'https://unsplash.com/photos/abc?utm_source=puzzle&utm_medium=referral',
};

describe('createAttributionElement', () => {
    it('creates a div with the attribution class', () => {
        const el = createAttributionElement(testAttribution);

        expect(el.tagName).toBe('DIV');
        expect(el.className).toBe('image-attribution');
    });

    it('contains a link to the photographer', () => {
        const el = createAttributionElement(testAttribution);
        const links = el.querySelectorAll('a');

        const photographerLink = links[0];
        expect(photographerLink.href).toBe(testAttribution.photographerUrl);
        expect(photographerLink.textContent).toBe('Jane Doe');
        expect(photographerLink.target).toBe('_blank');
        expect(photographerLink.rel).toBe('noopener noreferrer');
    });

    it('contains a link to Unsplash', () => {
        const el = createAttributionElement(testAttribution);
        const links = el.querySelectorAll('a');

        const unsplashLink = links[1];
        expect(unsplashLink.href).toBe(testAttribution.photoUrl);
        expect(unsplashLink.textContent).toBe('Unsplash');
        expect(unsplashLink.target).toBe('_blank');
        expect(unsplashLink.rel).toBe('noopener noreferrer');
    });

    it('renders "Photo by {name} on Unsplash" format', () => {
        const el = createAttributionElement(testAttribution);

        expect(el.textContent).toBe('Photo by Jane Doe on Unsplash');
    });

    it('drops a javascript:-scheme href instead of rendering it', () => {
        const el = createAttributionElement({
            photographerName: 'Jane Doe',
            photographerUrl: 'javascript:alert(1)',
            photoUrl: 'javascript:alert(2)',
        });
        const links = el.querySelectorAll('a');

        // href left unset, so no javascript: URL reaches the DOM.
        expect(links[0].getAttribute('href')).toBeNull();
        expect(links[1].getAttribute('href')).toBeNull();
        expect(el.textContent).toBe('Photo by Jane Doe on Unsplash');
    });
});

describe('removeAttribution', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
    });

    it('removes an existing attribution element', () => {
        const el = createAttributionElement(testAttribution);
        container.appendChild(el);
        expect(container.querySelector('.image-attribution')).not.toBeNull();

        removeAttribution(container);
        expect(container.querySelector('.image-attribution')).toBeNull();
    });

    it('does nothing when no attribution exists', () => {
        expect(() => removeAttribution(container)).not.toThrow();
    });

    it('leaves other children intact', () => {
        const other = document.createElement('span');
        other.textContent = 'keep me';
        container.appendChild(other);

        const el = createAttributionElement(testAttribution);
        container.appendChild(el);

        removeAttribution(container);

        expect(container.children).toHaveLength(1);
        expect(container.querySelector('span')!.textContent).toBe('keep me');
    });
});

describe('formatAttributionText', () => {
    it('formats photographer name into attribution text', () => {
        const text = formatAttributionText(testAttribution);

        expect(text).toBe('Photo by Jane Doe on Unsplash');
    });

    it('handles names with special characters', () => {
        const text = formatAttributionText({
            ...testAttribution,
            photographerName: 'José García-López',
        });

        expect(text).toBe('Photo by José García-López on Unsplash');
    });
});

describe('createAttributionElement link taps', () => {
    const attribution: ImageAttribution = {
        photographerName: 'Ada',
        photographerUrl: 'https://unsplash.com/@ada',
        photoUrl: 'https://unsplash.com/photos/abc123',
    };

    it.each([
        [0, 'photographer'],
        [1, 'photo'],
    ] as const)('reports link %i as %s without preventing navigation', (index, link) => {
        const onLinkOpen = vi.fn();
        const el = createAttributionElement(attribution, onLinkOpen);
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });

        el.querySelectorAll('a')[index].dispatchEvent(event);

        expect(onLinkOpen).toHaveBeenCalledWith(link);
        expect(event.defaultPrevented).toBe(false);
    });
});
