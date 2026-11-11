import type { RendererAppearance, Rgba } from '../renderer/index.js';
import { diagnostics } from '../diagnostics.js';
import { OUTLINE_INSIDE_ATTRIBUTE } from '../ui/outline-inside.js';
import {
    DEFAULT_PIECE_OUTLINE_ID,
    PIECE_OUTLINE_ATTRIBUTE,
    PIECE_OUTLINE_PRESETS,
    type PieceOutlineId,
} from '../ui/piece-outline.js';
import { CSS_CUSTOM_PROPERTY as OUTLINE_COLOR_PROPERTY } from '../ui/piece-outline-color.js';
import { CSS_CUSTOM_PROPERTY as BACKGROUND_COLOR_PROPERTY } from '../ui/background-color.js';
import { OUTLINE_CONSTANT_WIDTH_ATTRIBUTE } from '../ui/outline-constant-width.js';
import { DEBUG_PIECES_CLASS, MATELESS_EDGES_CLASS, PIECE_OPACITY_PROPERTY } from '../ui/debug-section.js';
import { onColorSchemeChange } from '../ui/palette.js';

const FALLBACK_OUTLINE_COLOR = '#080808';
const FALLBACK_SELECTION_GLOW = '#c8bfff';
const FALLBACK_BACKGROUND = '#1a1a1a';

const OUTLINE_BY_PRESET: Record<PieceOutlineId, RendererAppearance['outline']> = {
    none: 'none',
    shadow: 'shadow',
    outline: 'outline',
};

function isPieceOutlineId(id: string | null): id is PieceOutlineId {
    return PIECE_OUTLINE_PRESETS.some((preset) => preset.id === id);
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function parseAlpha(token: string | undefined): number {
    if (token === undefined) return 1;
    const trimmed = token.trim();
    const value = trimmed.endsWith('%') ? Number.parseFloat(trimmed) / 100 : Number(trimmed);
    return Number.isFinite(value) ? clamp01(value) : 1;
}

export function parseCssColor(value: string): Rgba | null {
    const text = value.trim();

    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    if (hex) {
        const digits = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
        const n = Number.parseInt(digits, 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    }

    const rgb = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(text);
    if (rgb) {
        return [
            clamp01(Number(rgb[1]) / 255),
            clamp01(Number(rgb[2]) / 255),
            clamp01(Number(rgb[3]) / 255),
            parseAlpha(rgb[4]),
        ];
    }

    const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(text);
    if (srgb) {
        return [clamp01(Number(srgb[1])), clamp01(Number(srgb[2])), clamp01(Number(srgb[3])), parseAlpha(srgb[4])];
    }

    return null;
}

export function createProbeResolver(root: HTMLElement): (cssValue: string) => string {
    return (cssValue) => {
        const probe = root.ownerDocument.createElement('span');
        probe.style.display = 'none';
        probe.style.color = cssValue;
        root.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
    };
}

function readOutline(root: HTMLElement): RendererAppearance['outline'] {
    const id = root.getAttribute(PIECE_OUTLINE_ATTRIBUTE);
    return OUTLINE_BY_PRESET[isPieceOutlineId(id) ? id : DEFAULT_PIECE_OUTLINE_ID];
}

export function readRendererAppearance(
    root: HTMLElement,
    resolveColor: (cssValue: string) => string,
): RendererAppearance {
    const outline = readOutline(root);
    const opacity = Number.parseFloat(getComputedStyle(root).getPropertyValue(PIECE_OPACITY_PROPERTY));
    const color = (variable: string, fallback: string): Rgba => {
        const resolved = resolveColor(`var(${variable}, ${fallback})`);
        const parsed = parseCssColor(resolved);
        if (parsed !== null) return parsed;
        diagnostics.warn(
            `readRendererAppearance: could not parse ${variable} resolved as "${resolved}"; using ${fallback}`,
        );
        return parseCssColor(fallback)!;
    };
    return {
        outline,
        outlineColor: color(OUTLINE_COLOR_PROPERTY, FALLBACK_OUTLINE_COLOR),
        constantWidth: root.hasAttribute(OUTLINE_CONSTANT_WIDTH_ATTRIBUTE),
        innerOutline: outline === 'outline' && root.hasAttribute(OUTLINE_INSIDE_ATTRIBUTE),
        selectionGlowColor: color('--selection-glow', FALLBACK_SELECTION_GLOW),
        backgroundColor: color(BACKGROUND_COLOR_PROPERTY, FALLBACK_BACKGROUND),
        pieceOpacity: Number.isFinite(opacity) ? clamp01(opacity) : 1,
        debugPieces: root.classList.contains(DEBUG_PIECES_CLASS),
        matelessEdges: root.classList.contains(MATELESS_EDGES_CLASS),
    };
}

export function observeRendererAppearance(
    root: HTMLElement,
    resolveColor: (cssValue: string) => string,
    onChange: (appearance: RendererAppearance) => void,
): () => void {
    let last = JSON.stringify(readRendererAppearance(root, resolveColor));
    let frame: number | null = null;

    const flush = (): void => {
        frame = null;
        const appearance = readRendererAppearance(root, resolveColor);
        const serialized = JSON.stringify(appearance);
        if (serialized === last) return;
        last = serialized;
        onChange(appearance);
    };
    const schedule = (): void => {
        frame ??= requestAnimationFrame(flush);
    };

    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(root, { attributes: true });
    const stopColorScheme = onColorSchemeChange(schedule);

    return () => {
        mutationObserver.disconnect();
        stopColorScheme();
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
    };
}
