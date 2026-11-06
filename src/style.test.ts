/**
 * The glow is CSS-only: it reads `--selection-glow`, defined light on `:root`
 * and flipped dark in `[data-ui-scheme="light"]` so a same-hue light background
 * doesn't wash it out. No JS to unit-test, so these assertions guard the CSS
 * wiring against a revert to the fixed `--ui-accent`.
 */

import { describe, it, expect } from 'vitest';
import styleCss from './style.css?raw';
import { DEFAULT_COLOR_ID } from './ui/background-color.js';

function matchingBrace(css: string, open: number): number {
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) return i;
    }
    return css.length;
}

/**
 * Every declaration top-level rules apply to `selector`, concatenated. Matches
 * a whole comma-separated entry and collects across rules (a selector can
 * appear in several), so an assertion doesn't depend on rule order. At-rule
 * blocks (`@media`, `@supports`) are skipped whole, so a responsive override
 * never satisfies an assertion about the base rule — the point of the dialog
 * guards below.
 */
function declarationsFor(css: string, selector: string): string {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const bodies: string[] = [];
    let i = 0;
    let preludeStart = 0;
    while ((i = withoutComments.indexOf('{', i)) !== -1) {
        const prelude = withoutComments.slice(preludeStart, i).trim();
        const end = matchingBrace(withoutComments, i);
        if (
            !prelude.startsWith('@')
            && prelude.split(',').map((s) => s.trim()).includes(selector)
        ) {
            bodies.push(withoutComments.slice(i + 1, end));
        }
        i = end + 1;
        preludeStart = i;
    }
    expect(bodies.length, `no rule found for "${selector}"`).toBeGreaterThan(0);
    return bodies.join('\n');
}

/**
 * The helper's own guards — they replaced comments that told editors to keep a
 * base rule above its `@media` duplicate (the old helper matched the first).
 */
describe('declarationsFor', () => {
    const css = `
@media (max-height: 560px) {
  .dialog { overflow-y: auto; }
}
.dialog { max-height: 100%; }
.dialog, .other { padding: 0; }
`;

    it('ignores declarations nested inside an at-rule block', () => {
        // A responsive override must never satisfy a base-rule assertion.
        expect(declarationsFor(css, '.dialog')).not.toMatch(/overflow-y/);
    });

    it('finds a base rule below its @media duplicate', () => {
        expect(declarationsFor(css, '.dialog')).toMatch(/max-height:\s*100%/);
    });

    it('collects every top-level rule listing the selector', () => {
        expect(declarationsFor(css, '.dialog')).toMatch(/padding:\s*0/);
    });

    it('fails loudly when the selector is absent', () => {
        expect(() => declarationsFor(css, '.missing')).toThrow();
    });
});

/**
 * Guards the new-game dialog's viewport fit: it once rendered taller than short
 * viewports with no max-height or scrolling, clipping both ends unreachably.
 * Only these assertions would catch a revert of the CSS wiring.
 */
describe('new-game dialog responsive CSS', () => {
    it('caps the dialog height and scrolls inside, not outside', () => {
        const body = declarationsFor(styleCss, '.size-picker-dialog');
        expect(body).toMatch(/max-height:\s*100%/);
        expect(body).toMatch(/flex-direction:\s*column/);
        expect(body).toMatch(/overflow:\s*hidden/);
    });

    it('scrolls the dialog body internally', () => {
        const body = declarationsFor(styleCss, '.dialog-content');
        expect(body).toMatch(/overflow-y:\s*auto/);
        expect(body).toMatch(/overscroll-behavior:\s*contain/);
        // Load-bearing: without min-height:0 the flex child can't shrink
        // below its content, so it never scrolls inside the flex column.
        expect(body).toMatch(/min-height:\s*0/);
    });

    it('lets dialog rows wrap instead of clipping wide controls', () => {
        expect(declarationsFor(styleCss, '.dialog-row')).toMatch(/flex-wrap:\s*wrap/);
    });

    it('caps the image-picker grid tracks so tiles align with sibling rows', () => {
        // Load-bearing: bare `1fr` (= minmax(auto, 1fr)) lets the tiles'
        // intrinsic minimum inflate both tracks and push the grid's right edge
        // out of line with sibling rows; minmax(0, 1fr) removes the auto floor.
        expect(declarationsFor(styleCss, '.image-picker-grid')).toMatch(
            /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
        );
    });
});

