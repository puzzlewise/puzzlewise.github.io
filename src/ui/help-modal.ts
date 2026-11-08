import type { GameState } from '../model/types.js';
import { createModalShell } from './modal-shell.js';
import { buildShareSection } from './share-section.js';
import { createSelectToolIcon, createMarqueeToolIcon } from './tool-icons.js';
import { track } from '../analytics/index.js';

export interface HelpModalOptions {
    container: HTMLElement;
    /** Current game state; when provided, a "Share this puzzle" section is rendered. */
    state?: GameState;
}

/** Keeps the static help-text builders compact without resorting to innerHTML. */
type InlineNode = string | Node | [tag: string, text: string, attrs?: Record<string, string>];

function inlineToolIcon(svg: SVGSVGElement): SVGSVGElement {
    svg.classList.add('info-inline-icon');
    return svg;
}

function appendInlineLi(parent: HTMLElement, parts: InlineNode[]): HTMLLIElement {
    const li = document.createElement('li');
    appendInline(li, parts);
    parent.appendChild(li);
    return li;
}

function appendInline(target: HTMLElement, parts: InlineNode[]): void {
    for (const part of parts) {
        if (typeof part === 'string') {
            target.appendChild(document.createTextNode(part));
            continue;
        }
        if (part instanceof Node) {
            target.appendChild(part);
            continue;
        }
        const [tag, text, attrs] = part;
        const el = document.createElement(tag);
        el.textContent = text;
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
                el.setAttribute(k, v);
            }
        }
        target.appendChild(el);
    }
}

function createSection(title: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'info-section';

    const heading = document.createElement('h3');
    heading.textContent = title;
    section.appendChild(heading);
    return section;
}

function buildHowToPlaySection(): HTMLElement {
    const section = createSection('How to Play');

    const list = document.createElement('ul');
    appendInlineLi(list, [['strong', 'Drag pieces'], ' to move them around']);
    appendInlineLi(list, [['strong', 'Drop near matching edges'], ' to merge pieces']);
    appendInlineLi(list, [['strong', 'Pinch to zoom'], ' (or scroll wheel)']);
    appendInlineLi(list, [['strong', 'Drag the background'], ' to move your view around']);
    appendInlineLi(list, [['strong', 'Use the buttons'], ' for convenience:']);

    const buttons = document.createElement('ul');
    appendInlineLi(buttons, [
        ['strong', 'New Game'],
        ' — Choose puzzle size, cut style and picture type, then tap one of the suggested photos to start (↻ swaps them for a new set) — or ',
        ['strong', 'Surprise me'],
        ' for a fresh random photo. Tick ',
        ['strong', 'Vibrant colours'],
        ' for more saturated photos. Going offline? Tap ',
        ['strong', 'Download'],
        ' next to ',
        ['strong', 'Offline photos'],
        ' first — new puzzles will use the downloaded photos while you have no connection.',
    ]);
    appendInlineLi(buttons, [
        ['strong', 'Gather Pieces'],
        ' — Organize all pieces in a compact grid. With pieces selected, the selection and the rest are gathered into two separate piles.',
    ]);
    appendInlineLi(buttons, ['🎨 ', ['strong', 'Background'], ' — Change table colour']);
    appendInlineLi(buttons, ['⚙️ ', ['strong', 'Settings'], ' — Snap distance, piece outlines, effects and more']);
    appendInlineLi(buttons, [
        inlineToolIcon(createSelectToolIcon()),
        ' ',
        ['strong', 'Multi-select'],
        ' (top-left) — When active, tap pieces to add/remove them from a selection; drag any selected piece to move the whole selection together. Tap ✕ (bottom) to deselect all.',
    ]);
    appendInlineLi(buttons, [
        inlineToolIcon(createMarqueeToolIcon()),
        ' ',
        ['strong', 'Marquee'],
        ' (below Multi-select) — Turns on multi-select and lets you drag a box on empty space to select every group it covers (turn on ',
        ['strong', 'Enclose to select'],
        ' in Settings to require a group be fully inside the box). Turning the marquee off leaves your selection untouched. On a computer you can also hold Shift and drag a box without switching the button on.',
    ]);
    appendInlineLi(buttons, [
        '↺ ↻ ',
        ['strong', 'Rotate'],
        ' (when rotation is enabled) — Tap any piece to bring up rotation controls next to it. With ',
        ['strong', '90° rotation'],
        ' (Fractal puzzles), the ↺ / ↻ buttons rotate the focused piece by a quarter-turn. With ',
        ['strong', 'Free rotation'],
        " (Classic, Wavy and Triangles puzzles), a single round handle below the focused piece lets you drag to rotate continuously — the piece follows your finger like a dial. Pieces snap together when their rotations are close to alignment; how close they need to be depends on your ",
        ['strong', 'Snap distance'],
        ' setting.',
    ]);
    list.appendChild(buttons);

    section.appendChild(list);
    return section;
}

function buildCreditsSection(): HTMLElement {
    const section = createSection('Credits');

    const intro = document.createElement('p');
    intro.textContent = 'Algorithm inspirations:';
    section.appendChild(intro);

    const list = document.createElement('ul');
    appendInlineLi(list, [
        ['strong', 'Classic jigsaw cuts'],
        ' — inspired by ',
        [
            'a',
            "Dillon's CodePen",
            { href: 'https://codepen.io/Dillo/pen/QWKLYab', target: '_blank', rel: 'noopener' },
        ],
    ]);
    appendInlineLi(list, [
        ['strong', 'Fractal cuts'],
        ' — inspired by ',
        [
            'a',
            'Fractal Jigsaw Generator',
            {
                href: 'https://github.com/proceduraljigsaw/Fractalpuzzlejs',
                target: '_blank',
                rel: 'noopener',
            },
        ],
    ]);
    section.appendChild(list);
    return section;
}

function buildAboutSection(): HTMLElement {
    const section = createSection('About');

    const list = document.createElement('ul');
    appendInlineLi(list, [
        ['strong', 'Project:'],
        ' ',
        [
            'a',
            'github.com/puzzlewise/puzzlewise.github.io',
            { href: 'https://github.com/puzzlewise/puzzlewise.github.io', target: '_blank', rel: 'noopener' },
        ],
    ]);
    appendInlineLi(list, [['strong', 'License:'], ' MIT']);
    appendInlineLi(list, [
        ['strong', 'Images:'],
        ' ',
        ['a', 'Unsplash', { href: 'https://unsplash.com', target: '_blank', rel: 'noopener' }],
        ' (photographer credited per image)',
    ]);
    section.appendChild(list);
    return section;
}

export function createHelpModal(options: HelpModalOptions): void {
    const { container, state } = options;

    createModalShell({
        container,
        title: 'Help',
        buildContent: () => [
            ...(state ? [buildShareSection(state, window.location.href)] : []),
            buildHowToPlaySection(),
            buildCreditsSection(),
            buildAboutSection(),
        ],
        onClosed: (closedBy, stats) => track('help-modal-closed', { closedBy, ...stats }),
    });

    track('help-modal-opened', {});
}
