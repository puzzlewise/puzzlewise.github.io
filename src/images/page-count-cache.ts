import { track } from '../analytics/index.js';
import { errorName } from '../analytics/sanitize-error-reason.js';

export const PAGE_COUNT_CACHE_KEY = 'puzzle-image-page-counts';

export const PAGE_COUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounds growth from player-typed queries, each of which gets its own key. */
export const MAX_PAGE_COUNT_ENTRIES = 64;

interface PageCountEntry {
    pages: number;
    at: number;
}

type Entries = Record<string, PageCountEntry>;

function isEntry(value: unknown): value is PageCountEntry {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.pages === 'number'
        && Number.isInteger(entry.pages)
        && entry.pages >= 1
        && typeof entry.at === 'number'
        && Number.isFinite(entry.at);
}

function loadEntries(): Entries {
    let raw: string | null;
    try {
        raw = localStorage.getItem(PAGE_COUNT_CACHE_KEY);
    } catch {
        return {};
    }
    if (raw === null) return {};

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }

    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || typeof record.entries !== 'object' || record.entries === null) return {};

    const entries: Entries = {};
    for (const [key, value] of Object.entries(record.entries as Record<string, unknown>)) {
        if (isEntry(value)) entries[key] = value;
    }
    return entries;
}

/**
 * Counts whose write failed (storage full or unavailable). Without them every
 * draw for the session would fall back to page 1: a fixed 30 photos, fewer
 * than the old random endpoint gave.
 */
const unsaved: Entries = {};

let reportedUnsaved = false;

function evictOldest(entries: Entries): void {
    const keys = Object.keys(entries);
    if (keys.length <= MAX_PAGE_COUNT_ENTRIES) return;
    keys.sort((a, b) => entries[a].at - entries[b].at);
    for (const stale of keys.slice(0, keys.length - MAX_PAGE_COUNT_ENTRIES)) {
        delete entries[stale];
    }
}

export function getPageCount(key: string, now: number = Date.now()): number | undefined {
    const stored = loadEntries()[key];
    const pending = unsaved[key];
    const entry = pending !== undefined && (stored === undefined || pending.at >= stored.at)
        ? pending
        : stored;
    if (entry === undefined || now - entry.at > PAGE_COUNT_TTL_MS) return undefined;
    return entry.pages;
}

export function setPageCount(key: string, pages: number, now: number = Date.now()): void {
    const entries = loadEntries();
    entries[key] = { pages, at: now };
    evictOldest(entries);

    try {
        localStorage.setItem(PAGE_COUNT_CACHE_KEY, JSON.stringify({ v: 1, entries }));
        delete unsaved[key];
    } catch (error) {
        unsaved[key] = { pages, at: now };
        evictOldest(unsaved);
        if (!reportedUnsaved) {
            reportedUnsaved = true;
            track('image-page-counts-unsaved', { errorName: errorName(error) });
        }
    }
}
