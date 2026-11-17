import type { GameState } from '../model/types.js';
import { normalizeDegrees } from '../model/helpers.js';
import type { ComposableConfig } from '../puzzle/composable-generator.js';
import {
    listBaseCutGeneratorIds,
    listTabGeneratorIds,
} from '../puzzle/topology/generator-registry.js';
import { clampGridDim } from '../puzzle/topology/grid-dim.js';
import { legacyDisableTabsToTabGenerator } from '../game/composable-config.js';
import { CURRENT_TRACE_SET_VERSION, normalizeTraceSetVersion } from '../puzzle/composable/traces/trace-set-version.js';
import { PUZZLE_SIZE_OPTIONS } from '../game/puzzle-sizes.js';
import { isSafeHttpUrl, isSafeImageUrl } from './safe-url.js';

export interface SharePayload {
    /** Schema version; bumped on breaking changes. */
    v: 1;
    /** Image URL, or the sentinel `'blank'` for a puzzle with no image. */
    i: string;
    /** Image size [width, height]. */
    is: [number, number];
    /** Attribution. */
    a?: { n: string; u: string; p: string };
    /** Grid size [cols, rows]. */
    g: [number, number];
    /** Cut style. */
    c: 'classic' | 'fractal' | 'composable' | 'wavy' | 'triangles';
    /** PRNG seed. */
    s: number;
    /** Rotation mode. */
    r: 'none' | 'quarter-turn' | 'free';
    /**
     * Sharer's background color (palette swatch id). Additive — old links lack
     * it, old clients ignore it; the receiver adopts it only with no preference of its own.
     */
    bgc?: string;
    /** Composable cut config. */
    cf?: {
        /** BaseCutGenerator id. */
        bg: string;
        /** Generator-specific config (opaque). */
        bgc: Record<string, unknown>;
        /** TabGenerator id ('none' to disable tabs). */
        tg: string;
        /** Tab-generator-specific config (opaque). */
        tgc: Record<string, unknown>;
        /** Optional minPieceArea override; receiver uses this when present. */
        mpa?: number;
        /** Borderless mode; strips the outer ring of pieces when true. */
        bl?: boolean;
    };
    /** Fractal-cut config. */
    ff?: { bl: boolean };
    /** Wavy-cut config. `tv` = trace-set version (present ⇒ traced tabs; absent ⇒ classic). */
    wf?: { bl: boolean; tv?: number };
    /**
     * Triangles-cut config. `tv` pins the traced tab-library snapshot. Unlike
     * wavy's `wf.tv`, absence does NOT mean classic tabs — every triangles
     * puzzle is traced; a missing/invalid block falls back to the current trace set.
     */
    tf?: { tv: number };
    /**
     * Classic-cut config. `tv` = trace-set version. Its PRESENCE selects the
     * sine Classic generator; ABSENCE (pre-upgrade links) selects the legacy
     * generateProceduralPuzzle. An invalid `tv` drops the block → legacy
     * generator (contrast `tf`, which stays on the composable pipeline).
     */
    clf?: { tv: number };
    /** Progress snapshot. */
    pr?: {
        m: number[][];
        mr?: number[];
        sr?: number[];
    };
}

/**
 * Cut styles and rotation modes the wire format accepts. Total `Record`s over
 * the SharePayload unions, so a new style/mode fails to compile here rather
 * than being silently rejected at decode. Membership uses `hasOwnProperty`, not
 * `in` — `'toString'` is a truthy inherited member that the cheaper checks accept.
 */
const CUT_STYLES: Record<SharePayload['c'], true> = {
    classic: true,
    fractal: true,
    composable: true,
    wavy: true,
    triangles: true,
};

const ROTATION_MODES: Record<SharePayload['r'], true> = {
    none: true,
    'quarter-turn': true,
    free: true,
};

/**
 * Both predicates take `unknown`, not `string`: callers pass values only
 * *typed* as strings (a JSON.parsed field, a hand-typed console object), so the
 * runtime check lives here once. `hasOwnProperty` coerces its key, so
 * `['classic']` or `{ toString() }` would otherwise pass membership and read as
 * an unknown style downstream.
 */
