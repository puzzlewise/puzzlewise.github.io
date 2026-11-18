import { describe, it, expect, afterEach } from 'vitest';

import { tracedTabGeneratorStub } from '../puzzle/topology/traced-tab-loader.js';
import { registerTabGenerator } from '../puzzle/topology/generator-registry.js';
import { classicTabGenerator } from '../puzzle/topology/classic-tab-generator.js';
import { handleGenerationRequest } from './generation-worker-core.js';
import type { GenerationRequest } from './generation-core.js';

const LEGACY_CLASSIC: GenerationRequest = {
    cutStyle: 'classic',
    gridSize: { cols: 4, rows: 3 },
    imageSize: { width: 1080, height: 720 },
    seed: 42,
    tabDebug: false,
};

const TRACED: GenerationRequest = { ...LEGACY_CLASSIC, cutStyle: 'triangles' };

/**
 * Stand in for the generator the lazy chunk registers under `'traced'`, so a
 * test can exercise the happy traced path without the trace dataset. Delegates
 * to the classic generator; only the registry id matters here.
 */
function registerTracedStandIn(): void {
    registerTabGenerator({ ...classicTabGenerator, id: 'traced' });
}

afterEach(() => {
    // The registry is module state shared by every test in this file.
    registerTabGenerator(tracedTabGeneratorStub);
});

describe('handleGenerationRequest', () => {
    it('generates a legacy classic request', () => {
        const response = handleGenerationRequest(LEGACY_CLASSIC);
        expect(response.ok).toBe(true);
        if (response.ok) expect(response.result.pieces).toHaveLength(12);
    });

    it('generates a traced request once a traced generator is registered', () => {
        registerTracedStandIn();
        const response = handleGenerationRequest(TRACED);
        expect(response.ok).toBe(true);
        if (response.ok) expect(response.result.pieces.length).toBeGreaterThan(0);
    });

    it('reports an unloaded traced library as infrastructure, not generation', () => {
        // The failure mode if the worker entry loses its static import of the
        // traced generator. `'infrastructure'`, though the throw came from
        // `runGeneration`: the generator is missing from THIS realm, and the
        // main-thread fallback (which loads its own copy) succeeds.
        // `'generation'` would have the client rethrow the one error the
        // fallback exists to rescue.
        const response = handleGenerationRequest(TRACED);
        expect(response.ok).toBe(false);
        if (!response.ok) {
            expect(response.kind).toBe('infrastructure');
            expect(response.error).toContain('Traced tab library not loaded');
            expect(response.name).toBe('TracedTabLibraryNotLoadedError');
        }
    });

    it('reports any other generation throw as a deterministic generation failure', () => {
        // Counterpart to the test above: a throw that IS a function of the
        // request stays `'generation'`, so the client surfaces it rather than
        // paying a second generation to reproduce it.
        registerTabGenerator({
            ...classicTabGenerator,
            id: 'traced',
            generate() { throw new TypeError('x is not a function'); },
        });
        const response = handleGenerationRequest(TRACED);
        expect(response).toEqual({
            ok: false,
            kind: 'generation',
            error: 'x is not a function',
            name: 'TypeError',
        });
    });
});
