/**
 * Derives from `buildReproParams`, not `GameState` directly, so the event and
 * the settings modal's repro block cannot drift — a Umami row pastes straight into
 * `__reproPuzzle`. Three divergences from the modal, all documented on
 * `PieceCountMismatchData`: `imageUrl` dropped; `seed` normalized to uint32;
 * `imageWidth`/`imageHeight` rounded to Umami's 4-decimal precision.
 */

import type { GameState } from '../model/types.js';
import type { PieceCountMismatchData } from '../analytics/index.js';
import type { PieceCountMismatch } from '../puzzle/topology/generator.js';
import { buildReproParams, isCutStyle, type ReproParams } from '../sharing/index.js';
import type { CutStyle } from '../game/cut-styles.js';

/**
 * Umami keeps 4 decimals; rounding here keeps the asserted value identical to
 * what lands in the database.
 */
function toUmamiPrecision(value: number): number {
    return Math.round(value * 10000) / 10000;
}

/** Umami's event-data string-property limit; see `PieceCountMismatchData`. */
const UMAMI_STRING_LIMIT = 500;

/**
 * A `Record<CutStyle, …>` rather than a `switch`, so a sixth cut style is a
 * COMPILE error instead of silently emitting no `styleConfig` — which would be
 * indistinguishable from legacy Classic, whose absence is load-bearing.
 */
const STYLE_CONFIG_READERS: Record<CutStyle, (r: ReproParams) => object | undefined> = {
    classic: (r) => r.classicConfig,
    wavy: (r) => r.wavyConfig,
    triangles: (r) => r.trianglesConfig,
    fractal: (r) => r.fractalConfig,
    composable: (r) => r.composableConfig,
};

// Drop the prototype: otherwise `STYLE_CONFIG_READERS['constructor']` is
// `Object`, `Object(repro)` returns `repro`, and `styleConfig` becomes
// `JSON.stringify(repro)` — shipping `imageUrl`, which this event must never
// carry. `isCutStyle` guards today; this makes the table safe on its own.
Object.setPrototypeOf(STYLE_CONFIG_READERS, null);

/**
 * Gated on `cutStyle` rather than whichever block is present: `buildReproParams`
 * copies every block the state carries, so a crafted link or hand-edited save
 * with a stray foreign block would otherwise attribute another style's config —
 * a row that reads as replayable and isn't. Takes the resolved `cutStyle` as a
 * parameter so the reported block and its label are one reading. `cutStyle` is
 * `string | undefined` (also hand-typed from a screenshot), so it's narrowed
 * with the share-link decoder's predicate before the lookup.
 */
function styleConfigOf(repro: ReproParams, cutStyle: string): object | undefined {
    if (!isCutStyle(cutStyle)) return undefined;
    // `?.` is not dead despite the total `Record`: the table is prototype-less
    // and indexed by a runtime value, so a lookup escaping `isCutStyle` yields
    // `undefined` rather than a TypeError this builder must not raise.
    return STYLE_CONFIG_READERS[cutStyle]?.(repro);
}

export function buildPieceCountMismatchData(
    state: GameState,
    mismatch: PieceCountMismatch,
    source: PieceCountMismatchData['source'],
): PieceCountMismatchData {
    const repro = buildReproParams(state);
    // Resolved once for both the reported field and the config lookup, so the
    // two can't diverge (see `styleConfigOf`).
    const cutStyle = repro.cutStyle ?? 'classic';
    const styleConfig = styleConfigOf(repro, cutStyle);

    // The `-1` fallbacks below are unreachable for a generated puzzle, but
    // ReproParams types every field optional (also hand-typed from a
    // screenshot). -1 rather than dropping the event: an impossible value is
    // visible as a bug here, a silent decline isn't. `cutStyle`/`rotationMode`
    // fall back to a real value instead — absence of either has a defined
    // meaning (classic, 'none'), a missing seed/grid/size does not.
    const data: PieceCountMismatchData = {
        cutStyle,
        baseCut: mismatch.baseCutId,
        expected: mismatch.expected,
        actual: mismatch.actual,
        // `>>> 0` is a no-op on every real/legitimate seed. It matters for a
        // crafted one: the decoder only checks `typeof s === 'number'`
        // (`isValidPayload`), and Umami's DECIMAL(19,4) column loses an
        // out-of-range row and rounds a fraction into a false-replayable seed.
        // Normalizing doesn't change which puzzle replays: `createSeededRandom`
        // applies ToInt32, and ToInt32(ToUint32(x)) === ToInt32(x).
        seed: repro.seed === undefined ? -1 : repro.seed >>> 0,
        cols: repro.gridSize?.cols ?? -1,
        rows: repro.gridSize?.rows ?? -1,
        imageWidth: toUmamiPrecision(repro.imageSize?.width ?? -1),
        imageHeight: toUmamiPrecision(repro.imageSize?.height ?? -1),
        rotationMode: repro.rotationMode ?? 'none',
        source,
    };

    if (styleConfig !== undefined) {
        // A crafted composable link can carry an unbounded
        // baseCutConfig/tabConfig, exceeding Umami's string limit. Omit rather
        // than truncate: truncated JSON doesn't parse, so it would look
        // replayable and not be. `JSON.stringify` can also throw (circular /
        // BigInt); the `try` is defense in depth and belongs here — both call
        // sites fire after the game is installed, inside the flow's outer try,
        // so an escape would surface as a false load-failure toast. Either way
        // it lands in the `styleConfigOmitted` bucket, not a lost event.
        const serialized = tryStringify(styleConfig);
        if (serialized !== undefined && serialized.length <= UMAMI_STRING_LIMIT) {
            data.styleConfig = serialized;
        } else {
            data.styleConfigOmitted = true;
        }
    }

    return data;
}

function tryStringify(value: object): string | undefined {
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}