export function isCutStyle(value: unknown): value is SharePayload['c'] {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(CUT_STYLES, value);
}

export function isRotationMode(value: unknown): value is SharePayload['r'] {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(ROTATION_MODES, value);
}

export function encodePayload(payload: SharePayload): string {
    assertPayloadNumbersFinite(payload);
    const json = JSON.stringify(payload);
    return base64UrlEncode(json);
}

function assertPayloadNumbersFinite(payload: SharePayload): void {
    const check = (n: number, label: string): void => {
        if (!Number.isFinite(n)) {
            throw new Error(`Share payload ${label} must be finite (got ${n})`);
        }
    };
    check(payload.is[0], 'is[0]'); check(payload.is[1], 'is[1]');
    check(payload.g[0], 'g[0]');   check(payload.g[1], 'g[1]');
    check(payload.s, 's');
    if (payload.cf && payload.c === 'composable') {
        const bgc = (payload.cf.bgc ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(bgc)) {
            const v = bgc[key];
            if (typeof v === 'number' && !Number.isFinite(v)) {
                throw new Error(`Share payload cf.bgc.${key} must be finite (got ${v})`);
            }
        }
    }
    if (payload.c === 'wavy' && payload.wf?.tv !== undefined) {
        check(payload.wf.tv, 'wf.tv');
    }
    if (payload.c === 'triangles' && payload.tf?.tv !== undefined) {
        check(payload.tf.tv, 'tf.tv');
    }
    if (payload.c === 'classic' && payload.clf?.tv !== undefined) {
        check(payload.clf.tv, 'clf.tv');
    }
}

/**
 * Upper bound on a decoded image dimension (px); several times above the app's
 * 1080px delivery. Bounds a crafted `is:[1e9,1e9]`: generators inscribe into
 * the image rect and the renderer sizes every piece from it, so an unbounded
 * `is` means gigapixel geometry that hangs the tab.
 */
const MAX_IMAGE_DIM = 8192;

/**
 * Upper bound on a decoded sine base-cut frequency (`hf`/`vf`); the new-game
 * dialog's cap of 10 (#759: links never exceed what the dialog writes), so it
 * alters no real puzzle. Bounds `generateSineCurve`'s segment allocation
 * against a crafted `hf = 1e9`: segments grow linearly with frequency and feed
 * an O(segments²) intersection path. Re-evaluate if `segmentsPerWave`
 * (currently 4) grows.
 */
const MAX_SINE_FREQUENCY = 10;

// Same reason as MAX_SINE_FREQUENCY (#759).
const MAX_LINK_GRID_DIM = Math.max(...PUZZLE_SIZE_OPTIONS.flatMap((o) => [o.cols, o.rows]));

/**
 * Upper bound on a decoded sine base-cut amplitude (`ha`/`va`); the UI ceiling
 * of 0.5 (wavy uses exactly 0.5), so it alters no real puzzle. Amplitude scales
 * each segment's bbox, and a crafted huge value defeats the `Curve.intersect`
 * bbox pre-filter, re-inflating the O(segments²) cost the frequency cap
 * contains. Negative/zero are safe (generator gates on `> 0`), so only the
 * upper bound is enforced.
 */
const MAX_SINE_AMPLITUDE = 0.5;

function clampDim(n: number, max: number): number {
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(max, Math.floor(n)));
}

/**
 * Cap sine base-cut `hf`/`vf` and `ha`/`va` on a decoded composable `bgc` to
 * {@link MAX_SINE_FREQUENCY}/{@link MAX_SINE_AMPLITUDE}. Gated on `bg === 'sine'`
 * (only sine reads these as segment/bbox knobs), leaving other generators'
 * opaque config untouched. A value that is not a finite number (a JSON-nulled
 * non-finite, or a quoted number the generator's arithmetic would coerce past
 * the caps) is dropped → generator default. Mutates `bgc` in place.
 */
