// Barrel for `src/ui/`: modules consumed from outside `src/ui/` are re-exported
// here; deep imports between files inside `src/ui/` are fine. An options type is
// re-exported alongside the function that takes it; a caller-only result type is not.
//
// `preference-store.ts` is deliberately NOT re-exported: `game/` uses it directly
// and some of those load transitively through this barrel, so routing it here
// would create an import cycle.
//
// Mocking this barrel needs the `importOriginal` passthrough form — the module
// under test reaches other names here too (often transitively), else the run
// fails with "No export is defined on the mock". Type-only names are erased;
// value names pass through unchanged.
//
// UI factory return shape: default to a cleanup fn `() => void` (component
// self-manages from injected deps); return `{ ...handlers; destroy }` only when
// external collaborators must drive state with no reactive source to subscribe
// (e.g. `createRotateButtons` show()/hide(), driven by the host's cut style).

export {
    shouldConfirmNewGame,
    createNewGameButton,
} from './new-game-button.js';
export type { NewGameButtonOptions } from './new-game-button.js';

export { createGatherPiecesButton } from './gather-pieces-button.js';
export type { GatherPiecesButtonOptions } from './gather-pieces-button.js';

export { createSelectToolButton } from './select-tool-button.js';
export type { SelectToolButtonOptions } from './select-tool-button.js';

export { createMarqueeToolButton } from './marquee-tool-button.js';
export type { MarqueeToolButtonOptions } from './marquee-tool-button.js';

export { createDeselectButton } from './deselect-button.js';
export type { DeselectButtonOptions } from './deselect-button.js';

export { createRotateButtons } from './rotate-buttons.js';
export type {
    RotateButtonsOptions,
    RotateButtonsHandle,
} from './rotate-buttons.js';

export { createRotateHandle } from './rotate-handle.js';
export type {
    RotateHandleOptions,
    RotateHandleHandle,
} from './rotate-handle.js';

export {
    createAttributionElement,
    removeAttribution,
    formatAttributionText,
} from './attribution.js';

export { createNewGameDialog } from './new-game-dialog.js';
export type {
    NewGameDialogOptions,
    NewGameDialogAnalytics,
    NewGameSelection,
    FractalDialogConfig,
    WavyDialogConfig,
} from './new-game-dialog.js';

export {
    createCorruptSaveDialog,
    buildCorruptSaveDownload,
} from './corrupt-save-dialog.js';
export type { CorruptSaveDialogOptions } from './corrupt-save-dialog.js';

export {
    BACKGROUND_COLOR_PRESETS,
    DEFAULT_COLOR_ID,
    getColorPreset,
    saveColorPreference,
    loadColorPreference,
    applyBackgroundColor,
    adoptSharedBackgroundColor,
} from './background-color.js';
export type { BackgroundColorPreset, SharedColorOutcome } from './background-color.js';
export { onColorSchemeChange } from './palette.js';

export {
    PIECE_OUTLINE_PRESETS,
    DEFAULT_PIECE_OUTLINE_ID,
    getPieceOutlinePreset,
    savePieceOutlinePreference,
    loadPieceOutlinePreference,
    applyPieceOutline,
} from './piece-outline.js';
export type { PieceOutlinePreset } from './piece-outline.js';

export { installPieceOutlineFilter } from './piece-outline-filter.js';

export {
    PIECE_OUTLINE_COLOR_PRESETS,
    DEFAULT_PIECE_OUTLINE_COLOR_ID,
    getPieceOutlineColorPreset,
    savePieceOutlineColorPreference,
    loadPieceOutlineColorPreference,
    applyPieceOutlineColor,
} from './piece-outline-color.js';
export type { PieceOutlineColorPreset } from './piece-outline-color.js';

export { createPieceOutlineColorPicker } from './piece-outline-color-picker.js';
export type { PieceOutlineColorPickerOptions } from './piece-outline-color-picker.js';

export { createBackgroundColorPicker } from './background-color-picker.js';
export type { BackgroundColorPickerOptions } from './background-color-picker.js';

export {
    createSwatchPicker,
    createSwatchGrid,
    createSwatch,
} from './swatch-picker.js';
export type {
    SwatchEntry,
    SwatchPickerOptions,
    SwatchPickerHandle,
} from './swatch-picker.js';

export { createInfoButton } from './info-button.js';
export type { InfoButtonOptions } from './info-button.js';

export { createToolbarButton } from './toolbar-button.js';
export type { ToolbarButtonOptions } from './toolbar-button.js';

export { createInfoModal } from './info-modal.js';
export type { InfoModalOptions } from './info-modal.js';

export { createCutStylePicker } from './cut-style-picker.js';
export type { CutStylePickerOptions } from './cut-style-picker.js';

export {
    MERGE_TOLERANCE_PRESETS,
    DEFAULT_TOLERANCE_ID,
    getTolerancePreset,
    saveTolerancePreference,
    loadTolerancePreference,
    getActiveTolerance,
    getActiveRotationTolerance,
} from './merge-tolerance.js';
export type { MergeTolerancePreset } from './merge-tolerance.js';

export { showCompletionOverlay } from './completion-overlay.js';
export type { CompletionOverlayOptions } from './completion-overlay.js';

export { showToast } from './toast.js';

export { createUpdateAvailableIndicator } from './update-available-indicator.js';
export type { UpdateAvailableIndicatorOptions } from './update-available-indicator.js';

export {
    showLoadingOverlay,
    hideLoadingOverlay,
    yieldForPaint,
} from './loading-overlay.js';
export type { ShowLoadingOverlayOptions } from './loading-overlay.js';

export {
    OFFSET_DRAG_KEY,
    loadOffsetDragPreference,
    saveOffsetDragPreference,
} from './offset-drag.js';

export {
    loadMarqueeContainPreference,
    saveMarqueeContainPreference,
    MARQUEE_CONTAIN_KEY,
} from './marquee-contain.js';

export {
    ROTATION_ENABLED_PREFERENCE_KEY,
    loadRotationEnabledPreference,
    saveRotationEnabledPreference,
} from './rotation-preference.js';
