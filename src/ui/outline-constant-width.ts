import { createBooleanPreference } from './preference-store.js';

export const OUTLINE_CONSTANT_WIDTH_KEY = 'puzzle-outline-constant-width';
export const OUTLINE_CONSTANT_WIDTH_ATTRIBUTE = 'data-outline-constant-width';

const store = createBooleanPreference({
    key: OUTLINE_CONSTANT_WIDTH_KEY,
    defaultValue: false,
});

export const loadOutlineConstantWidthPreference = store.load;

export const saveOutlineConstantWidthPreference = store.save;

export function applyOutlineConstantWidth(on: boolean): void {
    document.documentElement.toggleAttribute(OUTLINE_CONSTANT_WIDTH_ATTRIBUTE, on);
}
