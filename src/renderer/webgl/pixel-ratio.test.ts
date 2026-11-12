/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { watchDevicePixelRatio } from './pixel-ratio.js';

interface FakeQuery {
    media: string;
    listeners: Set<() => void>;
}

function stubMatchMedia(): FakeQuery[] {
    const queries: FakeQuery[] = [];
    vi.stubGlobal('matchMedia', (media: string) => {
        const query: FakeQuery = { media, listeners: new Set() };
        queries.push(query);
        return {
            media,
            addEventListener: (_type: string, listener: () => void) => query.listeners.add(listener),
            removeEventListener: (_type: string, listener: () => void) => query.listeners.delete(listener),
        };
    });
    return queries;
}

function setRatio(ratio: number): void {
    Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true });
}

describe('watchDevicePixelRatio', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        setRatio(1);
    });

    test('calls back when the ratio changes and re-arms for the new ratio', () => {
        const queries = stubMatchMedia();
        setRatio(1);
        const onChange = vi.fn();
        watchDevicePixelRatio(onChange);
        expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)']);

        setRatio(2);
        for (const listener of queries[0].listeners) listener();

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(queries[0].listeners.size).toBe(0);
        expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)']);
        expect(queries[1].listeners.size).toBe(1);
    });

    test('the returned stop releases the armed listener', () => {
        const queries = stubMatchMedia();
        const stop = watchDevicePixelRatio(vi.fn());

        stop();

        expect(queries[0].listeners.size).toBe(0);
    });
});
