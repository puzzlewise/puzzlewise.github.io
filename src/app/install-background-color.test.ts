/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installBackgroundColor } from './install-background-color.js';
import { BACKGROUND_COLOR_PRESETS, COLOR_PREFERENCE_KEY, DEFAULT_COLOR_ID } from '../ui/background-color.js';

/** A preset other than the default, so a switch actually changes something. */
const OTHER_PRESET = BACKGROUND_COLOR_PRESETS.find((p) => p.id !== DEFAULT_COLOR_ID)!;
/** A third preset, distinct from both the default and {@link OTHER_PRESET}. */
const THIRD_PRESET = BACKGROUND_COLOR_PRESETS.find(
    (p) => p.id !== DEFAULT_COLOR_ID && p.id !== OTHER_PRESET.id,
)!;

describe('installBackgroundColor', () => {
    let container: HTMLElement;
    let umamiTrack: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
        umamiTrack = vi.fn();
        (window as unknown as { umami: { track: typeof umamiTrack } }).umami = { track: umamiTrack };
    });

    afterEach(() => {
        delete (window as unknown as { umami?: unknown }).umami;
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    it('renders the picker into the container', () => {
        installBackgroundColor({ container });
        expect(container.querySelector('.bg-color-button')).not.toBeNull();
    });

    it('applies the saved piece-outline settings', () => {
        localStorage.setItem('puzzle-piece-outline', 'shadow');
        localStorage.setItem('puzzle-outline-constant-width', 'true');
        localStorage.setItem('puzzle-effects', 'simple');
        document.documentElement.removeAttribute('data-outline-constant-width');
        delete document.documentElement.dataset.effects;

        installBackgroundColor({ container });

        expect(document.documentElement.dataset.pieceOutline).toBe('shadow');
        expect(document.documentElement.hasAttribute('data-outline-constant-width')).toBe(true);
        expect(document.documentElement.dataset.effects).toBe('simple');
    });

    it('reports an adopted shared color', () => {
        const control = installBackgroundColor({ container });
        expect(control.adopt(OTHER_PRESET.id)).toBe('adopted');
    });

    it('reports an unrecognized shared color as invalid', () => {
        // Palette drift that silently drops a live link's color must stay
        // visible in analytics.
        const control = installBackgroundColor({ container });
        expect(control.adopt('not-a-real-preset')).toBe('invalid');
    });

    it('keeps the recipient’s own color when they already picked one', () => {
        // Seed a preference *before* install, so the recipient looks like
        // someone who already chose a color.
        localStorage.setItem(COLOR_PREFERENCE_KEY, OTHER_PRESET.id);
        const control = installBackgroundColor({ container });

        expect(control.adopt(THIRD_PRESET.id)).toBe('kept-own');
    });

    it('reports a color switch with from and to ids', () => {
        installBackgroundColor({ container });
        (container.querySelector('.bg-color-button') as HTMLElement).click();
        const swatch = document.querySelector(`[data-swatch-id="${OTHER_PRESET.id}"]`);
        (swatch as HTMLElement | null)?.click();

        expect(umamiTrack).toHaveBeenCalledWith(
            'background-color-changed',
            { from: DEFAULT_COLOR_ID, to: OTHER_PRESET.id },
        );
    });

    it('does not report re-selecting the current swatch', () => {
        installBackgroundColor({ container });
        (container.querySelector('.bg-color-button') as HTMLElement).click();
        // Fresh install with no saved preference selects the default.
        const current = document.querySelector(`[data-swatch-id="${DEFAULT_COLOR_ID}"]`);
        (current as HTMLElement | null)?.click();

        expect(umamiTrack).not.toHaveBeenCalledWith('background-color-changed', expect.anything());
    });

    it('updates the picker’s selection when a shared color is adopted', () => {
        // Pins the picker half of adopt(): re-opening after adopt() shows the
        // adopted swatch, not the id the picker was created with.
        const control = installBackgroundColor({ container });
        expect(control.adopt(OTHER_PRESET.id)).toBe('adopted');

        (container.querySelector('.bg-color-button') as HTMLElement).click();
        const selected = document.querySelector('.bg-color-panel [aria-selected="true"]');
        expect(selected?.getAttribute('data-swatch-id')).toBe(OTHER_PRESET.id);
    });

    it('re-applies the adopted color, not the original, on a theme flip', () => {
        // Pins the id half of adopt(): the OS-theme handler closes over the id
        // adopt() updates, so a flip after adopting re-applies the adopted
        // color, not whatever was current when the handler was created.
        let onChange: (() => void) | undefined;
        vi.stubGlobal('matchMedia', () => ({
            matches: false,
            addEventListener: (_event: string, cb: () => void) => {
                onChange = cb;
            },
            removeEventListener: vi.fn(),
        }));

        const control = installBackgroundColor({ container });
        expect(control.adopt(OTHER_PRESET.id)).toBe('adopted');
        expect(document.documentElement.style.getPropertyValue('--puzzle-bg-color')).toBe(
            OTHER_PRESET.color,
        );

        expect(onChange).toBeDefined();
        onChange?.();

        expect(document.documentElement.style.getPropertyValue('--puzzle-bg-color')).toBe(
            OTHER_PRESET.color,
        );
    });
});
