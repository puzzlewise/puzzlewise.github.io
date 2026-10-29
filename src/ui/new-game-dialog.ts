/**
 * Despite the legacy `.size-picker-*` CSS classes, this dialog owns the whole
 * New Game UI (cut-style, size, image picker, and per-style options).
 */

import { PUZZLE_SIZE_OPTIONS } from '../game/puzzle-sizes.js';
import { createCutStylePicker } from './cut-style-picker.js';
import { cutStyleNeedsTracedTabs, DEFAULT_CUT_STYLE_ID, getVisibleCutStyleOptions, isDevDeploy } from '../game/cut-styles.js';
import { IMAGE_CATEGORY_OPTIONS, isCustomQuery } from '../game/image-categories.js';
import { createDismissableOverlay } from './dismissable-overlay.js';
import {
    createImagePicker,
    type CandidateTrigger,
    type ImagePicker,
    type NewGameImageChoice,
} from './image-picker.js';
import type { CandidateFetchResult, CandidateImage } from '../images/index.js';

export interface ComposableSliderConfig {
    baseCut: 'sine' | 'triangular';
    horizontalAmplitude: number;
    horizontalFrequency: number;
    verticalAmplitude: number;
    verticalFrequency: number;
    tabGenerator: 'classic' | 'traced' | 'none';
    borderless: boolean;
    jitter: number;
    smooth: boolean;
}

export interface FractalDialogConfig {
    borderless: boolean;
}

export interface WavyDialogConfig {
    borderless: boolean;
}

export interface NewGameSelection {
    sizeId: string;
    cutStyleId: string;
    /** Present only when the chosen cut style is composable. */
    composableConfig?: ComposableSliderConfig;
    /** Present only when the chosen cut style is fractal. */
    fractalConfig?: FractalDialogConfig;
    /** Present only when the chosen cut style is wavy. */
    wavyConfig?: WavyDialogConfig;
    rotationEnabled: boolean;
    imageChoice: NewGameImageChoice;
    imageCategory: string;
    vibrant: boolean;
    /** Dev-only raw Unsplash query; when set, supersedes `imageCategory`'s query. */
    queryOverride?: string;
}

export interface NewGameDialogOptions {
    container: HTMLElement;
    selectedSizeId: string;
    selectedCutStyleId?: string;
    savedComposableConfig?: ComposableSliderConfig;
    savedFractalConfig?: FractalDialogConfig;
    savedWavyConfig?: WavyDialogConfig;
    savedRotationEnabled?: boolean;
    composableSupportsBorderless?: boolean;
    savedImageCategory?: string;
    savedVibrant?: boolean;
    /** Absent when no image proxy is configured — the picker hides its grid. */
    fetchImageCandidates?: (
        imageCategory: string,
        vibrant: boolean,
        queryOverride: string | undefined,
        trigger: CandidateTrigger,
    ) => Promise<CandidateFetchResult>;
    /**
     * Absent when no image proxy is configured or the Cache API is missing —
     * the offline-download row is hidden.
     */
    offlineImages?: OfflineImagesOptions;
    /** Called when the player picks an image (photo tile, Surprise me, or Blank puzzle). */
    onSelect: (selection: NewGameSelection) => void;
    /** Called when the dialog is dismissed without selecting. */
    onCancel?: (values: { imageCategory: string; vibrant: boolean }) => void;
    analytics?: NewGameDialogAnalytics;
    /**
     * Fires when the effective tab generator becomes `'traced'`, so the host can
     * preload the traced-tab lazy chunk. Idempotent — safe to call repeatedly.
     */
    onPreloadTracedTabs?: () => void;
}

interface SizeSelectRow {
    element: HTMLElement;
    getValue(): string;
    updateLabels(): void;
}

/**
 * Both Fractal and Wavy render identically — only their test id differs —
 * so they share one builder.
 */
interface BorderlessOptionsSection {
    element: HTMLElement;
    getValues(): { borderless: boolean };
    setVisible(visible: boolean): void;
}

