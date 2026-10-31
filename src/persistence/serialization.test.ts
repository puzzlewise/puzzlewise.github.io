import { describe, it, expect, beforeAll } from 'vitest';
import type { GameState, Piece, PieceGroup } from '../model/types.js';
import { buildShape } from '../model/build-shape.js';
import { formatEdgePath, parseEdgePath } from '../model/edge-path.js';
import { buildPiecesById } from '../model/helpers.js';
import { createNewGame } from '../game/init.js';
import { registerTabGenerator } from '../puzzle/topology/generator-registry.js';
import { tracedTabGenerator } from '../puzzle/topology/traced-tab-generator.js';
import {
    imageSize,
    SEED,
    styles,
    viewport,
    type StyleCase,
} from '../test-helpers/generation-style-cases.js';
import {
    serializeState,
    deserializeState,
    readSelection,
    serializeStatic,
    serializeProgress,
    readViewport,
    recombine,
    STATE_VERSION,
    type SerializedGameState,
    type SerializedStaticState,
    type SerializedProgress,
} from './serialization.js';
import {
    makeRectPiece,
    makeGameState as makeBaseGameState,
} from '../test-helpers/fixtures.js';

function makeStateWith(pieces: Piece[]): GameState {
    return makeBaseGameState({
        pieces,
        groups: [
            {
                id: 0,
                pieces: new Map(pieces.map((p) => [p.id, { x: 0, y: 0 }])),
                position: { x: 0, y: 0 },
                rotation: 0,
            },
        ],
        imageUrl: 'test-image.jpg',
    });
}

function makeGameState(overrides?: Partial<GameState>): GameState {
    const pieces = [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 }), makeRectPiece({ id: 2 })];

    const groups: PieceGroup[] = [
        {
            id: 0,
            pieces: new Map([
                [0, { x: 0, y: 0 }],
                [1, { x: 100, y: 0 }],
            ]),
            position: { x: 50, y: 50 },
            rotation: 0,
        },
        {
            id: 2,
            pieces: new Map([[2, { x: 0, y: 0 }]]),
            position: { x: 300, y: 200 },
            rotation: 0,
        },
    ];

    return makeBaseGameState({
        pieces,
        groups,
        imageUrl: 'test-image.jpg',
        ...overrides,
    });
}

describe('serializeState', () => {
    it('converts Maps to entries arrays', () => {
        const state = makeGameState();
        const serialized = serializeState(state);

        expect(serialized.groups[0].pieces).toEqual([
            [0, { x: 0, y: 0 }],
            [1, { x: 100, y: 0 }],
        ]);
        expect(serialized.groups[1].pieces).toEqual([[2, { x: 0, y: 0 }]]);
    });

    it('includes the state version', () => {
        const state = makeGameState();
        const serialized = serializeState(state);

        expect(serialized.version).toBe(STATE_VERSION);
    });

    it('preserves all scalar fields', () => {
        const state = makeGameState({ completed: true });
        const serialized = serializeState(state);

        expect(serialized.imageUrl).toBe('test-image.jpg');
        expect(serialized.imageSize).toEqual({ width: 800, height: 600 });
        expect(serialized.completed).toBe(true);
        expect(serialized.pieces).toEqual(state.pieces);
    });

    it('preserves group positions', () => {
        const state = makeGameState();
        const serialized = serializeState(state);

        expect(serialized.groups[0].position).toEqual({ x: 50, y: 50 });
        expect(serialized.groups[1].position).toEqual({ x: 300, y: 200 });
    });

    it('omits the selection field when none is passed', () => {
        const state = makeGameState();
        const serialized = serializeState(state);

        expect(serialized.selection).toBeUndefined();
    });

    it('omits the selection field when the selection is empty', () => {
        const state = makeGameState();
        const serialized = serializeState(state, []);

        expect(serialized.selection).toBeUndefined();
    });

    it('includes the selection ids when present', () => {
        const state = makeGameState();
        const serialized = serializeState(state, new Set([2, 0]));

        expect(serialized.selection).toEqual([2, 0]);
    });

    it('produces JSON-safe output', () => {
        const state = makeGameState();
        const serialized = serializeState(state);

        const json = JSON.stringify(serialized);
        const parsed = JSON.parse(json);

        expect(parsed).toEqual(serialized);
    });

    it('includes attribution when present', () => {
        const state = makeGameState({
            attribution: {
                photographerName: 'Test Author',
                photographerUrl: 'https://unsplash.com/@test',
                photoUrl: 'https://unsplash.com/photos/abc',
            },
        });
        const serialized = serializeState(state);

        expect(serialized.attribution).toEqual({
            photographerName: 'Test Author',
            photographerUrl: 'https://unsplash.com/@test',
            photoUrl: 'https://unsplash.com/photos/abc',
        });
    });

    it('omits attribution when not present', () => {
        const state = makeGameState();
        const serialized = serializeState(state);

        expect(serialized.attribution).toBeUndefined();
    });

    it('includes fractalConfig when present', () => {
        const state = makeGameState({
            cutStyle: 'fractal',
            fractalConfig: { borderless: true },
        });
        const serialized = serializeState(state);

        expect(serialized.fractalConfig).toEqual({ borderless: true });
        expect(serialized.composableConfig).toBeUndefined();
    });

    it('includes composableConfig when present', () => {
        const state = makeGameState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.15, vf: 2 },
                tabGenerator: 'classic',
                tabConfig: {},
            },
        });
        const serialized = serializeState(state);

        expect(serialized.composableConfig).toEqual({
            baseCutGenerator: 'sine',
            baseCutConfig: { ha: 0.15, vf: 2 },
            tabGenerator: 'classic',
            tabConfig: {},
        });
        expect(serialized.fractalConfig).toBeUndefined();
    });

    it('omits both cut-style configs when not present', () => {
        const state = makeGameState();
        const serialized = serializeState(state);

        expect(serialized.composableConfig).toBeUndefined();
        expect(serialized.fractalConfig).toBeUndefined();
    });

    it('round-trips composableConfig through serialization', () => {
        const state = makeGameState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.15, vf: 2 },
                tabGenerator: 'classic',
                tabConfig: {},
            },
        });
        const restored = deserializeState(serializeState(state));

        expect(restored.composableConfig).toEqual({
            baseCutGenerator: 'sine',
            baseCutConfig: { ha: 0.15, vf: 2 },
            tabGenerator: 'classic',
            tabConfig: {},
        });
    });

    it('round-trips fractalConfig through serialization', () => {
        const state = makeGameState({
            cutStyle: 'fractal',
            fractalConfig: { borderless: true },
        });
        const restored = deserializeState(serializeState(state));

        expect(restored.fractalConfig).toEqual({ borderless: true });
    });

    it('round-trips composableConfig.borderless', () => {
        const state = makeGameState({
            cutStyle: 'composable',
            composableConfig: {
                baseCutGenerator: 'sine',
                baseCutConfig: { ha: 0.2, hf: 1, va: 0.3, vf: 2 },
                tabGenerator: 'classic',
                tabConfig: {},
                borderless: true,
            },
        });
        const serialized = serializeState(state);
        expect(serialized.composableConfig?.borderless).toBe(true);
    });

    it('round-trips wavyConfig.borderless through serializeState/deserializeState', () => {
        const state = makeGameState({
            cutStyle: 'wavy',
            wavyConfig: { borderless: true },
        });
        const restored = deserializeState(serializeState(state));
        expect(restored.wavyConfig).toEqual({ borderless: true });
    });

    it('round-trips wavyConfig.traceSetVersion through serializeState/deserializeState', () => {
        const state = makeGameState({
            cutStyle: 'wavy',
            wavyConfig: { borderless: false, traceSetVersion: 1 },
        });
        const restored = deserializeState(serializeState(state));
        expect(restored.wavyConfig).toEqual({ borderless: false, traceSetVersion: 1 });
    });

    it('round-trips wavyConfig.traceSetVersion through serializeStatic/recombine', () => {
        const state = makeGameState({
            cutStyle: 'wavy',
            wavyConfig: { borderless: false, traceSetVersion: 1 },
        });
        const restored = recombine(serializeStatic(state), serializeProgress(state));
        expect(restored.wavyConfig).toEqual({ borderless: false, traceSetVersion: 1 });
    });

    it('round-trips trianglesConfig through serializeState/deserializeState', () => {
        const state = makeGameState({
            cutStyle: 'triangles',
            trianglesConfig: { traceSetVersion: 1 },
        });
        const restored = deserializeState(serializeState(state));
        expect(restored.trianglesConfig).toEqual({ traceSetVersion: 1 });
    });

    it('round-trips trianglesConfig through serializeStatic/recombine', () => {
        const state = makeGameState({
            cutStyle: 'triangles',
            trianglesConfig: { traceSetVersion: 1 },
        });
        const restored = recombine(serializeStatic(state), serializeProgress(state));
        expect(restored.trianglesConfig).toEqual({ traceSetVersion: 1 });
    });

    it('round-trips classicConfig through serializeState/deserializeState', () => {
        const restored = deserializeState(serializeState(makeGameState({
            cutStyle: 'classic',
            classicConfig: { traceSetVersion: 1 },
        })));
        expect(restored.classicConfig).toEqual({ traceSetVersion: 1 });
    });

    it('round-trips classicConfig through serializeStatic/recombine', () => {
        const state = makeGameState({
            cutStyle: 'classic',
            classicConfig: { traceSetVersion: 1 },
        });
        const restored = recombine(serializeStatic(state), serializeProgress(state));
        expect(restored.classicConfig).toEqual({ traceSetVersion: 1 });
    });

    it('leaves classicConfig undefined for a legacy classic save', () => {
        const restored = deserializeState(serializeState(makeGameState({
            cutStyle: 'classic',
        })));
        expect(restored.classicConfig).toBeUndefined();
    });
});

