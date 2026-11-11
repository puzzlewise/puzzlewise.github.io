import { createBooleanPreference } from './preference-store.js';

export const OUTLINE_INSIDE_KEY = 'puzzle-outline-inside';
export const OUTLINE_INSIDE_ATTRIBUTE = 'data-outline-inside-pref';

const store = createBooleanPreference({
    key: OUTLINE_INSIDE_KEY,
    defaultValue: false,
});

export const loadOutlineInsidePreference = store.load;

export const saveOutlineInsidePreference = store.save;

export function applyOutlineInside(on: boolean): void {
    document.documentElement.toggleAttribute(OUTLINE_INSIDE_ATTRIBUTE, on);
}