interface ComposableSection {
    element: HTMLElement;
    getValues(): ComposableSliderConfig;
    setVisible(visible: boolean): void;
    /** Currently picked tab generator, regardless of section visibility. */
    getSelectedTabGenerator(): ComposableSliderConfig['tabGenerator'];
}

export interface NewGameDialogAnalytics {
    optionChanged(setting: 'category' | 'vibrant' | 'query', from: string, to: string): void;
    thumbnailLoaded(): void;
    thumbnailFailed(slot: number, candidate: CandidateImage, imageCategory: string): void;
    creditOpened(candidate: CandidateImage): void;
    offlineDownloadUsed(): void;
}

interface ImageOptionsValues {
    imageCategory: string;
    vibrant: boolean;
    queryOverride?: string;
}

interface ImageOptionsSection {
    element: HTMLElement;
    getValues(): ImageOptionsValues;
}

export interface OfflineImagesOptions {
    /** Photos currently stashed for offline play. */
    count: () => number;
    /** Resolves to the number of photos saved; 0 means the attempt failed. */
    download: (
        imageCategory: string,
        vibrant: boolean,
        onProgress: (done: number, total: number) => void,
        queryOverride?: string,
    ) => Promise<number>;
}

function buildSizeSelectRow(args: {
    selectedSizeId: string;
    getCutStyleId: () => string;
}): SizeSelectRow {
    const row = document.createElement('div');
    row.className = 'dialog-row';

    const label = document.createElement('label');
    label.className = 'dialog-row-label';
    label.textContent = 'Puzzle size';

    const select = document.createElement('select');
    select.className = 'dialog-row-input';
    select.dataset.testid = 'size-select';
    for (const opt of PUZZLE_SIZE_OPTIONS) {
        const el = document.createElement('option');
        el.value = opt.id;
        select.appendChild(el);
    }
    select.value = args.selectedSizeId;

    function updateLabels(): void {
        // Fractal and Triangles piece counts are approximate (~N): fractal scales
        // an internal grid; triangles derive column count from the image aspect
        // ratio, unknown until the photo is fetched.
        const cutStyleId = args.getCutStyleId();
        const isApproximate = cutStyleId === 'fractal' || cutStyleId === 'triangles';
        const optionEls = select.querySelectorAll('option');
        PUZZLE_SIZE_OPTIONS.forEach((opt, i) => {
            optionEls[i].textContent = isApproximate
                ? `~${opt.pieceCount} pieces`
                : `${opt.pieceCount} pieces`;
        });
    }

    updateLabels();

    row.appendChild(label);
    row.appendChild(select);

    return { element: row, getValue: () => select.value, updateLabels };
}

function buildBorderlessOptionsSection(args: {
    saved?: { borderless: boolean };
    testid: string;
}): BorderlessOptionsSection {
    const section = document.createElement('div');
    section.className = 'cut-style-options';

    const borderlessCheckbox = appendCheckboxRow(section, 'Borderless', args.saved?.borderless ?? false);
    borderlessCheckbox.dataset.testid = args.testid;

    return {
        element: section,
        getValues: () => ({
            borderless: borderlessCheckbox.checked,
        }),
        setVisible: (visible) => {
            section.style.display = visible ? 'block' : 'none';
        },
    };
}