describe('deserializeState', () => {
    it('reconstructs Maps from entries arrays', () => {
        const state = makeGameState();
        const serialized = serializeState(state);
        const restored = deserializeState(serialized);

        expect(restored.groups[0].pieces).toBeInstanceOf(Map);
        expect(restored.groups[0].pieces.get(0)).toEqual({ x: 0, y: 0 });
        expect(restored.groups[0].pieces.get(1)).toEqual({ x: 100, y: 0 });
        expect(restored.groups[1].pieces).toBeInstanceOf(Map);
        expect(restored.groups[1].pieces.get(2)).toEqual({ x: 0, y: 0 });
    });

    it('round-trips through JSON faithfully', () => {
        const original = makeGameState();
        const serialized = serializeState(original);
        const json = JSON.stringify(serialized);
        const parsed = JSON.parse(json) as SerializedGameState;
        const restored = deserializeState(parsed);

        expect(restored.pieces).toEqual(original.pieces);

        expect(restored.groups.length).toBe(original.groups.length);

        for (let i = 0; i < original.groups.length; i++) {
            expect(restored.groups[i].id).toBe(original.groups[i].id);
            expect(restored.groups[i].position).toEqual(
                original.groups[i].position,
            );
            expect(Array.from(restored.groups[i].pieces.entries())).toEqual(
                Array.from(original.groups[i].pieces.entries()),
            );
        }

        expect(restored.imageUrl).toBe(original.imageUrl);
        expect(restored.imageSize).toEqual(original.imageSize);
        expect(restored.completed).toBe(original.completed);
    });

    it('round-trips attribution through JSON', () => {
        const original = makeGameState({
            attribution: {
                photographerName: 'Jane Doe',
                photographerUrl: 'https://unsplash.com/@jane',
                photoUrl: 'https://unsplash.com/photos/xyz',
            },
        });

        const serialized = serializeState(original);
        const json = JSON.stringify(serialized);
        const parsed = JSON.parse(json) as SerializedGameState;
        const restored = deserializeState(parsed);

        expect(restored.attribution).toEqual(original.attribution);
    });

    it('migrates v1 state by deriving imageSize from pieces', () => {
        // v1 blob: no imageSize, and no `bounds` (pre-v12). Stripping bounds
        // pins the migrate-before-derive order — deriveImageSize reads
        // piece.bounds, so running on un-migrated pieces would throw.
        const pieces = [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 }), makeRectPiece({ id: 2 })]
            .map(({ bounds: _bounds, ...rest }) => rest);
        const v1Serialized: SerializedGameState = {
            version: 1,
            pieces,
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } },
            ],
            imageUrl: 'old-image.jpg',
            completed: false,
        };

        const restored = deserializeState(v1Serialized);

        expect(restored.imageSize).toBeDefined();
        expect(restored.imageSize.width).toBeGreaterThan(0);
        expect(restored.imageSize.height).toBeGreaterThan(0);
    });

    it('migrates v2 state by defaulting gridSize to 8×6', () => {
        // Simulate a v2 saved state (has imageSize but no gridSize)
        const v2Serialized: SerializedGameState = {
            version: 2,
            pieces: [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } },
                { id: 1, pieces: [[1, { x: 0, y: 0 }]], position: { x: 100, y: 0 } },
            ],
            imageUrl: 'v2-image.jpg',
            imageSize: { width: 800, height: 600 },
            completed: false,
        };

        const restored = deserializeState(v2Serialized);

        expect(restored.gridSize).toEqual({ cols: 8, rows: 6 });
    });

    it('migrates v7 fractal generatorConfig to fractalConfig', () => {
        const v7Serialized: SerializedGameState = {
            version: 7,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } },
            ],
            imageUrl: 'v7-fractal.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            cutStyle: 'fractal',
            rotationMode: 'quarter-turn',
            completed: false,
            generatorConfig: { borderless: true },
        };

        const restored = deserializeState(v7Serialized);

        expect(restored.fractalConfig).toEqual({ borderless: true });
        expect(restored.composableConfig).toBeUndefined();
    });

    it('migrates v7 composable generatorConfig to composableConfig', () => {
        const v7Serialized: SerializedGameState = {
            version: 7,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } },
            ],
            imageUrl: 'v7-composable.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            cutStyle: 'composable',
            rotationMode: 'none',
            completed: false,
            generatorConfig: {
                horizontalAmplitude: 0.2,
                horizontalFrequency: 1.5,
                verticalAmplitude: 0.1,
                verticalFrequency: 2,
                disableTabs: true,
            },
        };

        const restored = deserializeState(v7Serialized);

        // v7 → v10: legacy fields project onto sine baseCutConfig + tabGenerator='none'.
        expect(restored.composableConfig).toEqual({
            baseCutGenerator: 'sine',
            baseCutConfig: { ha: 0.2, hf: 1.5, va: 0.1, vf: 2 },
            tabGenerator: 'none',
            tabConfig: {},
        });
        expect(restored.fractalConfig).toBeUndefined();
    });

    it('migrates v9 composableConfig (legacy long-name fields) to v10 opaque shape', () => {
        const v9Serialized: SerializedGameState = {
            version: 9,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 0 },
            ],
            imageUrl: 'v9-composable.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            cutStyle: 'composable',
            rotationMode: 'none',
            completed: false,
            // Cast: v9 used the legacy long-name shape, but the type advertises
            // the v10 opaque shape; the migration accepts legacy keys at runtime.
            composableConfig: {
                horizontalAmplitude: 0.13,
                horizontalFrequency: 7.1,
                verticalAmplitude: 0.08,
                verticalFrequency: 6.9,
                disableTabs: false,
            } as unknown as GameState['composableConfig'],
        };

        const restored = deserializeState(v9Serialized);

        expect(restored.composableConfig).toEqual({
            baseCutGenerator: 'sine',
            baseCutConfig: { ha: 0.13, hf: 7.1, va: 0.08, vf: 6.9 },
            tabGenerator: 'classic',
            tabConfig: {},
        });
    });

    it('migrates v9 composableConfig with disableTabs: true to tabGenerator: none', () => {
        const v9Serialized: SerializedGameState = {
            version: 9,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 0 },
            ],
            imageUrl: 'v9-composable-no-tabs.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            cutStyle: 'composable',
            rotationMode: 'none',
            completed: false,
            composableConfig: {
                horizontalAmplitude: 0.2,
                horizontalFrequency: 1.5,
                verticalAmplitude: 0.2,
                verticalFrequency: 1.5,
                disableTabs: true,
            } as unknown as GameState['composableConfig'],
        };

        const restored = deserializeState(v9Serialized);

        expect(restored.composableConfig).toEqual({
            baseCutGenerator: 'sine',
            baseCutConfig: { ha: 0.2, hf: 1.5, va: 0.2, vf: 1.5 },
            tabGenerator: 'none',
            tabConfig: {},
        });
    });

    it('ignores v7 generatorConfig for classic puzzles (no typed shape)', () => {
        const v7Serialized: SerializedGameState = {
            version: 7,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } },
            ],
            imageUrl: 'v7-classic.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            cutStyle: 'classic',
            completed: false,
            generatorConfig: { borderless: true },
        };

        const restored = deserializeState(v7Serialized);

        expect(restored.composableConfig).toBeUndefined();
        expect(restored.fractalConfig).toBeUndefined();
    });

    it('defaults rotation to 0 when missing (v5 → v6 migration)', () => {
        const v5Serialized: SerializedGameState = {
            version: 5,
            pieces: [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } },
                { id: 1, pieces: [[1, { x: 0, y: 0 }]], position: { x: 100, y: 0 } },
            ],
            imageUrl: 'v5-image.jpg',
            imageSize: { width: 800, height: 600 },
            completed: false,
        };

        const restored = deserializeState(v5Serialized);

        expect(restored.groups[0].rotation).toBe(0);
        expect(restored.groups[1].rotation).toBe(0);
    });

    it('round-trips non-zero rotation values', () => {
        const original = makeGameState();
        original.groups[0].rotation = 2;
        original.groups[1].rotation = 3;

        const serialized = serializeState(original);
        const json = JSON.stringify(serialized);
        const parsed = JSON.parse(json) as SerializedGameState;
        const restored = deserializeState(parsed);

        expect(restored.groups[0].rotation).toBe(2);
        expect(restored.groups[1].rotation).toBe(3);
    });

    it('coerces missing rotation to 0 (v5 and earlier saves)', () => {
        const noRotation: SerializedGameState = {
            version: 5,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                {
                    id: 0,
                    pieces: [[0, { x: 0, y: 0 }]],
                    position: { x: 0, y: 0 },
                    // rotation intentionally omitted
                },
            ],
            imageUrl: 'test.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            completed: false,
        };

        const restored = deserializeState(noRotation);
        expect(restored.groups[0].rotation).toBe(0);
    });

    it('passes through arbitrary float rotation values in v9 saves', () => {
        const v9: SerializedGameState = {
            version: 9,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                {
                    id: 0,
                    pieces: [[0, { x: 0, y: 0 }]],
                    position: { x: 0, y: 0 },
                    rotation: 7,
                },
            ],
            imageUrl: 'test.jpg',
            imageSize: { width: 800, height: 600 },
            gridSize: { cols: 8, rows: 6 },
            completed: false,
        };

        const restored = deserializeState(v9);
        expect(restored.groups[0].rotation).toBe(7);
    });

    it('preserves gridSize in v3 round-trip', () => {
        const original = makeGameState({
            gridSize: { cols: 12, rows: 8 },
        });

        const serialized = serializeState(original);
        expect(serialized.gridSize).toEqual({ cols: 12, rows: 8 });

        const json = JSON.stringify(serialized);
        const parsed = JSON.parse(json) as SerializedGameState;
        const restored = deserializeState(parsed);

        expect(restored.gridSize).toEqual({ cols: 12, rows: 8 });
    });

    it('throws on unsupported version', () => {
        const state = makeGameState();
        const serialized = serializeState(state);
        serialized.version = 999;

        expect(() => deserializeState(serialized)).toThrow(
            'Unsupported state version: 999',
        );
    });

    it('throws on empty pieces array', () => {
        const serialized: SerializedGameState = {
            version: STATE_VERSION,
            pieces: [],
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } },
            ],
            imageUrl: 'test.jpg',
            completed: false,
        };

        expect(() => deserializeState(serialized)).toThrow(
            'pieces must be a non-empty array',
        );
    });

    it('throws on empty groups array', () => {
        const serialized: SerializedGameState = {
            version: STATE_VERSION,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [],
            imageUrl: 'test.jpg',
            completed: false,
        };

        expect(() => deserializeState(serialized)).toThrow(
            'groups must be a non-empty array',
        );
    });

    it('throws on invalid group position', () => {
        const serialized: SerializedGameState = {
            version: STATE_VERSION,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                {
                    id: 0,
                    pieces: [[0, { x: 0, y: 0 }]],
                    position: { x: NaN, y: 0 },
                },
            ],
            imageUrl: 'test.jpg',
            completed: false,
        };

        expect(() => deserializeState(serialized)).toThrow(
            'must have a valid position',
        );
    });

    it('round-trips rotationMode', () => {
        const original = makeGameState({
            cutStyle: 'fractal',
            rotationMode: 'quarter-turn',
        });

        const serialized = serializeState(original);
        expect(serialized.rotationMode).toBe('quarter-turn');

        const restored = deserializeState(
            JSON.parse(JSON.stringify(serialized)) as SerializedGameState,
        );
        expect(restored.rotationMode).toBe('quarter-turn');
    });

    it('infers rotationMode = "quarter-turn" from non-zero group rotations (missing field)', () => {
        const v6WithoutMode: SerializedGameState = {
            version: 6,
            pieces: [makeRectPiece({ id: 0 }), makeRectPiece({ id: 1 })],
            groups: [
                {
                    id: 0,
                    pieces: [[0, { x: 0, y: 0 }]],
                    position: { x: 0, y: 0 },
                    rotation: 2,
                },
                {
                    id: 1,
                    pieces: [[1, { x: 0, y: 0 }]],
                    position: { x: 100, y: 0 },
                    rotation: 0,
                },
            ],
            imageUrl: 'v6-image.jpg',
            imageSize: { width: 800, height: 600 },
            completed: false,
        };

        const restored = deserializeState(v6WithoutMode);
        expect(restored.rotationMode).toBe('quarter-turn');
    });

    it('infers rotationMode = "quarter-turn" for pre-field fractal saves', () => {
        const fractalNoMode: SerializedGameState = {
            version: 6,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                {
                    id: 0,
                    pieces: [[0, { x: 0, y: 0 }]],
                    position: { x: 0, y: 0 },
                    rotation: 0,
                },
            ],
            imageUrl: 'frac.jpg',
            imageSize: { width: 800, height: 600 },
            completed: false,
            cutStyle: 'fractal',
        };

        const restored = deserializeState(fractalNoMode);
        expect(restored.rotationMode).toBe('quarter-turn');
    });

    it('defaults rotationMode to "none" for classic saves without the field', () => {
        const classicNoMode: SerializedGameState = {
            version: 6,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                {
                    id: 0,
                    pieces: [[0, { x: 0, y: 0 }]],
                    position: { x: 0, y: 0 },
                    rotation: 0,
                },
            ],
            imageUrl: 'classic.jpg',
            imageSize: { width: 800, height: 600 },
            completed: false,
            cutStyle: 'classic',
        };

        const restored = deserializeState(classicNoMode);
        expect(restored.rotationMode).toBe('none');
    });

    describe('rotation degrees migration (v8 → v9)', () => {
        it('migrates v8 saves with quarter-turn rotation values to degrees', () => {
            const v8Save: SerializedGameState = {
                version: 8,
                pieces: [
                    makeRectPiece({ id: 0 }),
                    makeRectPiece({ id: 1 }),
                    makeRectPiece({ id: 2 }),
                    makeRectPiece({ id: 3 }),
                ],
                groups: [
                    { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 0 },
                    { id: 1, pieces: [[1, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 1 },
                    { id: 2, pieces: [[2, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 2 },
                    { id: 3, pieces: [[3, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 3 },
                ],
                imageUrl: 'test.jpg',
                imageSize: { width: 800, height: 600 },
                gridSize: { cols: 2, rows: 2 },
                completed: false,
            };

            const state = deserializeState(v8Save);

            expect(state.groups.find((g) => g.id === 0)!.rotation).toBe(0);
            expect(state.groups.find((g) => g.id === 1)!.rotation).toBe(90);
            expect(state.groups.find((g) => g.id === 2)!.rotation).toBe(180);
            expect(state.groups.find((g) => g.id === 3)!.rotation).toBe(270);
        });

        it('passes through v9 saves with rotation already in degrees', () => {
            const v9Save: SerializedGameState = {
                version: 9,
                pieces: [makeRectPiece({ id: 0 })],
                groups: [
                    { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 47.3 },
                ],
                imageUrl: 'test.jpg',
                imageSize: { width: 800, height: 600 },
                gridSize: { cols: 1, rows: 1 },
                completed: false,
            };

            const state = deserializeState(v9Save);
            expect(state.groups[0].rotation).toBeCloseTo(47.3);
        });
    });

    it('throws on group with no pieces', () => {
        const serialized: SerializedGameState = {
            version: STATE_VERSION,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [
                { id: 0, pieces: [], position: { x: 0, y: 0 } },
            ],
            imageUrl: 'test.jpg',
            completed: false,
        };

        expect(() => deserializeState(serialized)).toThrow(
            'must have at least one piece',
        );
    });
});

describe('readSelection', () => {
    function makeSerialized(
        selection?: SerializedGameState['selection'],
    ): SerializedGameState {
        return {
            version: STATE_VERSION,
            pieces: [makeRectPiece({ id: 0 })],
            groups: [{ id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } }],
            imageUrl: 'test.jpg',
            completed: false,
            selection,
        };
    }

    it('returns the stored selection ids', () => {
        expect(readSelection(makeSerialized([3, 1, 4]))).toEqual([3, 1, 4]);
    });

    it('returns an empty array when no selection field is present', () => {
        expect(readSelection(makeSerialized())).toEqual([]);
    });

    it('returns an empty array when selection is not an array', () => {
        const data = { ...makeSerialized(), selection: 'nope' } as unknown as SerializedGameState;
        expect(readSelection(data)).toEqual([]);
    });

    it('drops entries that do not survive JSON as finite numbers', () => {
        // The load path always comes through JSON.parse, where JSON.stringify
        // already turned NaN/Infinity into `null`. Exercise that shape.
        const onDisk = JSON.stringify({
            ...makeSerialized(),
            selection: [1, NaN, 2, Infinity, 3],
        });
        const parsed = JSON.parse(onDisk) as SerializedGameState;
        // Sanity-check the precondition: NaN/Infinity serialized to null.
        expect(parsed.selection).toEqual([1, null, 2, null, 3]);
        expect(readSelection(parsed)).toEqual([1, 2, 3]);
    });

    it('drops non-number entries from hand-edited storage', () => {
        const data = {
            ...makeSerialized(),
            selection: [1, 'x', null, 2],
        } as unknown as SerializedGameState;
        expect(readSelection(data)).toEqual([1, 2]);
    });
});

describe('static/progress split (v11)', () => {
    it('serializeStatic omits groups/selection/completed and tags the current version', () => {
        const state = makeGameState();
        const s = serializeStatic(state);
        expect(s.version).toBe(STATE_VERSION);
        expect('groups' in s).toBe(false);
        expect('completed' in s).toBe(false);
        expect(s.pieces).toEqual(state.pieces);
        expect(s.imageUrl).toBe(state.imageUrl);
    });

    it('serializeProgress carries groups, completed, selection and seed', () => {
        const state = makeGameState({ completed: true, seed: 42 });
        const p = serializeProgress(state, [1, 0]);
        expect(p.version).toBe(STATE_VERSION);
        expect(p.completed).toBe(true);
        expect(p.seed).toBe(42);
        expect(p.selection).toEqual([1, 0]);
        expect(p.groups.length).toBe(state.groups.length);
    });

    it('serializeProgress omits an empty selection', () => {
        const p = serializeProgress(makeGameState(), []);
        expect('selection' in p).toBe(false);
    });

    it('recombine rebuilds an equal GameState from static + progress', () => {
        const state = makeGameState({ seed: 7, cutStyle: 'composable', completed: true });
        const restored = recombine(serializeStatic(state), serializeProgress(state, []));
        expect(restored.pieces).toEqual(state.pieces);
        expect(restored.groups.length).toBe(state.groups.length);
        expect(restored.groups[0].pieces).toBeInstanceOf(Map);
        expect(restored.completed).toBe(true);
        expect(restored.seed).toBe(7);
        expect(restored.cutStyle).toBe('composable');
        expect(restored.piecesById.size).toBe(state.pieces.length);
    });

    it('recombine throws on empty pieces', () => {
        const state = makeGameState();
        const bad = { ...serializeStatic(state), pieces: [] };
        expect(() => recombine(bad as never, serializeProgress(state, []))).toThrow();
    });

    it('round-trips the selection through serializeProgress + readSelection', () => {
        expect(readSelection(serializeProgress(makeGameState(), [2, 0]))).toEqual([2, 0]);
    });

    it('preserves a non-default rotationMode through the split', () => {
        const state = makeGameState({ rotationMode: 'free' });
        const restored = recombine(serializeStatic(state), serializeProgress(state, []));
        expect(restored.rotationMode).toBe('free');
    });

    it('derives imageSize from pieces when the static blob omits it', () => {
        const state = makeGameState();
        const s = serializeStatic(state);
        delete (s as { imageSize?: unknown }).imageSize;
        const restored = recombine(s, serializeProgress(state, []));
        expect(restored.imageSize.width).toBeGreaterThan(0);
        expect(restored.imageSize.height).toBeGreaterThan(0);
    });
});

describe('v12 geometry dedup', () => {
    // A piece whose shape IS the edge concatenation (chain-aware M..Z form).
    function rebuildablePiece(): Piece {
        const edges = [
            { id: 0, mateEdgeId: -1, matePieceId: -1, path: 'L 10 0', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
            { id: 1, mateEdgeId: -1, matePieceId: -1, path: 'L 10 10', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
            { id: 2, mateEdgeId: -1, matePieceId: -1, path: 'L 0 0', start: { x: 10, y: 10 }, end: { x: 0, y: 0 } },
        ];
        return {
            id: 0, edges, imageOffset: { x: 0, y: 0 },
            shape: buildShape(edges),
            bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
        };
    }

    // Same edges, but a shape the edges do NOT concatenate to. No production
    // generator emits this; exaggerated here to exercise the fallback.
    function bespokeShapePiece(): Piece {
        return { ...rebuildablePiece(), shape: 'M 0 0 L 10 0 L 10 10 L 0 0 Z  ' };
    }

    it('omits shape from the blob when it is rebuildable', () => {
        const state = makeStateWith([rebuildablePiece()]);
        const blob = serializeStatic(state);
        expect('shape' in blob.pieces[0]).toBe(false);
        expect(blob.pieces[0].bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    });

    it('also dedupes shape in the legacy full-blob writer (serializeState)', () => {
        const state = makeStateWith([rebuildablePiece()]);
        const blob = serializeState(state);
        expect('shape' in blob.pieces[0]).toBe(false);
    });

    it('keeps a shape the edges do not reproduce, verbatim', () => {
        const state = makeStateWith([bespokeShapePiece()]);
        const blob = serializeStatic(state);
        expect(blob.pieces[0].shape).toBe(bespokeShapePiece().shape);
    });

    it('round-trips shape byte-identically through recombine', () => {
        const state = makeStateWith([rebuildablePiece(), bespokeShapePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        const restored = recombine(blob, progress);
        expect(restored.pieces.map((p) => p.shape)).toEqual(state.pieces.map((p) => p.shape));
        expect(restored.pieces.map((p) => p.bounds)).toEqual(state.pieces.map((p) => p.bounds));
    });

    it('rejects a v12 piece with no bounds', () => {
        const state = makeStateWith([rebuildablePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        delete blob.pieces[0].bounds;
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        expect(() => recombine(blob, progress)).toThrow(/bounds/);
    });

    it('rejects a v12 piece with non-finite bounds', () => {
        const state = makeStateWith([rebuildablePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        // Not JSON'd here — Infinity would collapse to `null` (the "missing"
        // case above); a corrupt in-memory save can carry a literal non-finite.
        blob.pieces[0].bounds = { minX: 0, minY: 0, maxX: Infinity, maxY: 10 };
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        expect(() => recombine(blob, progress)).toThrow(/bounds/);
    });

    it('rejects a v12 piece with bounds: null', () => {
        // Distinct from "missing": `{"bounds":null}` yields a present key with
        // value null, which the `== null` check catches without dereferencing.
        const state = makeStateWith([rebuildablePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        blob.pieces[0].bounds = null;
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        expect(() => recombine(blob, progress)).toThrow(/bounds/);
    });

    it('rejects a v12 piece with an inverted bounding box', () => {
        // Finite but backwards: `getPieceBounds` subtracts, so this would hand
        // the renderer a negative width via `deriveImageSize`.
        const state = makeStateWith([rebuildablePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        blob.pieces[0].bounds = { minX: 10, minY: 0, maxX: 0, maxY: 10 };
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        expect(() => recombine(blob, progress)).toThrow(/bounds/);
    });

    it('rejects a v12 piece whose stored shape is not a string', () => {
        const state = makeStateWith([bespokeShapePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        blob.pieces[0].shape = 42;
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        expect(() => recombine(blob, progress)).toThrow(/shape/);
    });

    it('rejects a v12 piece with no edges array', () => {
        // Without the guard this reaches `buildShape(undefined)` and throws a
        // bare TypeError instead of a descriptive `Invalid state:`.
        const state = makeStateWith([rebuildablePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        delete blob.pieces[0].edges;
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        expect(() => recombine(blob, progress)).toThrow(/Invalid state/);
    });

    it('drops curve samples a v12 blob should not be carrying', () => {
        // No writer produces this — `SerializedEdge` merely allows it, and
        // sealed model edges must never have `curvePoints`.
        const state = makeStateWith([rebuildablePiece()]);
        const blob = JSON.parse(JSON.stringify(serializeStatic(state)));
        blob.pieces[0].edges[0].curvePoints = [{ x: 0, y: 0 }, { x: 5, y: -5 }];
        const progress = JSON.parse(JSON.stringify(serializeProgress(state)));
        const restored = recombine(blob, progress);
        expect('curvePoints' in restored.pieces[0].edges[0]).toBe(false);
        // Stored bounds win: the stray samples do not widen the box.
        expect(restored.pieces[0].bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    });

    /**
     * The one assertion that fails if `buildShape`'s emitted bytes change: a
     * hand-written v12 blob with `shape` omitted, so the expected string is the
     * on-disk contract. On failure the fix is a STATE_VERSION bump (every stored
     * v12 puzzle just re-rendered), not a new expectation here.
     */
    it('rebuilds an omitted shape to a pinned byte string', () => {
        const e = (
            id: number,
            path: string,
            start: { x: number; y: number },
            end: { x: number; y: number },
        ): SerializedStaticState['pieces'][number]['edges'][number] =>
            ({ id, mateEdgeId: -1, matePieceId: -1, path, start, end });
        const blob: SerializedStaticState = {
            version: 12,
            imageUrl: 'img',
            imageSize: { width: 100, height: 100 },
            gridSize: { cols: 1, rows: 1 },
            pieces: [{
                id: 0,
                imageOffset: { x: 0, y: 0 },
                bounds: { minX: 0, minY: 0, maxX: 12, maxY: 10 },
                edges: [
                    // Outer loop: chained end→start (one M..Z subpath). Last
                    // edge starts 0.2px off the previous end — inside
                    // CHAIN_EPSILON, so it must still chain (pins the tolerance).
                    e(0, 'L 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
                    e(1, 'C 12 3 12 7 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }),
                    e(2, 'L 0 0', { x: 10.2, y: 10.1 }, { x: 0, y: 0 }),
                    // Hole: chain breaks → second subpath, with a non-integer
                    // anchor that pins `fmt`'s formatting.
                    e(3, 'L 4 2.25', { x: 2.5, y: 2.25 }, { x: 4, y: 2.25 }),
                    e(4, 'L 2.5 2.25', { x: 4, y: 2.25 }, { x: 2.5, y: 2.25 }),
                ],
            }],
        };
        const progress: SerializedProgress = {
            version: 12,
            groups: [{ id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } }],
            completed: false,
        };

        expect(recombine(blob, progress).pieces[0].shape).toBe(
            'M 0 0 L 10 0 C 12 3 12 7 10 10 L 0 0 Z M 2.50 2.25 L 4 2.25 L 2.5 2.25 Z',
        );
    });
});

describe('v≤11 piece migration', () => {
    it('computes bounds from stored curvePoints and drops them (recombine)', () => {
        // Hand-built v11 static blob: shape always present, curve samples on the edge.
        const v11Blob: SerializedStaticState = {
            version: 11,
            imageUrl: 'img',
            imageSize: { width: 100, height: 100 },
            gridSize: { cols: 2, rows: 1 },
            pieces: [{
                id: 0,
                imageOffset: { x: 0, y: 0 },
                shape: 'M 0 0 L 10 0 L 10 10 L 0 0 Z',
                edges: [{
                    id: 0, mateEdgeId: -1, matePieceId: -1,
                    path: 'L 10 0', start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
                    curvePoints: [{ x: 0, y: 0 }, { x: 5, y: -2.5 }, { x: 10, y: 0 }],
                }],
            }],
        };
        const progress: SerializedProgress = {
            version: 12,
            groups: [{ id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 } }],
            completed: false,
        };
        const state = recombine(v11Blob, progress);
        expect(state.pieces[0].bounds).toEqual({ minX: 0, minY: -2.5, maxX: 10, maxY: 0 });
        expect('curvePoints' in state.pieces[0].edges[0]).toBe(false);
        expect(state.pieces[0].shape).toBe(v11Blob.pieces[0].shape);
    });

    it('computes bounds from stored curvePoints and drops them (deserializeState, legacy full blob)', () => {
        // Hand-built legacy (pre-split) full blob, as `deserializeState` still
        // loads: shape always present, curve samples on the edge, no bounds.
        const legacyBlob: SerializedGameState = {
            version: 9,
            imageUrl: 'img',
            imageSize: { width: 100, height: 100 },
            gridSize: { cols: 2, rows: 1 },
            completed: false,
            groups: [
                { id: 0, pieces: [[0, { x: 0, y: 0 }]], position: { x: 0, y: 0 }, rotation: 0 },
            ],
            pieces: [{
                id: 0,
                imageOffset: { x: 0, y: 0 },
                shape: 'M 0 0 L 10 0 L 10 10 L 0 0 Z',
                edges: [{
                    id: 0, mateEdgeId: -1, matePieceId: -1,
                    path: 'L 10 0', start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
                    curvePoints: [{ x: 0, y: 0 }, { x: 5, y: -2.5 }, { x: 10, y: 0 }],
                }],
            }],
        };
        const state = deserializeState(legacyBlob);
        expect(state.pieces[0].bounds).toEqual({ minX: 0, minY: -2.5, maxX: 10, maxY: 0 });
        expect('curvePoints' in state.pieces[0].edges[0]).toBe(false);
        expect(state.pieces[0].shape).toBe(legacyBlob.pieces[0].shape);
    });
});

describe('viewport persistence', () => {
    const VP = { scale: 1.5, offset: { x: 30, y: -40 } };

    it('serializeProgress includes the viewport when passed', () => {
        const p = serializeProgress(makeGameState(), [], VP);
        expect(p.viewport).toEqual(VP);
    });

    it('serializeProgress omits the viewport when not passed', () => {
        const p = serializeProgress(makeGameState(), []);
        expect('viewport' in p).toBe(false);
    });

    it('round-trips the viewport through serializeProgress + JSON + readViewport', () => {
        const onDisk = JSON.stringify(serializeProgress(makeGameState(), [], VP));
        const parsed = JSON.parse(onDisk) as ReturnType<typeof serializeProgress>;
        expect(readViewport(parsed)).toEqual(VP);
    });

    it('readViewport returns undefined when the field is absent', () => {
        expect(readViewport(serializeProgress(makeGameState(), []))).toBeUndefined();
    });

    it('readViewport returns undefined for a non-finite scale (NaN survived as null)', () => {
        const onDisk = JSON.stringify(
            serializeProgress(makeGameState(), [], { scale: NaN, offset: { x: 0, y: 0 } }),
        );
        const parsed = JSON.parse(onDisk) as ReturnType<typeof serializeProgress>;
        expect(readViewport(parsed)).toBeUndefined();
    });

    it('readViewport returns undefined for a malformed offset', () => {
        const data = {
            ...serializeProgress(makeGameState(), []),
            viewport: { scale: 1, offset: { x: 'nope', y: 0 } },
        } as unknown as ReturnType<typeof serializeProgress>;
        expect(readViewport(data)).toBeUndefined();
    });

    it('readViewport returns undefined for a non-object viewport from hand-edited storage', () => {
        const data = {
            ...serializeProgress(makeGameState(), []),
            viewport: 'garbage',
        } as unknown as ReturnType<typeof serializeProgress>;
        expect(readViewport(data)).toBeUndefined();
    });
});

describe('blank puzzles', () => {
    it('omits imageUrl when the puzzle has no image', () => {
        const serialized = serializeState(makeGameState({ imageUrl: null }));
        expect(serialized).not.toHaveProperty('imageUrl');
    });

    it('omits imageUrl from the static blob too', () => {
        const s = serializeStatic(makeGameState({ imageUrl: null }));
        expect(s).not.toHaveProperty('imageUrl');
    });

    it('round-trips a blank puzzle back to null', () => {
        const state = makeGameState({ imageUrl: null });
        expect(deserializeState(serializeState(state)).imageUrl).toBeNull();
    });

    it('round-trips a blank puzzle through the split blobs', () => {
        const state = makeGameState({ imageUrl: null });
        const restored = recombine(
            serializeStatic(state),
            serializeProgress(state),
        );
        expect(restored.imageUrl).toBeNull();
    });

    it('migrates a v12 synthesized white PNG to null', () => {
        const serialized = serializeState(makeGameState());
        serialized.version = 12;
        serialized.imageUrl = 'data:image/png;base64,' + 'A'.repeat(64);

        expect(deserializeState(serialized).imageUrl).toBeNull();
    });

    it('migrates a v12 synthesized white PNG with an uppercase scheme to null', () => {
        const serialized = serializeState(makeGameState());
        serialized.version = 12;
        serialized.imageUrl = 'DATA:image/png;base64,' + 'A'.repeat(64);

        expect(deserializeState(serialized).imageUrl).toBeNull();
    });

    it('migrates a v12 synthesized white PNG in the static blob too', () => {
        const state = makeGameState();
        const s = serializeStatic(state);
        s.version = 12;
        s.imageUrl = 'data:image/png;base64,' + 'A'.repeat(64);

        expect(recombine(s, serializeProgress(state)).imageUrl).toBeNull();
    });

    it('leaves a real image URL on an old save alone', () => {
        const serialized = serializeState(makeGameState());
        serialized.version = 12;
        serialized.imageUrl = 'https://images.unsplash.com/photo-1?w=1080';

        expect(deserializeState(serialized).imageUrl).toBe(
            'https://images.unsplash.com/photo-1?w=1080',
        );
    });

    it('rejects a v12 blob with no imageUrl at all', () => {
        const serialized = serializeState(makeGameState());
        serialized.version = 12;
        delete serialized.imageUrl;

        expect(() => deserializeState(serialized)).toThrow(
            'imageUrl must be a non-empty string',
        );
    });

    it('rejects a v12 static blob with no imageUrl at all', () => {
        const state = makeGameState();
        const s = serializeStatic(state);
        s.version = 12;
        delete s.imageUrl;

        expect(() => recombine(s, serializeProgress(state))).toThrow(
            'imageUrl must be a non-empty string',
        );
    });

    it('rejects an empty-string imageUrl on a v13 blob', () => {
        const serialized = serializeState(makeGameState());
        serialized.imageUrl = '';

        expect(() => deserializeState(serialized)).toThrow(
            'imageUrl must be a non-empty string',
        );
    });
});

describe('v14 mate path dedup', () => {
    beforeAll(() => {
        registerTabGenerator(tracedTabGenerator);
    });

    const generated = new Map<string, GameState>();
    function generatedState(style: StyleCase): GameState {
        let state = generated.get(style.name);
        if (!state) {
            state = createNewGame('img', imageSize, viewport, style.grid, { ...style.options, seed: SEED });
            generated.set(style.name, state);
        }
        return state;
    }

    function wavyState(): GameState {
        return generatedState(styles.find((s) => s.name === 'wavy')!);
    }

    function roundTrip(staticBlob: SerializedStaticState, state: GameState): GameState {
        return recombine(
            JSON.parse(JSON.stringify(staticBlob)),
            JSON.parse(JSON.stringify(serializeProgress(state))),
        );
    }

    function jsonBlob(state: GameState): SerializedStaticState {
        return JSON.parse(JSON.stringify(serializeStatic(state)));
    }

    it('writes version 14', () => {
        expect(serializeStatic(makeGameState()).version).toBe(14);
        expect(serializeProgress(makeGameState()).version).toBe(14);
        expect(serializeState(makeGameState()).version).toBe(14);
    });

    for (const style of styles) {
        it(`omits rebuildable mate paths and restores them (${style.name})`, () => {
            const state = generatedState(style);
            const blob = jsonBlob(state);

            const interior = blob.pieces.flatMap((p) => p.edges).filter((e) => e.mateEdgeId >= 0);
            const pairs = interior.filter((e) => e.mateEdgeId > e.id).length;
            expect(pairs).toBeGreaterThan(0);
            expect(interior.filter((e) => 'path' in e).length).toBe(pairs);
            expect(roundTrip(blob, state).pieces).toEqual(state.pieces);
        });
    }

    it('generates self-mated pairs in the fractal case, so the round trip covers them', () => {
        const state = generatedState(styles.find((s) => s.name === 'fractal')!);
        const selfMated = state.pieces.flatMap((p) =>
            p.edges.filter((e) => e.mateEdgeId >= 0 && e.matePieceId === p.id));
        expect(selfMated.length).toBeGreaterThan(0);
    });

    it('also omits rebuildable mate paths in the legacy full-blob writer', () => {
        const state = wavyState();
        const blob = JSON.parse(JSON.stringify(serializeState(state))) as SerializedGameState;
        const omitted = blob.pieces.flatMap((p) => p.edges).filter((e) => !('path' in e));
        expect(omitted.length).toBeGreaterThan(0);
        expect(deserializeState(blob).pieces).toEqual(state.pieces);
    });

    it('keeps a mate path it cannot rebuild', () => {
        const base = wavyState();
        const pieces = structuredClone(base.pieces);
        const piece = pieces.find((p) => p.edges.some((e) => e.mateEdgeId >= 0 && e.mateEdgeId < e.id))!;
        const edge = piece.edges.find((e) => e.mateEdgeId >= 0 && e.mateEdgeId < e.id)!;
        const segments = parseEdgePath(edge.path)!;
        const first = segments[0];
        segments[0] = first.cmd === 'C'
            ? { ...first, c1: { ...first.c1, x: first.c1.x + 0.01 } }
            : { ...first, to: { ...first.to, x: first.to.x + 0.01 } };
        const altered = formatEdgePath(segments);
        expect(altered).not.toBe(edge.path);
        edge.path = altered;
        piece.shape = buildShape(piece.edges);
        const state: GameState = { ...base, pieces, piecesById: buildPiecesById(pieces) };

        const blob = jsonBlob(state);
        const stored = blob.pieces.find((p) => p.id === piece.id)!.edges.find((e) => e.id === edge.id)!;

        expect(stored.path).toBe(altered);
        expect(roundTrip(blob, state).pieces).toEqual(pieces);
    });

    describe('rejects a corrupt v14 blob', () => {
        type Corruption = (blob: SerializedStaticState) => void;
        const NO_PATH = /^Invalid state: piece \d+ edge \d+ has no path$/;
        const allEdges = (blob: SerializedStaticState) => blob.pieces.flatMap((p) => p.edges);
        const canonical = (blob: SerializedStaticState) =>
            allEdges(blob).find((e) => e.mateEdgeId > e.id)!;

        const corruptions: Array<[string, Corruption, RegExp]> = [
            ['canonical path deleted', (blob) => {
                delete canonical(blob).path;
            }, NO_PATH],
            ['border edge path deleted', (blob) => {
                delete allEdges(blob).find((e) => e.mateEdgeId < 0)!.path;
            }, NO_PATH],
            ['mate edge missing', (blob) => {
                const canon = canonical(blob);
                const owner = blob.pieces.find((p) => p.edges.includes(canon))!;
                owner.edges = owner.edges.filter((e) => e !== canon);
            }, NO_PATH],
            ['canonical edge not pointing back', (blob) => {
                const canon = canonical(blob);
                canon.mateEdgeId = -1;
                canon.matePieceId = -1;
            }, NO_PATH],
            ['canonical path unparseable', (blob) => {
                canonical(blob).path = 'Q 1 2';
            }, NO_PATH],
            ['path not a string', (blob) => {
                (allEdges(blob).find((e) => e.mateEdgeId < 0) as { path?: unknown }).path = 42;
            }, /^Invalid state: piece \d+ edge \d+ has a non-string path$/],
        ];

        for (const [name, corrupt, message] of corruptions) {
            it(name, () => {
                const state = wavyState();
                const blob = jsonBlob(state);
                corrupt(blob);
                expect(() => roundTrip(blob, state)).toThrow(message);
            });
        }
    });

    it('loads a v13 blob unchanged', () => {
        const edge = (
            id: number,
            path: string,
            start: { x: number; y: number },
            end: { x: number; y: number },
            mate: [number, number] = [-1, -1],
        ): SerializedStaticState['pieces'][number]['edges'][number] =>
            ({ id, mateEdgeId: mate[0], matePieceId: mate[1], path, start, end });
        // Mate paths a v13 writer stored as-is: neither is the byte-exact
        // reverse of its partner.
        const blob: SerializedStaticState = {
            version: 13,
            imageUrl: 'img',
            imageSize: { width: 20, height: 10 },
            gridSize: { cols: 2, rows: 1 },
            pieces: [
                {
                    id: 0,
                    imageOffset: { x: 0, y: 0 },
                    bounds: { minX: 0, minY: 0, maxX: 12, maxY: 10 },
                    edges: [
                        edge(0, 'L 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
                        edge(1, 'C 12 3, 12 7, 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }, [5, 1]),
                        edge(2, 'L 0 10', { x: 10, y: 10 }, { x: 0, y: 10 }),
                        edge(3, 'L 0 0', { x: 0, y: 10 }, { x: 0, y: 0 }),
                    ],
                },
                {
                    id: 1,
                    imageOffset: { x: -10, y: 0 },
                    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
                    edges: [
                        edge(4, 'L 10 0', { x: 0, y: 0 }, { x: 10, y: 0 }),
                        edge(6, 'L 10 10', { x: 10, y: 0 }, { x: 10, y: 10 }),
                        edge(7, 'L 0 10', { x: 10, y: 10 }, { x: 0, y: 10 }),
                        edge(5, 'C 2.01 7 2 3 0 0.004', { x: 0, y: 10 }, { x: 0, y: 0 }, [1, 0]),
                    ],
                },
            ],
        };
        const progress: SerializedProgress = {
            version: 13,
            groups: [{ id: 0, pieces: [[0, { x: 0, y: 0 }], [1, { x: 10, y: 0 }]], position: { x: 0, y: 0 } }],
            completed: false,
        };

        const restored = recombine(JSON.parse(JSON.stringify(blob)), progress);

        expect(restored.pieces.map((p) => p.edges.map((e) => e.path)))
            .toEqual(blob.pieces.map((p) => p.edges.map((e) => e.path)));
    });
});
