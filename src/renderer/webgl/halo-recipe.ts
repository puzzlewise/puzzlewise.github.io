import type { Rgba, RendererAppearance } from '../appearance.js';

export const HALO_STATES = ['idle', 'selected', 'dragging', 'selected-dragging'] as const;
export type HaloState = (typeof HALO_STATES)[number];

/**
 * `sigma` is in world units and equals the CSS drop-shadow blur length: Chromium
 * blurs with that standard deviation (measured), as Filter Effects specifies,
 * not half of it as box-shadow does. `color` is opaque RGB and `alpha` the full
 * step opacity.
 */
export interface HaloStep {
    sigma: number;
    color: Rgba;
    alpha: number;
    /** Marks the Shadow preset's leading step, which does not set the halo resolution. */
    prefix?: true;
}

const shadowPreset = (): HaloStep => ({ sigma: 4, color: [0, 0, 0, 1], alpha: 0.35, prefix: true });
const dragShadow = (): HaloStep => ({ sigma: 12, color: [0, 0, 0, 1], alpha: 0.45 });
const GLOW_LAYERS = [
    { sigma: 6, alpha: 0.9 },
    { sigma: 14, alpha: 0.7 },
    { sigma: 24, alpha: 0.4 },
] as const;

export function haloSteps(
    state: HaloState,
    outline: RendererAppearance['outline'],
    glow: Rgba,
): readonly HaloStep[] {
    const steps: HaloStep[] = [];
    if (state === 'dragging' || state === 'selected-dragging') steps.push(dragShadow());
    if (state === 'selected' || state === 'selected-dragging') {
        for (const layer of GLOW_LAYERS) {
            steps.push({ sigma: layer.sigma, color: [glow[0], glow[1], glow[2], 1], alpha: layer.alpha * glow[3] });
        }
    }
    if (outline === 'shadow') steps.unshift(shadowPreset());
    return steps;
}

export function gaussianKernel(sigma: number, texelsPerUnit: number): Float32Array {
    const sigmaTexels = sigma * texelsPerUnit;
    const radius = Math.ceil(3 * sigmaTexels);
    const kernel = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const w = Math.exp(-(i * i) / (2 * sigmaTexels * sigmaTexels));
        kernel[i + radius] = w;
        sum += w;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum;
    return kernel;
}

export function haloMargin(steps: readonly HaloStep[]): number {
    let margin = 0;
    for (const step of steps) margin += 3 * step.sigma;
    return margin;
}

export function haloTexelsPerUnit(steps: readonly HaloStep[]): number {
    const others = steps.filter((s) => !s.prefix);
    const considered = others.length > 0 ? others : steps;
    if (considered.length === 0) return 1;
    const sigmaMin = Math.min(...considered.map((s) => s.sigma));
    return Math.min(1, 1.5 / sigmaMin);
}
