import { describe, it, expect } from 'vitest';
import { CURRENT_TRACE_SET_VERSION } from '../puzzle/composable/traces/trace-set-version.js';
import { generatorConfigsForNewGame } from './generator-configs.js';

describe('generatorConfigsForNewGame', () => {
    it('stamps the current trace-set version on a fresh Wavy game', () => {
        expect(generatorConfigsForNewGame({
            cutStyle: 'wavy',
            wavyConfig: { borderless: true },
            forceLegacyClassic: false,
        })).toEqual({
            wavyConfig: { borderless: true, traceSetVersion: CURRENT_TRACE_SET_VERSION },
        });
    });

    it('defaults Wavy borderless to false when the dialog supplied no config', () => {
        const configs = generatorConfigsForNewGame({ cutStyle: 'wavy', forceLegacyClassic: false });
        expect(configs.wavyConfig).toEqual({
            borderless: false,
            traceSetVersion: CURRENT_TRACE_SET_VERSION,
        });
    });

    it('stamps Triangles too', () => {
        expect(generatorConfigsForNewGame({ cutStyle: 'triangles', forceLegacyClassic: false }))
            .toEqual({ trianglesConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION } });
    });

    it('stamps Classic on an ordinary start', () => {
        expect(generatorConfigsForNewGame({ cutStyle: 'classic', forceLegacyClassic: false }))
            .toEqual({ classicConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION } });
    });

    it('withholds classicConfig when legacy Classic is forced', () => {
        expect(generatorConfigsForNewGame({ cutStyle: 'classic', forceLegacyClassic: true }))
            .toEqual({});
    });

    it('passes fractal borderless through regardless of cut style', () => {
        expect(generatorConfigsForNewGame({
            cutStyle: 'classic',
            fractalConfig: { borderless: true },
            forceLegacyClassic: false,
        })).toEqual({
            fractalConfig: { borderless: true },
            classicConfig: { traceSetVersion: CURRENT_TRACE_SET_VERSION },
        });
    });

    it('stamps nothing for a Composable game', () => {
        expect(generatorConfigsForNewGame({ cutStyle: 'composable', forceLegacyClassic: false }))
            .toEqual({});
    });
});
