/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createProbeResolver, parseCssColor, readRendererAppearance, observeRendererAppearance } from './renderer-appearance.js';
import { PIECE_OUTLINE_ATTRIBUTE, PIECE_OUTLINE_PRESETS, applyPieceOutline } from '../ui/piece-outline.js';
import { OUTLINE_CONSTANT_WIDTH_ATTRIBUTE, applyOutlineConstantWidth } from '../ui/outline-constant-width.js';
import { OUTLINE_INSIDE_ATTRIBUTE, applyOutlineInside } from '../ui/outline-inside.js';
import { DEBUG_PIECES_CLASS, MATELESS_EDGES_CLASS } from '../ui/debug-section.js';
import { diagnostics } from '../diagnostics.js';

const identity = (value: string): string => value;

function resolveByVariable(value: string): string {
    const table: Record<string, string> = {
        'var(--piece-outline-color, #080808)': 'rgb(8, 8, 8)',
        'var(--selection-glow, #c8bfff)': 'rgb(255, 0, 0)',
        'var(--puzzle-bg-color, #1a1a1a)': '#336699',
    };
    return table[value] ?? value;
}

function resetRoot(): void {
    const root = document.documentElement;
    root.removeAttribute('style');
    root.removeAttribute('class');
    root.removeAttribute(PIECE_OUTLINE_ATTRIBUTE);
    root.removeAttribute(OUTLINE_CONSTANT_WIDTH_ATTRIBUTE);
    root.removeAttribute(OUTLINE_INSIDE_ATTRIBUTE);
}