describe('selection glow CSS', () => {
    it('defines --selection-glow on :root (light glow for dark backgrounds)', () => {
        expect(declarationsFor(styleCss, ':root')).toMatch(
            /--selection-glow:\s*var\(--color-violet-lighter\)/,
        );
    });

    it('flips --selection-glow dark in the light-scheme block', () => {
        expect(declarationsFor(styleCss, '[data-ui-scheme="light"]')).toMatch(
            /--selection-glow:\s*var\(--color-violet-darker\)/,
        );
    });

    it('drives the selection glow off --selection-glow, not --ui-accent', () => {
        for (const selector of [
            '[data-group-id].selected',
            '[data-group-id].selected.dragging',
        ]) {
            const body = declarationsFor(styleCss, selector);
            // Three glow layers, each mixing --selection-glow with transparent.
            const glowLayers = body.match(/var\(--selection-glow\)/g) ?? [];
            expect(glowLayers.length, `${selector} glow layers`).toBe(3);
            // The fixed chrome accent must not sneak back into the glow.
            expect(body, `${selector} must not reference --ui-accent`).not.toMatch(
                /--ui-accent/,
            );
        }
    });
});

describe('group layer promotion CSS', () => {
    it('promotes every group to its own layer', () => {
        expect(declarationsFor(styleCss, '[data-group-id]')).toMatch(
            /will-change:\s*transform/,
        );
    });

    it('filters idle groups through the idle edge filter (#687)', () => {
        expect(declarationsFor(styleCss, '[data-group-id]')).toMatch(
            /filter:\s*var\(--piece-edge-idle-filter,/,
        );
    });

    it('composes state variants onto --piece-edge-filter, never the idle filter', () => {
        for (const selector of [
            '[data-group-id].selected',
            '[data-group-id].selected.dragging',
            '[data-group-id].dragging',
        ]) {
            const body = declarationsFor(styleCss, selector);
            expect(body, selector).toMatch(/filter:\s*var\(--piece-edge-filter,/);
            expect(body, selector).not.toMatch(/--piece-edge-idle-filter/);
        }
        const pulse = /@keyframes merge-pulse\s*\{([\s\S]*?)\n\}/.exec(styleCss)?.[1] ?? '';
        expect(pulse.match(/var\(--piece-edge-filter,/g), 'merge-pulse frames').toHaveLength(2);
        // WebKit composites a filter list only when its drop-shadow comes last (#704).
        expect(
            pulse.match(/var\(--piece-edge-filter, opacity\(1\)\);/g),
            'edge filter last in each merge-pulse frame',
        ).toHaveLength(2);
        expect(pulse, 'merge-pulse').not.toMatch(/--piece-edge-idle-filter/);
    });

    it('strokes the outline from its wrapper so ring references can take their own stroke', () => {
        const wrapper = declarationsFor(styleCss, '[data-edge-outline]');
        expect(wrapper).toMatch(/stroke:\s*var\(--piece-outline-color, #080808\)/);
        expect(wrapper).toMatch(/stroke-width:\s*calc\(3px \* var\(--outline-stroke-scale, 1\)\)/);
        expect(declarationsFor(styleCss, '[data-outline-underlay] path')).not.toMatch(/stroke:|stroke-width:/);
    });

    it('hides rings and the outline wrapper unless something shows them', () => {
        const ring = declarationsFor(styleCss, '[data-ring]');
        expect(ring).toMatch(/display:\s*none/);
        expect(ring).toMatch(/fill:\s*none/);
        expect(declarationsFor(styleCss, '[data-edge-outline]')).toMatch(/display:\s*none/);
        expect(declarationsFor(styleCss, '[data-piece-outline="outline"] [data-edge-outline]')).toMatch(
            /display:\s*inline/,
        );
    });

    it('drops the group layers while the table is relayering (#680)', () => {
        expect(declarationsFor(styleCss, '[data-puzzle-table].relayer [data-group-id]')).toMatch(
            /will-change:\s*auto/,
        );
    });

    it('falls back to no idle filter before the edge setting is applied', () => {
        expect(declarationsFor(styleCss, '[data-group-id]')).toMatch(
            /filter:\s*var\(--piece-edge-idle-filter,\s*none\)/,
        );
    });
});

describe('outline underlay CSS', () => {
    it('hides the underlay unless the Outline preset is active', () => {
        expect(declarationsFor(styleCss, '[data-outline-underlay]')).toMatch(/display:\s*none/);
        expect(
            declarationsFor(styleCss, '[data-piece-outline="outline"] [data-outline-underlay]'),
        ).toMatch(/display:\s*block/);
    });

    it('lets the underlay overflow its box and ignore pointers', () => {
        const body = declarationsFor(styleCss, '[data-outline-underlay]');
        expect(body).toMatch(/overflow:\s*visible/);
        expect(body).toMatch(/pointer-events:\s*none/);
    });

    it('leaves the edge paths unfilled', () => {
        expect(declarationsFor(styleCss, '[data-outline-underlay] path')).toMatch(/fill:\s*none/);
    });

    it('declares the stroke width in one place', () => {
        expect(styleCss.match(/stroke-width:[^;]*3px/g)).toHaveLength(1);
    });

    it('scales the stroke by the zoom compensation only in constant-width mode', () => {
        expect(declarationsFor(styleCss, '[data-outline-underlay]')).not.toMatch(
            /--outline-zoom-comp/,
        );
        expect(
            declarationsFor(styleCss, '[data-outline-constant-width] [data-outline-underlay]'),
        ).toMatch(/--outline-stroke-scale:\s*var\(--outline-zoom-comp, 1\)/);
    });
});

describe('first-paint background', () => {
    it('paints the default swatch, in the current OS theme, before JS runs', () => {
        expect(declarationsFor(styleCss, ':root')).toContain(
            `--puzzle-bg-color: var(--color-${DEFAULT_COLOR_ID});`,
        );
    });
});

describe('blank-piece CSS', () => {
    it('paints blank pieces from the --piece-blank-fill variable', () => {
        expect(declarationsFor(styleCss, '[data-piece-blank]')).toMatch(
            /fill:\s*var\(--piece-blank-fill\)/,
        );
    });

    it('defines --piece-blank-fill as white, in exactly one place', () => {
        // Nothing in TS names this color, so this stops a blank puzzle
        // rendering SVG-default black if the declaration is dropped. The count
        // pins "one definition" — a prefers-color-scheme override (which must
        // never exist) would land as a second occurrence.
        expect(declarationsFor(styleCss, ':root')).toMatch(
            /--piece-blank-fill:\s*#ffffff/,
        );
        expect(styleCss.match(/--piece-blank-fill:/g)).toHaveLength(1);
    });

    it('applies the debug opacity slider to blank pieces too', () => {
        expect(declarationsFor(styleCss, '[data-piece-blank]')).toMatch(
            /opacity:\s*var\(--piece-opacity\)/,
        );
    });

    it('hides blank pieces when the debug piece view is on', () => {
        expect(declarationsFor(styleCss, '.show-debug-pieces [data-piece-blank]')).toMatch(
            /display:\s*none/,
        );
    });
});

function pxValue(selector: string, property: string): number {
    const match = new RegExp(`\\s${property}:\\s*(\\d+)(?:px)?\\s*;`).exec(declarationsFor(styleCss, selector));
    expect(match, `${selector} ${property}`).not.toBeNull();
    return Number(match![1]);
}

describe('overlay stacking', () => {
    it('draws Puzzle Complete no lower than the dialogs it can open on top of', () => {
        const completion = pxValue('.completion-overlay', 'z-index');
        expect(completion).toBeGreaterThanOrEqual(pxValue('.info-modal-overlay', 'z-index'));
        expect(completion).toBeGreaterThanOrEqual(pxValue('.size-picker-overlay', 'z-index'));
    });
});
