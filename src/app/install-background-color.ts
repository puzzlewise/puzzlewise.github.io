/**
 * The background-color state: selected preset id, swatch picker, OS-theme
 * re-apply, and the piece-outline setup (here because it installs at the same
 * boot point).
 *
 * `currentColorId` has two readers — the OS-theme change handler (recomputes
 * the luminance-derived chrome on a light/dark flip) and the share-link path
 * (offers a sharer's color to a recipient who never picked one). Consolidating
 * both behind one `adopt()` stops the pre-existing split where updating the
 * global but not the picker left the theme handler re-applying a stale color.
 */

import {
    loadColorPreference,
    saveColorPreference,
    applyBackgroundColor,
    adoptSharedBackgroundColor,
    onColorSchemeChange,
    createBackgroundColorPicker,
    loadPieceOutlinePreference,
    applyPieceOutline,
    loadPieceOutlineColorPreference,
    applyPieceOutlineColor,
    loadOutlineConstantWidthPreference,
    applyOutlineConstantWidth,
    loadEffectsPreference,
    applyEffects,
    type SharedColorOutcome,
} from '../ui/index.js';
import { track } from '../analytics/index.js';

export interface BackgroundColorControl {
    /**
     * Offer a sharer's color to a recipient who never picked one. Returns the
     * adoption outcome for analytics ('none' — no color in the link — is the
     * caller's business). On 'adopted', updates both the closed-over id and the
     * picker's selection, the pair that keeps a later OS-theme re-apply correct.
     */
    adopt(id: string): SharedColorOutcome;
}

export function installBackgroundColor(deps: {
    container: HTMLElement;
}): BackgroundColorControl {
    const { container } = deps;

    // The outline color flips with the OS theme via CSS, so (unlike the
    // background) it needs no re-apply on theme change.
    applyPieceOutline(loadPieceOutlinePreference());
    applyPieceOutlineColor(loadPieceOutlineColorPreference());
    applyOutlineConstantWidth(loadOutlineConstantWidthPreference());
    applyEffects(loadEffectsPreference());

    let currentColorId = loadColorPreference();
    applyBackgroundColor(currentColorId);

    // The background color flips with the OS theme via CSS; re-apply only
    // to recompute the luminance-derived UI-chrome scheme on the flip.
    onColorSchemeChange(() => applyBackgroundColor(currentColorId));

    const picker = createBackgroundColorPicker({
        container,
        selectedId: currentColorId,
        onSelect: (id) => {
            // Re-selecting the current swatch is a no-op, not a switch.
            if (id !== currentColorId) {
                track('background-color-changed', { from: currentColorId, to: id });
            }
            currentColorId = id;
            saveColorPreference(id);
            applyBackgroundColor(id);
        },
    });

    return {
        adopt(id: string): SharedColorOutcome {
            const outcome = adoptSharedBackgroundColor(id);
            if (outcome === 'adopted') {
                currentColorId = id;
                picker.setSelected(id);
            }
            return outcome;
        },
    };
}