function clampSineConfig(cf: NonNullable<SharePayload['cf']>): void {
    if (cf.bg !== 'sine') return;
    const caps = { hf: MAX_SINE_FREQUENCY, vf: MAX_SINE_FREQUENCY, ha: MAX_SINE_AMPLITUDE, va: MAX_SINE_AMPLITUDE } as const;
    for (const key of ['hf', 'vf', 'ha', 'va'] as const) {
        const v = cf.bgc[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
            cf.bgc[key] = Math.min(caps[key], v);
        } else {
            delete cf.bgc[key];
        }
    }
}

/**
 * Bound a decoded trace-set version. Non-number/sub-1 → undefined (classic
 * tabs, matching pre-versioning links); a version newer than this client knows
 * clamps down to the newest it can reproduce, so a forward-link still plays.
 */
function clampTraceSetVersion(tv: unknown): number | undefined {
    const v = normalizeTraceSetVersion(tv);
    return v === undefined ? undefined : Math.min(v, CURRENT_TRACE_SET_VERSION);
}

export function decodePayload(encoded: string): SharePayload | null {
    try {
        const json = base64UrlDecode(encoded);
        const parsed = JSON.parse(json) as unknown;
        const translated = translateLegacyComposable(parsed);
        if (!isValidPayload(translated)) return null;
        // Bound the grid before it reaches the generators (O(E²) crossing check).
        translated.g = [
            Math.min(MAX_LINK_GRID_DIM, clampGridDim(translated.g[0])),
            Math.min(MAX_LINK_GRID_DIM, clampGridDim(translated.g[1])),
        ];
        // A fractional `is` is not adversarial: fractal/wavy inscribe the image
        // to the grid aspect, so 607.5 is normal and the floor only snaps sub-pixel.
        translated.is = [clampDim(translated.is[0], MAX_IMAGE_DIM), clampDim(translated.is[1], MAX_IMAGE_DIM)];
        // Bound sine frequency/amplitude before generateSineCurve (see
        // MAX_SINE_FREQUENCY/MAX_SINE_AMPLITUDE). Legacy payloads were rewritten
        // to bg: 'sine' above, so this covers them too.
        if (translated.c === 'composable' && translated.cf) {
            clampSineConfig(translated.cf);
        }
        if (translated.c === 'wavy' && translated.wf) {
            const clamped = clampTraceSetVersion(translated.wf.tv);
            if (clamped === undefined) {
                if (translated.wf.tv !== undefined) delete translated.wf.tv;
            } else {
                translated.wf.tv = clamped;
            }
        }
        // Both blocks normalized whatever `c` says, matching the ungated shape
        // check in `isValidTraceSetBlock`. Gating on cut style would leave a
        // foreign block un-normalized (e.g. `{ c: 'classic', tf: { tv: 'x' } }`)
        // decoding to a `tf` that contradicts its declared `{ tv: number }` (#491).
        // Nothing reads a foreign block today; this keeps a future reader safe.
        if (translated.tf) {
            const clamped = clampTraceSetVersion(translated.tf.tv);
            // No legacy-classic fallback here (contrast wf.tv): an invalid tv
            // drops the whole block and the strategy substitutes the current
            // trace set.
            if (clamped === undefined) {
                delete translated.tf;
            } else {
                translated.tf.tv = clamped;
            }
        }
        if (translated.clf) {
            const clamped = clampTraceSetVersion(translated.clf.tv);
            // An invalid tv drops the block, so the puzzle reproduces with the
            // legacy generator (contrast triangles, which keeps the composable
            // pipeline and substitutes the current trace set).
            if (clamped === undefined) {
                delete translated.clf;
            } else {
                translated.clf.tv = clamped;
            }
        }
        return translated;
    } catch {
        return null;
    }
}

/**
 * Translate a legacy composable cf shape (with ha/hf/va/vf/dt fields)
 * into the new shape (bg/bgc/tg/tgc) so the framework only ever sees
 * the new format.
 */
function translateLegacyComposable(parsed: unknown): unknown {
    if (!parsed || typeof parsed !== 'object') return parsed;
    const p = parsed as Record<string, unknown>;
    if (p.c !== 'composable') return parsed;
    if (!p.cf || typeof p.cf !== 'object') return parsed;

    const cf = p.cf as Record<string, unknown>;
    const isLegacy = ('ha' in cf || 'hf' in cf || 'va' in cf || 'vf' in cf || 'dt' in cf)
                  && !('bg' in cf);
    if (!isLegacy) return parsed;

    return {
        ...p,
        cf: {
            bg: 'sine',
            bgc: { ha: cf.ha, hf: cf.hf, va: cf.va, vf: cf.vf },
            tg: legacyDisableTabsToTabGenerator(cf.dt),
            tgc: {},
        },
    };
}