function appendOfflineImagesRow(
    section: HTMLElement,
    offlineImages: OfflineImagesOptions,
    getValues: () => ImageOptionsValues,
    analytics: NewGameDialogAnalytics | undefined,
): void {
    const row = document.createElement('div');
    row.className = 'dialog-row';

    const label = document.createElement('label');
    label.className = 'dialog-row-label';
    label.textContent = 'Offline photos';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'offline-images-button';
    button.dataset.testid = 'offline-images-download';
    button.textContent = 'Download';
    button.setAttribute('aria-label', 'Download photos for offline play');

    const status = document.createElement('span');
    status.className = 'offline-images-status';
    status.dataset.testid = 'offline-images-status';
    status.setAttribute('aria-live', 'polite');
    const showCount = (count: number): void => {
        status.textContent = count > 0 ? `${count} ready` : '';
    };
    showCount(offlineImages.count());

    button.addEventListener('click', () => {
        analytics?.offlineDownloadUsed();
        button.disabled = true;
        status.textContent = 'Saving…';
        const { imageCategory, vibrant, queryOverride } = getValues();
        void offlineImages
            .download(imageCategory, vibrant, (done, total) => {
                status.textContent = `Saving ${done}/${total}…`;
            }, queryOverride)
            .then(
                (saved) => {
                    if (saved > 0) {
                        showCount(saved);
                    } else {
                        status.textContent = "Couldn't download";
                    }
                },
                () => {
                    status.textContent = "Couldn't download";
                },
            )
            .finally(() => {
                button.disabled = false;
            });
    });

    row.appendChild(label);
    row.appendChild(button);
    row.appendChild(status);
    section.appendChild(row);
}

function buildImageOptionsSection(args: {
    savedImageCategory?: string;
    savedVibrant?: boolean;
    offlineImages?: OfflineImagesOptions;
    onChange: () => void;
    analytics?: NewGameDialogAnalytics;
}): ImageOptionsSection {
    const section = document.createElement('div');
    section.className = 'image-options-section';

    const categoryRow = document.createElement('div');
    categoryRow.className = 'dialog-row';
    const categoryLabel = document.createElement('label');
    categoryLabel.className = 'dialog-row-label';
    categoryLabel.textContent = 'Picture Type';
    const categorySelect = document.createElement('select');
    categorySelect.className = 'dialog-row-input';
    for (const cat of IMAGE_CATEGORY_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = cat.label;
        categorySelect.appendChild(opt);
    }
    if (args.savedImageCategory) {
        categorySelect.value = args.savedImageCategory;
    }
    categoryRow.appendChild(categoryLabel);
    categoryRow.appendChild(categorySelect);
    section.appendChild(categoryRow);

    // Dev-only escape hatch: a raw Unsplash query that supersedes Picture Type
    // when non-empty, gated to dev-deploys like the Composable cut style.
    let queryOverrideInput: HTMLInputElement | undefined;
    if (isDevDeploy()) {
        const overrideRow = document.createElement('div');
        overrideRow.className = 'dialog-row';
        const overrideLabel = document.createElement('label');
        overrideLabel.className = 'dialog-row-label';
        overrideLabel.textContent = 'Query (dev)';
        queryOverrideInput = document.createElement('input');
        queryOverrideInput.type = 'text';
        queryOverrideInput.className = 'dialog-row-input';
        queryOverrideInput.dataset.testid = 'image-query-override';
        queryOverrideInput.placeholder = 'Overrides Picture Type';
        overrideRow.appendChild(overrideLabel);
        overrideRow.appendChild(queryOverrideInput);
        section.appendChild(overrideRow);
    }

    // Appends keywords to the Unsplash query to bias results toward saturated photos.
    const vibrantRow = document.createElement('div');
    vibrantRow.className = 'dialog-row';
    const vibrantLabel = document.createElement('label');
    vibrantLabel.className = 'dialog-row-label';
    vibrantLabel.textContent = 'Vibrant colours';
    const vibrantCheckbox = document.createElement('input');
    vibrantCheckbox.type = 'checkbox';
    vibrantCheckbox.className = 'form-checkbox';
    vibrantCheckbox.checked = args.savedVibrant ?? false;
    vibrantRow.appendChild(vibrantLabel);
    vibrantRow.appendChild(vibrantCheckbox);
    section.appendChild(vibrantRow);

    let lastCategory = categorySelect.value;
    categorySelect.addEventListener('change', () => {
        args.analytics?.optionChanged('category', lastCategory, categorySelect.value);
        lastCategory = categorySelect.value;
        args.onChange();
    });
    vibrantCheckbox.addEventListener('change', () => {
        args.analytics?.optionChanged('vibrant', String(!vibrantCheckbox.checked), String(vibrantCheckbox.checked));
        args.onChange();
    });
    if (queryOverrideInput) {
        const input = queryOverrideInput;
        const queryState = (): string => (isCustomQuery(input.value) ? 'custom' : 'none');
        let lastQuery = queryState();
        input.addEventListener('change', () => {
            args.analytics?.optionChanged('query', lastQuery, queryState());
            lastQuery = queryState();
        });
    }

    const getValues = (): ImageOptionsValues => {
        const values: ImageOptionsValues = {
            imageCategory: categorySelect.value,
            vibrant: vibrantCheckbox.checked,
        };
        const override = queryOverrideInput?.value.trim();
        if (override) values.queryOverride = override;
        return values;
    };

    if (args.offlineImages) {
        appendOfflineImagesRow(section, args.offlineImages, getValues, args.analytics);
    }

    return { element: section, getValues };
}