describe('parseCssColor', () => {
    it('parseCssColor reads rgb(), rgba() and #rrggbb', () => {
        expect(parseCssColor('rgb(8, 8, 8)')).toEqual([8 / 255, 8 / 255, 8 / 255, 1]);
        expect(parseCssColor('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0, 0.5]);
        expect(parseCssColor('#336699')).toEqual([0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
    });

    it('reads color(srgb …) as produced for color-mix results', () => {
        expect(parseCssColor('color(srgb 1 0.5 0 / 0.9)')).toEqual([1, 0.5, 0, 0.9]);
    });

    it('returns null for unparseable values', () => {
        expect(parseCssColor('')).toBeNull();
        expect(parseCssColor('var(--x)')).toBeNull();
    });
});

describe('createProbeResolver', () => {
    it('resolves a plain color and leaves the root unchanged', () => {
        const root = document.documentElement;
        const childrenBefore = [...root.children];
        const resolved = createProbeResolver(root)('#080808');

        expect(parseCssColor(resolved)).toEqual([8 / 255, 8 / 255, 8 / 255, 1]);
        expect([...root.children]).toEqual(childrenBefore);
    });
});

describe('readRendererAppearance', () => {
    beforeEach(() => {
        resetRoot();
    });

    it('readRendererAppearance maps data-piece-outline, constant width, opacity and debug classes', () => {
        const root = document.documentElement;
        applyPieceOutline('shadow');
        applyOutlineConstantWidth(true);
        root.style.setProperty('--piece-opacity', '0.4');
        root.classList.add(DEBUG_PIECES_CLASS, MATELESS_EDGES_CLASS);

        const appearance = readRendererAppearance(root, resolveByVariable);

        expect(appearance).toEqual({
            outline: 'shadow',
            outlineColor: [8 / 255, 8 / 255, 8 / 255, 1],
            constantWidth: true,
            innerOutline: false,
            selectionGlowColor: [1, 0, 0, 1],
            backgroundColor: [0x33 / 255, 0x66 / 255, 0x99 / 255, 1],
            pieceOpacity: 0.4,
            debugPieces: true,
            matelessEdges: true,
        });
    });

    it.each(PIECE_OUTLINE_PRESETS.map((preset) => preset.id))('maps the %s outline preset to itself', (id) => {
        applyPieceOutline(id);

        expect(readRendererAppearance(document.documentElement, identity).outline).toBe(id);
    });

    it('reads the piece opacity from the stylesheet, not only the inline style', () => {
        const style = document.createElement('style');
        style.textContent = ':root { --piece-opacity: 0.3; }';
        document.head.append(style);
        onTestFinished(() => style.remove());

        expect(readRendererAppearance(document.documentElement, resolveByVariable).pieceOpacity).toBe(0.3);
    });

    it('defaults opacity to 1 and flags to false', () => {
        const appearance = readRendererAppearance(document.documentElement, resolveByVariable);

        expect(appearance.pieceOpacity).toBe(1);
        expect(appearance.constantWidth).toBe(false);
        expect(appearance.debugPieces).toBe(false);
        expect(appearance.matelessEdges).toBe(false);
    });

    it('innerOutline is false unless outline is "outline"', () => {
        const root = document.documentElement;
        applyOutlineInside(true);

        applyPieceOutline('shadow');
        expect(readRendererAppearance(root, identity).innerOutline).toBe(false);
        applyPieceOutline('none');
        expect(readRendererAppearance(root, identity).innerOutline).toBe(false);
        applyPieceOutline('outline');
        expect(readRendererAppearance(root, identity).innerOutline).toBe(true);
        applyOutlineInside(false);
        expect(readRendererAppearance(root, identity).innerOutline).toBe(false);
    });
});

describe('color resolution', () => {
    it('asks the resolver for each variable with the CSS fallback, so an unset variable cannot inherit the text color', () => {
        const resolveColor = vi.fn(identity);

        readRendererAppearance(document.documentElement, resolveColor);

        expect(resolveColor.mock.calls.map(([value]) => value)).toEqual([
            'var(--piece-outline-color, #080808)',
            'var(--selection-glow, #c8bfff)',
            'var(--puzzle-bg-color, #1a1a1a)',
        ]);
    });

    it('falls back to the default color, with a warning naming the variable, when the resolved value is unparseable', () => {
        const warn = vi.spyOn(diagnostics, 'warn').mockImplementation(() => {});
        onTestFinished(() => warn.mockRestore());

        const appearance = readRendererAppearance(document.documentElement, () => 'garbage');

        expect(appearance.outlineColor).toEqual([8 / 255, 8 / 255, 8 / 255, 1]);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/--piece-outline-color.*"garbage"/));
    });
});

describe('observeRendererAppearance', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
        resetRoot();
        applyPieceOutline('outline');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function flushMutations(): Promise<void> {
        await Promise.resolve();
        await Promise.resolve();
    }

    it('observer emits once for several attribute changes in one frame', async () => {
        const root = document.documentElement;
        const onChange = vi.fn();
        const stop = observeRendererAppearance(root, identity, onChange);

        applyPieceOutline('shadow');
        applyOutlineConstantWidth(true);
        root.classList.add(DEBUG_PIECES_CLASS);
        root.style.setProperty('--piece-opacity', '0.5');
        await flushMutations();
        vi.advanceTimersByTime(20);

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toMatchObject({
            outline: 'shadow',
            constantWidth: true,
            debugPieces: true,
            pieceOpacity: 0.5,
        });
        stop();
    });

    it('observer emits a draw-inside change', async () => {
        const onChange = vi.fn();
        const stop = observeRendererAppearance(document.documentElement, identity, onChange);

        applyOutlineInside(true);
        await flushMutations();
        vi.advanceTimersByTime(20);

        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ innerOutline: true }));
        stop();
    });

    it('observer re-reads the colors on any <html> attribute change', async () => {
        const root = document.documentElement;
        onTestFinished(() => root.removeAttribute('data-some-theme'));
        const resolveColor = (value: string): string =>
            root.hasAttribute('data-some-theme') ? '#ffffff' : value;
        const onChange = vi.fn();
        const stop = observeRendererAppearance(root, resolveColor, onChange);

        root.setAttribute('data-some-theme', '');
        await flushMutations();
        vi.advanceTimersByTime(20);

        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ backgroundColor: [1, 1, 1, 1] }));
        stop();
    });

    it('observer re-reads the colors when the OS color scheme flips', () => {
        const listeners: Array<() => void> = [];
        vi.stubGlobal('matchMedia', () => ({
            addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
            removeEventListener: vi.fn(),
        }));
        onTestFinished(() => { vi.unstubAllGlobals(); });
        let dark = false;
        const resolveColor = (value: string): string => (dark ? '#000000' : value);
        const onChange = vi.fn();
        const stop = observeRendererAppearance(document.documentElement, resolveColor, onChange);

        dark = true;
        for (const listener of listeners) listener();
        vi.advanceTimersByTime(20);

        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ backgroundColor: [0, 0, 0, 1] }));
        stop();
    });

    it('observer does not emit when nothing changed', async () => {
        const root = document.documentElement;
        const onChange = vi.fn();
        const stop = observeRendererAppearance(root, identity, onChange);

        applyPieceOutline('outline');
        root.classList.add('unrelated-class');
        await flushMutations();
        vi.advanceTimersByTime(20);

        expect(onChange).not.toHaveBeenCalled();
        stop();
    });

    it('stops emitting after disposal', async () => {
        const root = document.documentElement;
        const onChange = vi.fn();
        const stop = observeRendererAppearance(root, identity, onChange);

        applyPieceOutline('none');
        await flushMutations();
        stop();
        vi.advanceTimersByTime(20);

        expect(onChange).not.toHaveBeenCalled();
    });
});