function base64UrlEncode(text: string): string {
    // btoa handles Latin-1; round-trip via UTF-8 so non-ASCII survives.
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): string {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + '='.repeat(pad));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function isValidPayload(x: unknown): x is SharePayload {
    if (!x || typeof x !== 'object') return false;
    const p = x as Record<string, unknown>;
    if (p.v !== 1) return false;
    if (typeof p.i !== 'string') return false;
    if (!isTuple2Number(p.is)) return false;
    if (!isTuple2Number(p.g)) return false;
    if (!isCutStyle(p.c)) return false;
    if (typeof p.s !== 'number') return false;
    if (!isRotationMode(p.r)) return false;
    // After the cheap field checks: `i` is the one unbounded field on the wire
    // and parsing it is the most expensive check here. No reason to pay that
    // for a payload a 3-byte `c` would have rejected.
    if (!isSafeImageUrl(p.i)) return false;
    if (p.c === 'composable' && p.cf !== undefined && !isValidComposableCf(p.cf)) return false;
    if (p.ff !== undefined && !isValidBorderlessBlock(p.ff)) return false;
    if (p.wf !== undefined && !isValidBorderlessBlock(p.wf)) return false;
    if (p.tf !== undefined && !isValidTraceSetBlock(p.tf)) return false;
    if (p.clf !== undefined && !isValidTraceSetBlock(p.clf)) return false;
    if (p.pr !== undefined && !isValidProgress(p.pr)) return false;
    if (p.bgc !== undefined && typeof p.bgc !== 'string') return false;
    if (p.a !== undefined && !isValidAttribution(p.a)) return false;
    return true;
}

/**
 * Validate the fractal (`ff`) and wavy (`wf`) blocks, whose only shared field
 * is the borderless flag. `bl` is typed `boolean` but reached `GameState`
 * unchecked and is re-emitted on re-share and in the `piece-count-mismatch`
 * event, so a crafted non-boolean has to be stopped before it enters state
 * (`isValidComposableCf` has always checked composable's `cf.bl`; this closes
 * the same hole). Rejecting the whole payload matches the codec's handling of
 * every other malformed block and rejects nothing this app emits.
 *
 * `bl` is REQUIRED here (unlike the optional `cf.bl`), making "always emit `bl`"
 * part of the wire contract — loosen it only alongside the `applyStyleConfigs`
 * producer. `wf.tv` is NOT checked here — `decodePayload` clamps it and an
 * unusable one falls back to classic tabs. Applied to EVERY cut style (unlike
 * the composable-gated `cf` check): no producer emits a foreign block, and the
 * ungated form keeps the guarantee unconditional for a future reader.
 */
function isValidBorderlessBlock(x: unknown): boolean {
    if (!x || typeof x !== 'object') return false;
    return typeof (x as Record<string, unknown>).bl === 'boolean';
}

/**
 * Validate the triangles (`tf`) and classic (`clf`) blocks, whose only field is
 * the trace-set version. Shape only — `tv` is NOT checked here (as `wf.tv`
 * isn't): `decodePayload` clamps it and an unusable value drops the block rather
 * than losing the whole link. What the object check buys is the case the clamp
 * can't reach: its guards are plain truthiness, so a *falsy* non-object
 * (`clf: null`, `clf: 0`) skipped the clamp and survived decode as a `clf` that
 * contradicts its declared `{ tv: number }` (#491). Ungated by `c` like
 * {@link isValidBorderlessBlock}, though this one leaves `tv` to the clamp;
 * `decodePayload` runs both clamps ungated to close the difference.
 */
function isValidTraceSetBlock(x: unknown): boolean {
    return !!x && typeof x === 'object';
}