function buildComposableSlidersSection(args: {
    saved?: ComposableSliderConfig;
    showBorderless?: boolean;
    onTabGeneratorChange?: (value: ComposableSliderConfig['tabGenerator']) => void;
}): ComposableSection {
    const section = document.createElement('div');
    section.className = 'composable-sliders';

    const sineControls = document.createElement('div');
    sineControls.dataset.testid = 'composable-sine-controls';

    const triangularControls = document.createElement('div');
    triangularControls.dataset.testid = 'composable-triangular-controls';

    // Created up front so the visibility helper can toggle it; appended below in DOM order.
    const borderlessWrap = document.createElement('div');

    const applyBaseCutVisibility = (baseCut: 'sine' | 'triangular'): void => {
        const tri = baseCut === 'triangular';
        sineControls.style.display = tri ? 'none' : 'block';
        triangularControls.style.display = tri ? 'block' : 'none';
        borderlessWrap.style.display = tri ? 'none' : 'block';
    };

    const baseCutRow = appendSegmentedRow<'sine' | 'triangular'>(
        section,
        'Base cut',
        [
            { value: 'sine', label: 'Sine' },
            { value: 'triangular', label: 'Triangular' },
        ],
        args.saved?.baseCut ?? 'sine',
        (value) => applyBaseCutVisibility(value),
    );

    interface SliderDef {
        id: keyof Omit<ComposableSliderConfig, 'tabGenerator' | 'borderless' | 'baseCut' | 'jitter'>;
        label: string;
        min: number;
        max: number;
        step: number;
        defaultValue: number;
    }

    const sliderDefs: SliderDef[] = [
        { id: 'horizontalAmplitude', label: 'H Amplitude', min: 0, max: 0.5, step: 0.01, defaultValue: args.saved?.horizontalAmplitude ?? 0.15 },
        { id: 'horizontalFrequency', label: 'H Frequency', min: 0, max: 10, step: 0.1, defaultValue: args.saved?.horizontalFrequency ?? 1.5 },
        { id: 'verticalAmplitude', label: 'V Amplitude', min: 0, max: 0.5, step: 0.01, defaultValue: args.saved?.verticalAmplitude ?? 0.15 },
        { id: 'verticalFrequency', label: 'V Frequency', min: 0, max: 10, step: 0.1, defaultValue: args.saved?.verticalFrequency ?? 1.5 },
    ];

    const sliderInputs = new Map<SliderDef['id'], HTMLInputElement>();

    for (const def of sliderDefs) {
        const row = document.createElement('div');
        row.className = 'dialog-row';

        const lbl = document.createElement('label');
        lbl.className = 'dialog-row-label';
        lbl.textContent = def.label;

        const valueDisplay = document.createElement('span');
        valueDisplay.className = 'dialog-row-value';
        valueDisplay.textContent = String(def.defaultValue);

        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'dialog-row-input';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(def.defaultValue);

        input.addEventListener('input', () => {
            valueDisplay.textContent = input.value;
        });

        sliderInputs.set(def.id, input);

        row.appendChild(lbl);
        row.appendChild(input);
        row.appendChild(valueDisplay);
        sineControls.appendChild(row);
    }

    section.appendChild(sineControls);

    const jitterRow = document.createElement('div');
    jitterRow.className = 'dialog-row';
    const jitterLabel = document.createElement('label');
    jitterLabel.className = 'dialog-row-label';
    jitterLabel.textContent = 'Irregularity';
    const jitterValue = document.createElement('span');
    jitterValue.className = 'dialog-row-value';
    const jitterInput = document.createElement('input');
    jitterInput.type = 'range';
    jitterInput.className = 'dialog-row-input';
    jitterInput.dataset.testid = 'composable-jitter-slider';
    jitterInput.min = '0';
    jitterInput.max = '0.5';
    jitterInput.step = '0.01';
    jitterInput.value = String(args.saved?.jitter ?? 0.15);
    jitterValue.textContent = jitterInput.value;
    jitterInput.addEventListener('input', () => { jitterValue.textContent = jitterInput.value; });
    jitterRow.appendChild(jitterLabel);
    jitterRow.appendChild(jitterInput);
    jitterRow.appendChild(jitterValue);
    triangularControls.appendChild(jitterRow);

    const smoothCheckbox = appendCheckboxRow(
        triangularControls,
        'Flowing edges',
        args.saved?.smooth ?? false,
    );
    smoothCheckbox.dataset.testid = 'composable-smooth-toggle';

    section.appendChild(triangularControls);

    // Traced has no gate of its own — it inherits Composable's visibility via
    // `getVisibleCutStyleOptions()`, so promoting Composable ships Traced too.
    const tabGeneratorRow = appendSegmentedRow<'classic' | 'traced' | 'none'>(
        section,
        'Tab style',
        [
            { value: 'classic', label: 'Classic' },
            { value: 'traced',  label: 'Traced'  },
            { value: 'none',    label: 'None'    },
        ],
        args.saved?.tabGenerator ?? 'classic',
        args.onTabGeneratorChange,
    );

    // Hidden for triangular cut since borderless doesn't apply there.
    section.appendChild(borderlessWrap);
    const borderlessCheckbox = args.showBorderless
        ? appendCheckboxRow(borderlessWrap, 'Borderless', args.saved?.borderless ?? false)
        : null;
    if (borderlessCheckbox) borderlessCheckbox.dataset.testid = 'composable-borderless-toggle';

    applyBaseCutVisibility(args.saved?.baseCut ?? 'sine');

    return {
        element: section,
        getValues: () => ({
            baseCut: baseCutRow.getValue(),
            horizontalAmplitude: parseFloat(sliderInputs.get('horizontalAmplitude')!.value),
            horizontalFrequency: parseFloat(sliderInputs.get('horizontalFrequency')!.value),
            verticalAmplitude: parseFloat(sliderInputs.get('verticalAmplitude')!.value),
            verticalFrequency: parseFloat(sliderInputs.get('verticalFrequency')!.value),
            tabGenerator: tabGeneratorRow.getValue(),
            // Raw checkbox state: composableSliderToGeneratorConfig already forces
            // borderless off for triangular. Coercing here too would clobber the
            // player's sine choice on toggle-back.
            borderless: borderlessCheckbox?.checked ?? false,
            jitter: parseFloat(jitterInput.value),
            smooth: smoothCheckbox.checked,
        }),
        setVisible: (visible) => {
            section.style.display = visible ? 'block' : 'none';
        },
        getSelectedTabGenerator: () => tabGeneratorRow.getValue(),
    };
}

