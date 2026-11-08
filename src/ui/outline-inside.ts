import { createBooleanPreference } from './preference-store.js';

export const OUTLINE_INSIDE_KEY = 'puzzle-outline-inside';

const store = createBooleanPreference({
    key: OUTLINE_INSIDE_KEY,
    defaultValue: false,
});

export const loadOutlineInsidePreference = store.load;

export const saveOutlineInsidePreference = store.save;
