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

    it('the color variables the WebGL appearance resolver reads are still defined', () => {
        const root = declarationsFor(styleCss, ':root');
        for (const name of ['--selection-glow', '--puzzle-bg-color']) {
            expect(root, name).toMatch(new RegExp(`${name}:`));
        }
    });
});

describe('first-paint background', () => {
    it('paints the default swatch, in the current OS theme, before JS runs', () => {
        expect(declarationsFor(styleCss, ':root')).toContain(
            `--puzzle-bg-color: var(--color-${DEFAULT_COLOR_ID});`,
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

function mediaBody(query: string): string {
    const start = styleCss.indexOf(`@media ${query}`);
    expect(start, query).toBeGreaterThanOrEqual(0);
    const open = styleCss.indexOf('{', start);
    return styleCss.slice(open + 1, matchingBrace(styleCss, open));
}

describe('right-hand toolbar', () => {
    const shortScreen = mediaBody('(max-height: 400px)');

    it('wraps into new columns to the left instead of overlapping', () => {
        const body = declarationsFor(styleCss, '.right-toolbar');
        expect(body).toMatch(/flex-direction:\s*column/);
        expect(body).toMatch(/flex-wrap:\s*wrap-reverse/);
        expect(body).toMatch(/pointer-events:\s*none/);
    });

    it('opens the background panel on its own button, wherever the column puts it', () => {
        const anchor = declarationsFor(styleCss, '.swatch-anchor');
        expect(anchor).toMatch(/position:\s*relative/);
        expect(anchor, 'no line box around the button').toMatch(/display:\s*flex/);
        const panel = declarationsFor(styleCss, '.bg-color-panel');
        expect(panel).toMatch(/(^|[\s;])top:\s*0;/);
        expect(panel).toMatch(/(^|[\s;])right:\s*0;/);
        expect(shortScreen).not.toContain('.bg-color-panel');
    });

    it('gives the background panel the toolbar inset as its margin on both sides', () => {
        expect(declarationsFor(styleCss, '.right-toolbar')).toMatch(/--toolbar-inset:\s*12px/);
        expect(declarationsFor(shortScreen, '.right-toolbar')).toMatch(/--toolbar-inset:\s*8px/);
        expect(declarationsFor(styleCss, '.right-toolbar')).toMatch(/inset:\s*var\(--toolbar-inset\)/);
        expect(declarationsFor(styleCss, '.bg-color-panel')).toMatch(
            /width:\s*min\(440px,\s*calc\(100vw - 2 \* var\(--toolbar-inset\)\)\)/,
        );
    });

    it('positions the background button so its z-index applies inside the anchor', () => {
        const body = declarationsFor(styleCss, '.bg-color-button');
        expect(body).toMatch(/z-index:\s*9999/);
        expect(body).toMatch(/position:\s*relative/);
    });

    it.each([
        '.new-game-button',
        '.gather-pieces-button',
        '.bg-color-button',
        '.help-button',
        '.settings-button',
    ])('sizes %s like the tool buttons, at any screen height', (selector) => {
        for (const [css, size] of [[styleCss, '40px'], [shortScreen, '34px']] as const) {
            const tool = declarationsFor(css, '.select-tool-button');
            const body = declarationsFor(css, selector);
            for (const declarations of [tool, body]) {
                expect(declarations).toContain(`width: ${size}`);
                expect(declarations).toContain(`height: ${size}`);
            }
        }
    });

    it.each([
        '.new-game-button',
        '.gather-pieces-button',
        '.bg-color-button',
        '.help-button',
        '.settings-button',
    ])('leaves %s to the flex layout, at any screen height', (selector) => {
        for (const css of [styleCss, shortScreen]) {
            const body = declarationsFor(css, selector);
            expect(body).not.toMatch(/position:\s*absolute/);
            expect(body).not.toMatch(/(^|[\s;])top:/);
        }
    });
});
