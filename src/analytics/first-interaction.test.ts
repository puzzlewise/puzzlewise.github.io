/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./umami.js', () => ({
    track: vi.fn(),
    whenAnalyticsReady: vi.fn((send: () => void) => send()),
}));

import { track, whenAnalyticsReady } from './umami.js';
import { installFirstInteractionTracking } from './first-interaction.js';
import { markPuzzleTable } from '../renderer/puzzle-table.js';

interface FakeEvent {
    type: string;
    isTrusted: boolean;
    target: EventTarget | null;
    pointerType?: string;
}

function fakeSource() {
    const listeners = new Map<string, EventListener>();
    return {
        addEventListener: vi.fn((type: string, listener: EventListener) => {
            listeners.set(type, listener);
        }),
        removeEventListener: vi.fn((type: string, listener: EventListener) => {
            if (listeners.get(type) === listener) listeners.delete(type);
        }),
        fire(event: FakeEvent) {
            listeners.get(event.type)?.(event as unknown as Event);
        },
        listenerCount: () => listeners.size,
    };
}

describe('installFirstInteractionTracking', () => {
    let table: HTMLElement;
    let button: HTMLElement;

    beforeEach(() => {
        vi.clearAllMocks();
        table = document.createElement('div');
        markPuzzleTable(table);
        const inner = document.createElement('canvas');
        table.appendChild(inner);
        button = document.createElement('button');
        document.body.replaceChildren(table, button);
    });

    it('listens in the capture phase so app handlers cannot hide the event', () => {
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 0);
        for (const type of ['pointerdown', 'keydown']) {
            expect(source.addEventListener).toHaveBeenCalledWith(
                type,
                expect.any(Function),
                expect.objectContaining({ capture: true }),
            );
        }
    });

    it('reports a pointer press on the puzzle table', () => {
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 1234.6);
        source.fire({
            type: 'pointerdown', isTrusted: true, target: table.firstElementChild, pointerType: 'touch',
        });
        expect(track).toHaveBeenCalledWith('first-interaction', {
            input: 'touch', target: 'table', msSinceLoad: 1235,
        });
    });

    it('reports a key press outside the table as ui', () => {
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 10);
        source.fire({ type: 'keydown', isTrusted: true, target: button });
        expect(track).toHaveBeenCalledWith('first-interaction', {
            input: 'key', target: 'ui', msSinceLoad: 10,
        });
    });

    it.each(['', 'eraser'])('reports pointer type %j as unknown', (pointerType) => {
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 0);
        source.fire({ type: 'pointerdown', isTrusted: true, target: button, pointerType });
        expect(track).toHaveBeenCalledWith('first-interaction', expect.objectContaining({ input: 'unknown' }));
    });

    it.each(['mouse', 'pen'])('reports pointer type %s as itself', (pointerType) => {
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 0);
        source.fire({ type: 'pointerdown', isTrusted: true, target: button, pointerType });
        expect(track).toHaveBeenCalledWith('first-interaction', expect.objectContaining({ input: pointerType }));
    });

    it('ignores untrusted events and keeps listening', () => {
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 0);
        source.fire({ type: 'pointerdown', isTrusted: false, target: table, pointerType: 'mouse' });
        expect(track).not.toHaveBeenCalled();
        expect(source.listenerCount()).toBe(2);
    });

    it('reports once per page load and removes both listeners', () => {
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 0);
        source.fire({ type: 'pointerdown', isTrusted: true, target: table, pointerType: 'mouse' });
        source.fire({ type: 'keydown', isTrusted: true, target: button });
        source.fire({ type: 'pointerdown', isTrusted: true, target: table, pointerType: 'mouse' });
        expect(track).toHaveBeenCalledTimes(1);
        expect(source.listenerCount()).toBe(0);
    });

    it('defers the send until the tracker is ready', () => {
        vi.mocked(whenAnalyticsReady).mockImplementationOnce(() => {});
        const source = fakeSource();
        installFirstInteractionTracking(source, () => 0);
        source.fire({ type: 'keydown', isTrusted: true, target: button });
        expect(whenAnalyticsReady).toHaveBeenCalledTimes(1);
        expect(track).not.toHaveBeenCalled();
    });
});
