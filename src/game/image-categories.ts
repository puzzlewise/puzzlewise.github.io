import {
    createBooleanPreference,
    createStringPreference,
} from '../ui/preference-store.js';

export type ImageCategoryId =
    | 'any'
    | 'nature'
    | 'animals'
    | 'architecture'
    | 'astronomy'
    | 'abstract'
    | 'food'
    | 'travel'
    | 'people'
    | 'face';

export interface ImageCategoryOption {
    id: ImageCategoryId;
    label: string;
    /** Undefined means no query (random). */
    query: string | undefined;
    description: string;
}

/**
 * Extra words AND-narrow the search, so add one only to tighten a category
 * whose deep result pages drift off-topic (`face` drifted to animals and
 * non-faces).
 */
export const IMAGE_CATEGORY_OPTIONS: readonly ImageCategoryOption[] = [
    {
        id: 'any',
        label: 'Any',
        query: undefined,
        description: 'Random photo',
    },
    {
        id: 'nature',
        label: 'Nature',
        query: 'nature',
        description: 'Nature & landscapes',
    },
    {
        id: 'animals',
        label: 'Animals',
        query: 'animals',
        description: 'Animals & wildlife',
    },
    {
        id: 'architecture',
        label: 'Architecture',
        query: 'architecture',
        description: 'Buildings & architecture',
    },
    {
        id: 'astronomy',
        // Not 'space': that query with the vibrant terms appended drifts to
        // neon abstracts rather than astronomy (#568).
        label: 'Astronomy',
        query: 'astronomy',
        description: 'Space & astronomy',
    },
    {
        id: 'abstract',
        label: 'Abstract',
        query: 'abstract',
        description: 'Abstract & patterns',
    },
    {
        id: 'food',
        label: 'Food',
        query: 'food',
        description: 'Food & cooking',
    },
    {
        id: 'travel',
        label: 'Travel',
        query: 'travel',
        description: 'Travel & adventure',
    },
    {
        id: 'people',
        label: 'People',
        query: 'people',
        description: 'People & portraits',
    },
    {
        id: 'face',
        label: 'Faces',
        query: 'person face',
        description: 'Close-up faces',
    },
] as const;

export const IMAGE_CATEGORY_PREFERENCE_KEY = 'puzzle-image-category';

export const VIBRANT_PREFERENCE_KEY = 'puzzle-image-vibrant';

/**
 * Appended to the Unsplash query for vibrant/colorful photos. Unsplash has no
 * saturation filter, so we bias the search via descriptive tags.
 */
export const VIBRANT_QUERY_TERMS = 'vibrant colorful';

export function buildImageQuery(
    categoryQuery: string | undefined,
    vibrant: boolean,
): string | undefined {
    if (!vibrant) {
        return categoryQuery;
    }

    if (!categoryQuery) {
        return VIBRANT_QUERY_TERMS;
    }

    return `${categoryQuery} ${VIBRANT_QUERY_TERMS}`;
}

function effectiveOverride(queryOverride: string | undefined): string | undefined {
    const trimmed = queryOverride?.trim();
    return trimmed ? trimmed : undefined;
}

export function isCustomQuery(queryOverride: string | undefined): boolean {
    return effectiveOverride(queryOverride) !== undefined;
}

/**
 * A non-empty (trimmed) override replaces the category's query outright; an
 * absent/blank one leaves the category query in force. The override is the raw
 * Unsplash search from the dev-only field in the new-game dialog.
 */
export function resolveQueryOverride(
    categoryQuery: string | undefined,
    queryOverride: string | undefined,
): string | undefined {
    return effectiveOverride(queryOverride) ?? categoryQuery;
}

export function findImageCategory(
    id: string,
): ImageCategoryOption {
    const found = IMAGE_CATEGORY_OPTIONS.find((opt) => opt.id === id);

    return found ?? IMAGE_CATEGORY_OPTIONS[0];
}

const categoryStore = createStringPreference({
    key: IMAGE_CATEGORY_PREFERENCE_KEY,
    allowed: IMAGE_CATEGORY_OPTIONS.map((opt) => opt.id),
    aliases: { space: 'astronomy' },
    defaultValue: 'any',
});

export const saveImageCategoryPreference = categoryStore.save;

export const loadImageCategoryPreference = categoryStore.load;

/**
 * Whether any image-category preference is stored — used with the
 * source check to detect a first-run visitor.
 */
export const imageCategoryPreferenceExists = categoryStore.exists;

const vibrantStore = createBooleanPreference({
    key: VIBRANT_PREFERENCE_KEY,
    defaultValue: false,
});

export const saveVibrantPreference = vibrantStore.save;

export const loadVibrantPreference = vibrantStore.load;