/**
 * Validate the optional attribution block. Its URLs flow into an anchor `href`,
 * so a crafted link could carry a `javascript:` URL that executes on click.
 * Require `{ n, u, p }` with `u`/`p` absolute http(s) — every Unsplash link
 * satisfies this, so it rejects only already-dangerous links.
 */
function isValidAttribution(a: unknown): boolean {
    if (!a || typeof a !== 'object') return false;
    const o = a as Record<string, unknown>;
    if (typeof o.n !== 'string') return false;
    if (typeof o.u !== 'string' || !isSafeHttpUrl(o.u)) return false;
    if (typeof o.p !== 'string' || !isSafeHttpUrl(o.p)) return false;
    return true;
}

// Lazy-cached id sets, snapshotted on first lookup (registries are populated at
// module-import time). O(1) `Set.has` beats a per-decode array + `Array.includes`.
let knownBaseCutIds: Set<string> | null = null;
let knownTabIds: Set<string> | null = null;

function isKnownBaseCutId(id: string): boolean {
    if (!knownBaseCutIds) knownBaseCutIds = new Set(listBaseCutGeneratorIds());
    return knownBaseCutIds.has(id);
}

function isKnownTabId(id: string): boolean {
    if (!knownTabIds) knownTabIds = new Set(listTabGeneratorIds());
    return knownTabIds.has(id);
}

function isValidComposableCf(cf: unknown): boolean {
    if (!cf || typeof cf !== 'object') return false;
    const c = cf as Record<string, unknown>;
    if (typeof c.bg !== 'string') return false;
    if (!isKnownBaseCutId(c.bg)) return false;
    if (typeof c.bgc !== 'object' || c.bgc === null) return false;
    if (c.bg === 'venn' && !isValidVennConfig(c.bgc as Record<string, unknown>)) return false;
    if (typeof c.tg !== 'string') return false;
    if (!isKnownTabId(c.tg)) return false;
    if (typeof c.tgc !== 'object' || c.tgc === null) return false;
    if (c.mpa !== undefined && typeof c.mpa !== 'number') return false;
    if (c.bl !== undefined && typeof c.bl !== 'boolean') return false;
    return true;
}

// Generation never returns once a circle's radius swamps its center in
// floating point (seen from 1e18); real values are image pixels.
const MAX_VENN_COORDINATE = 1e6;

function isValidVennConfig(bgc: Record<string, unknown>): boolean {
    const inRange = (v: unknown): boolean => typeof v === 'number' && Math.abs(v) <= MAX_VENN_COORDINATE;
    const isCenter = (p: unknown): boolean => !!p && typeof p === 'object'
        && inRange((p as Record<string, unknown>).x) && inRange((p as Record<string, unknown>).y);
    return isCenter(bgc.leftCenter) && isCenter(bgc.rightCenter) && inRange(bgc.leftRadius) && inRange(bgc.rightRadius);
}

function isTuple2Number(x: unknown): x is [number, number] {
    return Array.isArray(x) && x.length === 2
        && typeof x[0] === 'number' && typeof x[1] === 'number';
}

/**
 * A crafted link that passes the schema but feeds non-numeric/out-of-range data
 * through `applyProgress` would throw (or write garbage into `group.rotation`).
 * Reject malformed shapes here, before the game state.
 */
function isValidProgress(x: unknown): boolean {
    if (!x || typeof x !== 'object') return false;
    const pr = x as Record<string, unknown>;
    if (!Array.isArray(pr.m)) return false;
    for (const inner of pr.m) {
        if (!Array.isArray(inner)) return false;
        for (const id of inner) {
            if (!Number.isInteger(id)) return false;
        }
    }
    if (pr.mr !== undefined) {
        if (!Array.isArray(pr.mr)) return false;
        for (const v of pr.mr) {
            if (typeof v !== 'number' || !Number.isFinite(v)) return false;
        }
    }
    if (pr.sr !== undefined) {
        if (!Array.isArray(pr.sr)) return false;
        if (pr.sr.length % 2 !== 0) return false;
        for (let i = 0; i < pr.sr.length; i++) {
            const v = pr.sr[i];
            // Even indices are piece IDs (must be integers); odd indices
            // are rotation values (any finite number — applyProgress
            // normalizes them in free mode).
            if (i % 2 === 0) {
                if (!Number.isInteger(v)) return false;
            } else {
                if (typeof v !== 'number' || !Number.isFinite(v)) return false;
            }
        }
    }
    return true;
}

