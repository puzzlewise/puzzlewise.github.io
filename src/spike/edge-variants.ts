import { applyPieceOutline } from '../ui/piece-outline.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'spike-edge-variant';
const FIXED_KEY = 'spike-edge-fixed';
const BLUR_STD_DEVIATION = 2;

const VARIANTS: readonly { id: string; label: string; preset?: string }[] = [
    { id: 'current-none', label: 'Current: None', preset: 'none' },
    { id: 'current-shadow', label: 'Current: Shadow', preset: 'shadow' },
    { id: 'current-outline', label: 'Current: Outline', preset: 'outline' },
    { id: 'stroke', label: 'New: Outline (stroke)' },
    { id: 'stroke-2tone', label: 'New: Outline (two-tone)' },
    { id: 'shadow-blur', label: 'New: Shadow (blur)' },
    { id: 'shadow-rings', label: 'New: Shadow (rings)' },
];

let zoomComp = 1;

export function installEdgeVariantSpike(): void {
    installBlurFilter();
    const fixed = localStorage.getItem(FIXED_KEY) !== 'off';
    document.documentElement.dataset.edgeFixed = fixed ? 'on' : 'off';
    applyVariant(localStorage.getItem(STORAGE_KEY) ?? 'current-none');
    installPicker(fixed);
    (window as { __edgeVariant?: unknown }).__edgeVariant = (id: string, fixedOn?: boolean) => {
        if (fixedOn !== undefined) setFixed(fixedOn);
        applyVariant(id);
    };
}

export function setEdgeZoomComp(comp: number): void {
    zoomComp = comp;
    const table = document.querySelector<HTMLElement>('[data-puzzle-table]');
    table?.style.setProperty('--edge-zoom-comp', String(comp));
    updateBlur();
}

function applyVariant(id: string): void {
    const variant = VARIANTS.find((v) => v.id === id) ?? VARIANTS[0];
    localStorage.setItem(STORAGE_KEY, variant.id);
    document.documentElement.dataset.edgeVariant = variant.id;
    if (variant.preset) {
        applyPieceOutline(variant.preset);
    } else {
        const { style } = document.documentElement;
        style.setProperty('--piece-edge-filter', 'opacity(1)');
        style.setProperty('--piece-edge-idle-filter', 'none');
    }
    const select = document.querySelector<HTMLSelectElement>('[data-edge-spike-select]');
    if (select) select.value = variant.id;
}

function setFixed(on: boolean): void {
    localStorage.setItem(FIXED_KEY, on ? 'on' : 'off');
    document.documentElement.dataset.edgeFixed = on ? 'on' : 'off';
    const box = document.querySelector<HTMLInputElement>('[data-edge-spike-fixed]');
    if (box) box.checked = on;
    updateBlur();
}

function updateBlur(): void {
    const blur = document.getElementById('edge-spike-blur-std');
    const fixed = document.documentElement.dataset.edgeFixed === 'on';
    blur?.setAttribute('stdDeviation', String(BLUR_STD_DEVIATION * (fixed ? zoomComp : 1)));
}

function installPicker(fixed: boolean): void {
    const bar = document.createElement('div');
    bar.style.cssText = 'position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 10000; display: flex; gap: 8px; align-items: center; padding: 4px 8px; border-radius: 8px; background: rgba(0, 0, 0, 0.6); color: #fff; font: 13px system-ui;';

    const select = document.createElement('select');
    select.dataset.edgeSpikeSelect = '';
    select.style.font = '13px system-ui';
    for (const v of VARIANTS) {
        const option = document.createElement('option');
        option.value = v.id;
        option.textContent = v.label;
        select.appendChild(option);
    }
    select.value = document.documentElement.dataset.edgeVariant ?? VARIANTS[0].id;
    select.addEventListener('change', () => applyVariant(select.value));

    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = fixed;
    box.dataset.edgeSpikeFixed = '';
    box.addEventListener('change', () => setFixed(box.checked));
    label.append(box, ' Same width at any zoom');

    bar.append(select, label);
    document.body.appendChild(bar);
}

function installBlurFilter(): void {
    const host = document.createElementNS(SVG_NS, 'svg');
    host.setAttribute('width', '0');
    host.setAttribute('height', '0');
    host.setAttribute('aria-hidden', 'true');
    host.style.position = 'absolute';
    host.innerHTML = `<defs><filter id="edge-spike-blur" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur id="edge-spike-blur-std" stdDeviation="${BLUR_STD_DEVIATION}"/></filter></defs>`;
    document.body.appendChild(host);
}