interface SegmentedRow<T extends string> {
    getValue(): T;
}

/** Ensures rows sharing a label still get distinct ids. */
let nextSegmentedRowSuffix = 0;

function appendSegmentedRow<T extends string>(
    parent: HTMLElement,
    labelText: string,
    options: ReadonlyArray<{ value: T; label: string }>,
    initialValue: T,
    onChange?: (value: T) => void,
): SegmentedRow<T> {
    const row = document.createElement('div');
    row.className = 'dialog-row';

    const groupSlug = `${labelText.replace(/\s+/g, '-').toLowerCase()}-${nextSegmentedRowSuffix++}`;
    const labelId = `seg-label-${groupSlug}`;

    const label = document.createElement('label');
    label.className = 'dialog-row-label';
    label.id = labelId;
    label.textContent = labelText;

    const group = document.createElement('div');
    group.className = 'segmented-control';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', labelId);

    const groupName = `seg-${groupSlug}`;
    const inputs: HTMLInputElement[] = [];

    for (const opt of options) {
        const optLabel = document.createElement('label');
        optLabel.className = 'segmented-option';

        const input = document.createElement('input');
        input.type = 'radio';
        input.name = groupName;
        input.value = opt.value;
        if (opt.value === initialValue) input.checked = true;
        if (onChange) {
            input.addEventListener('change', () => {
                if (input.checked) onChange(opt.value);
            });
        }
        inputs.push(input);

        const text = document.createElement('span');
        text.textContent = opt.label;

        optLabel.appendChild(input);
        optLabel.appendChild(text);
        group.appendChild(optLabel);
    }

    row.appendChild(label);
    row.appendChild(group);
    parent.appendChild(row);

    return {
        getValue: (): T => {
            const checked = inputs.find(i => i.checked);
            return (checked ? (checked.value as T) : initialValue);
        },
    };
}