/**
 * `decodePayload` already translates legacy `ha`/`hf`/`va`/`vf`/`dt` payloads
 * to `bg`/`bgc`/`tg`/`tgc`, so this is a 1:1 rename plus optional `mpa`
 * propagation that keeps auto-grouping consistent between sender and receiver.
 */
export function shareCfToComposableConfig(
    cf: NonNullable<SharePayload['cf']>,
): ComposableConfig {
    const config: ComposableConfig = {
        baseCutGenerator: cf.bg,
        baseCutConfig: cf.bgc,
        tabGenerator: cf.tg,
        tabConfig: cf.tgc,
    };
    if (cf.mpa !== undefined) config.minPieceArea = cf.mpa;
    if (cf.bl !== undefined) config.borderless = cf.bl;
    return config;
}

export function buildShareUrl(baseUrl: string, payload: SharePayload): string {
    const withoutQueryOrHash = baseUrl.split('#')[0].split('?')[0];
    return `${withoutQueryOrHash}#p=${encodePayload(payload)}`;
}

export function parseLocationHash(hash: string): SharePayload | null {
    if (!hash.startsWith('#p=')) return null;
    const body = hash.slice(3);
    if (!body) return null;
    return decodePayload(body);
}

export interface EncodeOptions {
    includeProgress: boolean;
    /** When set, written to `bgc` so the link carries the sharer's background. */
    backgroundColorId?: string;
}

/**
 * The five per-style config fields a repro-params object shares with
 * GameState. `applyStyleConfigs` reads whichever one matches the
 * payload's cut style; the rest are ignored.
 */
export interface StyleConfigSource {
    composableConfig?: GameState['composableConfig'];
    fractalConfig?: GameState['fractalConfig'];
    wavyConfig?: GameState['wavyConfig'];
    trianglesConfig?: GameState['trianglesConfig'];
    classicConfig?: GameState['classicConfig'];
}

/**
 * Copy the config block matching `payload.c` from `source` onto the payload.
 * Shared by `gameStateToPayload` and `reproParamsToPayload` so the style-block
 * mapping exists once. Precondition: `payload.c` holds its final value —
 * reading the style off the payload can't disagree with what ships, but calling
 * this before assigning `c` is a silent no-op. Both callers pass a full literal.
 */
export function applyStyleConfigs(payload: SharePayload, source: StyleConfigSource): void {
    if (payload.c === 'composable' && source.composableConfig) {
        // Defaults: sine base-cut generator and classic tab generator
        // (matching src/puzzle/topology/generator.ts) so recipients reproduce
        // the same cuts when the sender omitted sub-fields.
        const c = source.composableConfig;
        const cf: NonNullable<SharePayload['cf']> = {
            bg: c.baseCutGenerator ?? 'sine',
            bgc: (c.baseCutConfig ?? {}) as Record<string, unknown>,
            tg: c.tabGenerator ?? 'classic',
            tgc: (c.tabConfig ?? {}) as Record<string, unknown>,
        };
        // Only emit `mpa` when the sender explicitly set it; recipients
        // fall back to the generator's own default when it's absent.
        if (c.minPieceArea !== undefined) {
            cf.mpa = c.minPieceArea;
        }
        if (c.borderless !== undefined) cf.bl = c.borderless === true;
        payload.cf = cf;
    }

    // `bl` is written unconditionally (even when `false`): `isValidBorderlessBlock`
    // requires it, so omitting it would make new links undecodable by shipped
    // clients. Loosen that validator first if this changes.
    //
    // `=== true` (not `?? false`) on all three blocks so the encoder never emits
    // a link its own decoder refuses: a state restored from a pre-tightening
    // build can carry a crafted `bl: 'yes'` verbatim, and `?? false` would pass
    // it back to the wire for the new validator to reject. `=== true` also
    // matches what such a state now REPRODUCES (every generator coerces the flag
    // the same way), keeping encode and generate in step.
    if (payload.c === 'fractal' && source.fractalConfig) {
        payload.ff = { bl: source.fractalConfig.borderless === true };
    }

    if (payload.c === 'wavy' && source.wavyConfig) {
        payload.wf = { bl: source.wavyConfig.borderless === true };
        if (source.wavyConfig.traceSetVersion !== undefined) {
            payload.wf.tv = source.wavyConfig.traceSetVersion;
        }
    }

    if (payload.c === 'triangles' && source.trianglesConfig?.traceSetVersion !== undefined) {
        payload.tf = { tv: source.trianglesConfig.traceSetVersion };
    }

    if (payload.c === 'classic' && source.classicConfig?.traceSetVersion !== undefined) {
        payload.clf = { tv: source.classicConfig.traceSetVersion };
    }
}

