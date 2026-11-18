import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CURRENT_TRACE_SET_VERSION } from '../puzzle/composable/traces/trace-set-version.js';
import type { GenerationRequest } from './generation-core.js';

const TRACED_CLASSIC: GenerationRequest = {
    cutStyle: 'classic',
    classicConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION },
    gridSize: { cols: 4, rows: 3 },
    imageSize: { width: 1080, height: 720 },
    seed: 42,
    tabDebug: false,
};

const SOURCES = import.meta.glob<string>(
    ['/src/**/*.ts', '!/src/**/*.test.ts', '!/src/test-helpers/**'],
    { query: '?raw', import: 'default', eager: true },
);

function filesMentioning(needle: string): string[] {
    return Object.entries(SOURCES)
        .filter(([, text]) => text.includes(needle))
        .map(([path]) => path.replace(/^\//, ''))
        .sort();
}

// Each test takes its modules from dynamic imports after this reset, so the
// loader's filled slot never leaks between tests or depends on their order.
beforeEach(() => {
    vi.resetModules();
});

describe('worker-traced-tabs', () => {
    it('keeps the registry entry on the stub, so both threads dispatch the same way', async () => {
        const { getTabGenerator } = await import('../puzzle/topology/generator-registry.js');
        const { tracedTabGeneratorStub } = await import('../puzzle/topology/traced-tab-loader.js');
        await import('./worker-traced-tabs.js');
        expect(getTabGenerator('traced')).toBe(tracedTabGeneratorStub);
    });

    it('lets the worker handler generate a traced request with no chunk load', async () => {
        const { handleGenerationRequest } = await import('./generation-worker-core.js');
        expect(handleGenerationRequest(TRACED_CLASSIC)).toMatchObject({ ok: false, kind: 'infrastructure' });

        await import('./worker-traced-tabs.js');
        const response = handleGenerationRequest(TRACED_CLASSIC);
        expect(response.ok).toBe(true);
        if (response.ok) expect(response.result.pieces).toHaveLength(12);
    });

    it('is the only non-test source that statically imports the traced generator', () => {
        expect(filesMentioning("traced-tab-generator.js'")).toEqual([
            'src/game/worker-traced-tabs.ts',
            'src/puzzle/topology/traced-tab-loader.ts',
        ]);
        expect(filesMentioning("worker-traced-tabs.js'")).toEqual(['src/game/generation-worker.ts']);
    });

    it('keeps the modules that hold the trace data behind the traced generator', () => {
        expect(filesMentioning("traces/index.js'")).toEqual([
            'src/puzzle/composable/tab-shapes-traced.ts',
            'src/puzzle/topology/traced-tab-generator.ts',
        ]);
        expect(filesMentioning("tab-shapes-traced.js'")).toEqual([
            'src/puzzle/topology/traced-tab-generator.ts',
        ]);
    });
});
