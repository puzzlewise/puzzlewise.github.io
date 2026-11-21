const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvg(extraAttrs?: Record<string, string>): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs: Record<string, string> = {
        width: '20',
        height: '20',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        ...extraAttrs,
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    return svg;
}

function appendChild(
    svg: SVGSVGElement,
    tag: string,
    attrs: Record<string, string>,
): void {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
}

export function createSelectToolIcon(): SVGSVGElement {
    const svg = makeSvg();
    appendChild(svg, 'path', {
        d: 'M7 3C4.239 3 2 5.216 2 8c0 2.784 2.239 5 5 5h10c2.761 0 5-2.216 5-5s-2.239-5-5-5H7z',
    });
    appendChild(svg, 'path', { d: 'M2 8v5c0 2.784 2.239 5 5 5' });
    appendChild(svg, 'line', { x1: '7', y1: '18', x2: '7', y2: '22' });
    appendChild(svg, 'line', { x1: '5', y1: '22', x2: '9', y2: '22' });
    return svg;
}

export function createMarqueeToolIcon(): SVGSVGElement {
    const svg = makeSvg({ 'stroke-dasharray': '4 3' });
    appendChild(svg, 'rect', { x: '3', y: '3', width: '18', height: '18', rx: '1.5' });
    return svg;
}

export function createDeselectIcon(): SVGSVGElement {
    const svg = makeSvg({ width: '22', height: '22', 'stroke-width': '2.5' });
    appendChild(svg, 'line', { x1: '18', y1: '6', x2: '6', y2: '18' });
    appendChild(svg, 'line', { x1: '6', y1: '6', x2: '18', y2: '18' });
    return svg;
}

export function createRotateIcon(direction: 'cw' | 'ccw'): SVGSVGElement {
    const svg = makeSvg(direction === 'ccw' ? { transform: 'scale(-1,1)' } : undefined);
    appendChild(svg, 'path', { d: 'M21 12a9 9 0 1 1-3.1-6.8' });
    appendChild(svg, 'polyline', { points: '21 3 21 9 15 9' });
    return svg;
}

// Shapes below are from Lucide 1.77.0 (ISC; plus and x via Feather, MIT). Notices: THIRD-PARTY-NOTICES.md.

export function createNewGameIcon(): SVGSVGElement {
    return fromShapes([
        ['path', { d: 'M5 12h14' }],
        ['path', { d: 'M12 5v14' }],
    ]);
}

export function createGatherPiecesIcon(): SVGSVGElement {
    return fromShapes([
        ['rect', { width: '7', height: '7', x: '3', y: '3', rx: '1' }],
        ['rect', { width: '7', height: '7', x: '14', y: '3', rx: '1' }],
        ['rect', { width: '7', height: '7', x: '14', y: '14', rx: '1' }],
        ['rect', { width: '7', height: '7', x: '3', y: '14', rx: '1' }],
    ]);
}

export function createBackgroundIcon(): SVGSVGElement {
    return fromShapes([
        ['path', { d: 'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z' }],
        ['circle', { cx: '13.5', cy: '6.5', r: '.5', fill: 'currentColor' }],
        ['circle', { cx: '17.5', cy: '10.5', r: '.5', fill: 'currentColor' }],
        ['circle', { cx: '6.5', cy: '12.5', r: '.5', fill: 'currentColor' }],
        ['circle', { cx: '8.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
    ]);
}

export function createHelpIcon(): SVGSVGElement {
    return fromShapes([
        ['circle', { cx: '12', cy: '12', r: '10' }],
        ['path', { d: 'M9 9.5a3 2.5 0 016 0c0 2-2 2-3 3.5' }],
        ['path', { d: 'M12 17h.01' }],
    ]);
}

export function createSettingsIcon(): SVGSVGElement {
    return fromShapes([
        ['path', { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }],
        ['circle', { cx: '12', cy: '12', r: '3' }],
    ]);
}

export function createRefreshIcon(): SVGSVGElement {
    return fromShapes([
        ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
        ['path', { d: 'M21 3v5h-5' }],
        ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
        ['path', { d: 'M8 16H3v5' }],
    ]);
}

export function createSurpriseIcon(): SVGSVGElement {
    return fromShapes([
        ['rect', { width: '12', height: '12', x: '2', y: '10', rx: '2', ry: '2' }],
        ['path', { d: 'm17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6' }],
        ['path', { d: 'M6 18h.01' }],
        ['path', { d: 'M10 14h.01' }],
        ['path', { d: 'M15 6h.01' }],
        ['path', { d: 'M18 9h.01' }],
    ]);
}

export function createCloseIcon(): SVGSVGElement {
    return fromShapes([
        ['path', { d: 'M18 6 6 18' }],
        ['path', { d: 'm6 6 12 12' }],
    ]);
}

export function createCelebrationIcon(): SVGSVGElement {
    return fromShapes([
        ['path', { d: 'M5.8 11.3 2 22l10.7-3.79' }],
        ['path', { d: 'M4 3h.01' }],
        ['path', { d: 'M22 8h.01' }],
        ['path', { d: 'M15 2h.01' }],
        ['path', { d: 'M22 20h.01' }],
        ['path', { d: 'm22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10' }],
        ['path', { d: 'm22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17' }],
        ['path', { d: 'm11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7' }],
        ['path', { d: 'M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z' }],
    ]);
}

type Shape = readonly [tag: string, attrs: Record<string, string>];

function fromShapes(shapes: readonly Shape[]): SVGSVGElement {
    const svg = makeSvg();
    for (const [tag, attrs] of shapes) {
        appendChild(svg, tag, attrs);
    }
    return svg;
}