export function gameStateToPayload(
    state: GameState,
    options: EncodeOptions,
): SharePayload {
    const cutStyle = (state.cutStyle ?? 'classic') as SharePayload['c'];
    const rotationMode = (state.rotationMode ?? 'none') as SharePayload['r'];

    const payload: SharePayload = {
        v: 1,
        i: state.imageUrl ?? 'blank',
        is: [state.imageSize.width, state.imageSize.height],
        g: [state.gridSize.cols, state.gridSize.rows],
        c: cutStyle,
        s: state.seed ?? 0,
        r: rotationMode,
    };

    if (options.backgroundColorId !== undefined) {
        payload.bgc = options.backgroundColorId;
    }

    if (state.attribution) {
        payload.a = {
            n: state.attribution.photographerName,
            u: state.attribution.photographerUrl,
            p: state.attribution.photoUrl,
        };
    }

    applyStyleConfigs(payload, state);

    if (options.includeProgress) {
        const progress = extractProgress(state);
        if (progress) payload.pr = progress;
    }

    return payload;
}

export function hasShareableProgress(state: GameState): boolean {
    if (state.completed) return false;
    return state.groups.some((g) => g.pieces.size >= 2);
}

function extractProgress(state: GameState): SharePayload['pr'] | null {
    // Sort groups by smallest piece ID so the encoded output is deterministic
    // regardless of the order groups were created in `state.groups`.
    const merged = state.groups
        .filter((g) => g.pieces.size >= 2)
        .sort((a, b) => smallestPieceId(a) - smallestPieceId(b));
    if (merged.length === 0) return null;

    const m = merged.map((g) => [...g.pieces.keys()].sort((a, b) => a - b));
    const pr: NonNullable<SharePayload['pr']> = { m };

    if (state.rotationMode === 'quarter-turn') {
        // v:1 wire format is quarter-turn integers 0..3 (matching URLs in the
        // wild); the internal representation is degrees, so divide by 90.
        pr.mr = merged.map((g) => Math.round(g.rotation / 90));
        const sr: number[] = [];
        for (const g of state.groups) {
            if (g.pieces.size !== 1) continue;
            if (g.rotation === 0) continue;
            const [pieceId] = g.pieces.keys();
            sr.push(pieceId, Math.round(g.rotation / 90));
        }
        if (sr.length > 0) pr.sr = sr;
    } else if (state.rotationMode === 'free') {
        // Free mode encodes integer degrees 0..359 directly (sparse `sr` kept
        // for v:1 consistency). The `% 360` guards float drift outside [0,360):
        // 359.6 → round → 360 → % 360 → 0.
        pr.mr = merged.map((g) => normalizeDegrees(Math.round(g.rotation)));
        const sr: number[] = [];
        for (const g of state.groups) {
            if (g.pieces.size !== 1) continue;
            if (g.rotation === 0) continue;
            const [pieceId] = g.pieces.keys();
            sr.push(pieceId, normalizeDegrees(Math.round(g.rotation)));
        }
        if (sr.length > 0) pr.sr = sr;
    }

    return pr;
}

function smallestPieceId(group: { pieces: Map<number, unknown> }): number {
    let min = Infinity;
    for (const id of group.pieces.keys()) {
        if (id < min) min = id;
    }
    return min;
}