function appendCheckboxRow(
    parent: HTMLElement,
    labelText: string,
    initialChecked: boolean,
): HTMLInputElement {
    const row = document.createElement('div');
    row.className = 'dialog-row';

    const label = document.createElement('label');
    label.className = 'dialog-row-label';
    label.textContent = labelText;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-checkbox';
    checkbox.checked = initialChecked;

    row.appendChild(label);
    row.appendChild(checkbox);
    parent.appendChild(row);

    return checkbox;
}

/** Returns a cleanup function that removes the dialog from the DOM. */
export function createNewGameDialog(options: NewGameDialogOptions): () => void {
    const { container, selectedSizeId, onSelect, onCancel } = options;

    let currentCutStyleId: string = options.selectedCutStyleId ?? DEFAULT_CUT_STYLE_ID;

    const visibleOptions = getVisibleCutStyleOptions();
    if (!visibleOptions.some((o) => o.id === currentCutStyleId)) {
        currentCutStyleId = DEFAULT_CUT_STYLE_ID;
    }

    let imagePicker: ImagePicker | undefined;
    const imageOptions = buildImageOptionsSection({
        savedImageCategory: options.savedImageCategory,
        savedVibrant: options.savedVibrant,
        offlineImages: options.offlineImages,
        onChange: () => imagePicker?.refresh('options'),
        analytics: options.analytics,
    });

    const { overlay, dismiss } = createDismissableOverlay({
        container,
        className: 'size-picker-overlay',
        onDismiss: onCancel && (() => {
            const { imageCategory, vibrant } = imageOptions.getValues();
            onCancel({ imageCategory, vibrant });
        }),
    });

    const dialog = document.createElement('div');
    dialog.className = 'size-picker-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'New game options');

    const title = document.createElement('h2');
    title.className = 'size-picker-title';
    title.textContent = 'New Game';
    dialog.appendChild(title);

    const fractalSection = buildBorderlessOptionsSection({
        saved: options.savedFractalConfig,
        testid: 'fractal-borderless-toggle',
    });
    const wavySection = buildBorderlessOptionsSection({
        saved: options.savedWavyConfig,
        testid: 'wavy-borderless-toggle',
    });
    const composableSection = buildComposableSlidersSection({
        saved: options.savedComposableConfig,
        showBorderless: options.composableSupportsBorderless ?? false,
        onTabGeneratorChange: (value) => {
            if (value === 'traced') options.onPreloadTracedTabs?.();
        },
    });

    // Preloading here keeps the traced-tab fetch off startNewGame's critical path.
    const needsTracedTabs = (id: string): boolean =>
        cutStyleNeedsTracedTabs(id, composableSection.getSelectedTabGenerator());

    const sizeRow = buildSizeSelectRow({
        selectedSizeId,
        getCutStyleId: () => currentCutStyleId,
    });

    const rotationRow = document.createElement('div');
    rotationRow.className = 'rotation-row';
    const rotationCheckbox = appendCheckboxRow(
        rotationRow,
        'Enable rotation',
        options.savedRotationEnabled ?? false,
    );

    imagePicker = createImagePicker({
        fetchCandidates: options.fetchImageCandidates
            ? (trigger) => {
                const { imageCategory, vibrant, queryOverride } = imageOptions.getValues();
                return options.fetchImageCandidates!(imageCategory, vibrant, queryOverride, trigger);
            }
            : undefined,
        onThumbnailLoad: () => options.analytics?.thumbnailLoaded(),
        onThumbnailError: (slot, candidate) => options.analytics?.thumbnailFailed(
            slot, candidate, imageOptions.getValues().imageCategory,
        ),
        onCreditOpen: (candidate) => options.analytics?.creditOpened(candidate),
        onPick: (imageChoice) => {
            dismiss();
            onSelect({
                sizeId: sizeRow.getValue(),
                cutStyleId: currentCutStyleId,
                composableConfig: currentCutStyleId === 'composable'
                    ? composableSection.getValues()
                    : undefined,
                fractalConfig: currentCutStyleId === 'fractal'
                    ? fractalSection.getValues()
                    : undefined,
                wavyConfig: currentCutStyleId === 'wavy'
                    ? wavySection.getValues()
                    : undefined,
                rotationEnabled: rotationCheckbox.checked,
                imageChoice,
                ...imageOptions.getValues(),
            });
        },
    });

    const cutStyleSection = createCutStylePicker({
        selectedCutStyleId: currentCutStyleId,
        options: visibleOptions,
        onSelect: (id) => {
            currentCutStyleId = id;
            sizeRow.updateLabels();
            fractalSection.setVisible(id === 'fractal');
            wavySection.setVisible(id === 'wavy');
            composableSection.setVisible(id === 'composable');
            if (needsTracedTabs(id)) options.onPreloadTracedTabs?.();
        },
    });

    fractalSection.setVisible(currentCutStyleId === 'fractal');
    wavySection.setVisible(currentCutStyleId === 'wavy');
    composableSection.setVisible(currentCutStyleId === 'composable');

    // Preload when opening with traced already selected (the default), so the
    // chunk loads without needing a radio toggle.
    if (needsTracedTabs(currentCutStyleId)) options.onPreloadTracedTabs?.();

    // Two groups so the short-and-wide layout can place them side by side; the
    // start group holds only the image picker (picking one launches the game).
    const content = document.createElement('div');
    content.className = 'dialog-content';
    content.tabIndex = -1;

    const settingsGroup = document.createElement('div');
    settingsGroup.className = 'dialog-group dialog-group--settings';
    settingsGroup.appendChild(cutStyleSection);
    settingsGroup.appendChild(rotationRow);
    settingsGroup.appendChild(fractalSection.element);
    settingsGroup.appendChild(wavySection.element);
    settingsGroup.appendChild(composableSection.element);
    settingsGroup.appendChild(sizeRow.element);
    settingsGroup.appendChild(imageOptions.element);

    const startGroup = document.createElement('div');
    startGroup.className = 'dialog-group dialog-group--start';
    startGroup.appendChild(imagePicker.element);

    content.appendChild(settingsGroup);
    content.appendChild(startGroup);
    dialog.appendChild(content);

    overlay.appendChild(dialog);
    content.focus({ preventScroll: true });

    return dismiss;
}
