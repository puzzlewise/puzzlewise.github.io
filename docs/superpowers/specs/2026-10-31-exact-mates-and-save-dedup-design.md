# Exact mate edges, then a save format that stores each cut once

**Date:** 2026-10-31
**Status:** Draft (design), awaiting approval
**Issue:** [#690](https://github.com/puzzlewise/puzzlewise.github.io/issues/690) (sub-issue of the #685 performance audit)

## Summary

Two independent changes, delivered as separate commits on one branch so the
first can be kept even if the second is dropped:

1. **Generator: mates match exactly.** Every interior cut is computed and
   rounded once; the mate's path is derived from it by reversing and
   translating. Every path also ends exactly at its corner vertex. This is
   kept regardless of part 2: it's more correct data, even though the game
   works without it.
2. **Save format v14: store each interior cut once.** One side of each
   interior edge pair stores its path; the mate's path is rebuilt on load.
   Existing saves are left as they are and keep loading. Kept **only if**
   loading a saved puzzle doesn't get noticeably slower (see
   [Load-time gate](#load-time-gate)).

## Why

- The biggest puzzles already need the lz-string fallback to fit in
  `localStorage` (a 192-piece save is 0.7–1.3M characters, about 25% of the
  quota). The audit estimates ~45% smaller saves without the duplicate paths.
  This is cheap headroom, wanted before the higher-impact audit items, some
  of which may keep more data around.
- Today the two sides of a cut don't match, so the save can't simply drop one
  side: rebuilding it wouldn't reproduce the stored string. Measured on a
  16×12 board, seed 4242, 1080×720:
  - **Interior points** differ by up to 0.0141 px (√2 × 0.01), because each
    side is rounded (`fmt`, `toFixed(2)`) separately in its own piece-local
    frame, and `imageOffset` is quantized separately. About half the points
    differ, so with ~100 points per curved cut practically no edge would pass
    a byte-identity check.
  - **Corners:** a path's last point can be up to 0.53 px (traced Classic) or
    1.05 px (Wavy) away from its `edge.end`; 0.36 px in Triangles, 0.43 px in
    composable. Legacy Classic and Fractal are exact.

### Root cause of the corner gaps

`VertexPool.getOrCreate` (`src/puzzle/topology/dcel.ts:495-533`) merges
segment endpoints within `VERTEX_MERGE_TOLERANCE = 3` into the first vertex
inserted, but never moves the segment's curve to that vertex. Endpoints
disagree because:

- at interior crossings, each curve splits at its own bezier-js intersection
  estimate (`pairiteration` stops at box size < 0.5), so the two estimates can
  be ~0.5 px apart, more at shallow crossings;
- where cuts meet the border, `findPointOnCurve` → bezier-js `project` has a
  t-step of 0.001, ~1 px on a 1080 px border.

`halfEdgeToEdgeDef` takes `start`/`end` from the vertices
(`faces-to-pieces.ts:116-128`), but `extractCurvePoints`
(`faces-to-pieces.ts:165-175`) takes the samples from the curve itself, and
`compose.ts:75-84` builds the path from `curvePoints[1..]`. This breaks the
invariant documented at `src/puzzle/composable/types.ts:42-44` (first sample
= edge start, last = edge end). `edge.start`/`edge.end` come from the same
vertex on both mates, but `quantizePieceGeometry` rounds them (and
`imageOffset`) per piece, in each piece's own frame, so after quantization
they agree only within ~0.01 px.

`clampTabToCurve` and the template branch of `compose.ts` (`:118-147`) are
dead in production (`generator.ts:224` passes no template and
`disableTabs: true`); every shared edge goes through `fallbackPath`.

## Goals

- Mates are exact: an edge's path is, to the last byte, the reverse of its
  mate's path translated into its own piece-local frame.
- Every path starts at `edge.start` and ends at `edge.end`.
- With part 2: smaller saves for new puzzles, and loading stays fast.

## Non-goals

- The anti-aliasing seams visible between pieces (separately clipped
  per-piece SVGs) — a separate problem.
- Reducing curve sample density in paths, or changing compression.
- Raising the maximum grid size.

## Anti-goals

- Any visible change to puzzles. Sub-pixel shifts are accepted (see
  constraints); anything a player could see is a failure.
- Regenerating geometry on load (generation takes seconds on phones).
- Loading a saved puzzle getting noticeably slower.
- Breaking or changing how existing saves load.

## Decided constraints

- **Same seed, slightly different geometry is fine.** After part 1 a seed
  generates geometry up to 0.014 px different from today (interior points),
  and up to ~1 px at corners, including for share links created before the
  update. Decided by Adrian.
- **Existing saves are not converted or rewritten.** They load exactly as
  today and keep both paths until the player starts a new puzzle. Decided by
  Adrian: converting adds failure modes and complexity for no real gain,
  since those saves already fit. Same as the v12 precedent
  (`2026-07-26-geometry-blob-derived-data-design.md`).
- **Separate commits:** all part 1 commits come before any part 2 commit, and
  part 1 must stand alone (green tests, no dependency on part 2).
- **Geometry digest tests are updated deliberately, never with `vitest -u`**
  (`CLAUDE.md`, "bezier-js's pinned version is part of the geometry
  contract"). Each changed digest must be traced to part 1's changes before
  its value is edited.

## Design

### Part 1: generator

#### 1a. Paths end at their corner vertices

In `extractCurvePoints` (or `halfEdgeToEdgeDef`), replace the first and last
samples with the half-edge's start and end vertex positions. This restores
the `composable/types.ts:42-44` invariant for every topology-pipeline style
(traced Classic, Wavy, Triangles, composable), and the path, built from
`curvePoints[1..]`, then ends at the vertex.

Snapping the DCEL curves themselves to merged vertices (in `buildDCEL`) is
the alternative; it's not chosen because it changes more geometry for no
extra benefit here. *(Builder's call if 1a turns out insufficient.)*

The `isEssentiallyStraight` check runs on the samples; whether it runs before
or after the replacement must not change which edges count as straight in
practice — check the classic/wavy piece counts and digests to confirm.

#### 1b. Mates derived from one canonical side

Add one pure function in `src/model/` (name is the builder's), roughly:

```ts
deriveMatePath(path: string, from: Edge-ish start, fromOffset: Point, toOffset: Point): string
```

It parses an edge path (the `L`, `C` and fractal `A` commands the generators
emit), reverses it, translates every coordinate by
`fromOffset → toOffset` (image = local − `imageOffset`, so
local_B = local_A − offA + offB), and formats with `fmt`. For `A` commands it
swaps endpoints and flips the sweep flag; `rx`/`ry` and rotation are
unchanged. The reversed path's implicit start is the canonical edge's last
point; its final point is the canonical edge's `start`.

Generators use it so the non-canonical side's `path` is produced from the
canonical side's **final, rounded** path string and **quantized** offsets —
never computed independently:

- **Topology pipeline:** in `composePuzzle` / `buildEdge`
  (`compose.ts`), which sees all piece definitions and already carries
  `isFirstSide` / `sharedEdgeKey` (`faces-to-pieces.ts:147-150`). Because the
  offsets are quantized after composition today (`quantize-geometry.ts`), the
  builder must make the derivation use the same quantized offsets that end up
  in the piece — e.g. derive mates after quantization, or quantize offsets
  first.
- **Fractal** (`fractal/convert.ts:410-500`): already exact numerically, but
  each side is formatted independently; derive the mate's arc via the same
  function.
- **Legacy Classic** (`procedural-generator.ts`): measured exact. Apply the
  function too only if needed for part 2's byte-identity; otherwise leave it
  alone. Its digests are expected to stay unchanged either way — a useful
  check.

**Exact `start`/`end` too** *(Claude's call)*: round vertex positions in
image space (2 decimals) and derive each piece's local `start`/`end` as
image − `imageOffset`, with `imageOffset` itself 2-decimal. Local values
are then exact 2-decimal numbers in both frames, so mates' `start`/`end`
agree exactly, and the canonical path's ends (formatted with `fmt`) land
exactly on them. Watch for `toFixed` vs `Math.round(x*100)/100` rounding
the same number differently; use one rounding for both.

The canonical side is the edge with the **lower `Edge.id`** of each pair,
the same rule part 2 uses. (Derivation is an involution on 2-decimal values,
so direction shouldn't matter, but one rule avoids surprises.) Self-mated
edges (Fractal discs/diamonds that mate on their own piece) work the same
way with `offA = offB`.

Bounds: `bounds` are sealed from curve samples; after 1a/1b they may differ
from the final paths by ≤ 0.014 px. Acceptable; builder may recompute if it
falls out naturally.

#### Part 1 tests

- New invariant test across all cut styles (classic traced, classic legacy,
  wavy, triangles, fractal, composable — configs as in
  `init-geometry-precision.test.ts`): for every interior pair,
  `deriveMatePath(canonical) === mate.path` exactly, and every path's first
  implicit point equals `start` and last point equals `end` (numerically).
- Unit tests for `deriveMatePath`: `L`, `C`, `A`, mixed; involution
  (deriving twice returns the original string).
- Digest tests (`dcel-broad-phase-equivalence.test.ts`,
  `traced-geometry-digest.test.ts`): expected to change. Confirm the cause
  by temporarily reverting 1a and 1b in turn; then update the expected values
  by hand, one config at a time, with the reason in the commit message.
  Unchanged configs must stay unchanged.
- `init-geometry-precision.test.ts` `piecesKeepingShape` counts and other
  pinned values may move; update with the measured numbers.

### Part 2: save format v14

#### Writing

- `STATE_VERSION = 14`; add 14 to `SUPPORTED_VERSIONS`; extend the version
  history comment.
- In `serializePiece` (`serialization.ts:278-282`), for each interior edge
  that isn't the canonical (lower-id) side of its pair, omit `path` **only
  if** `deriveMatePath(canonical) === edge.path`; otherwise store it as
  today. Same per-item byte-check safety net as v12's `shape` omission.
- `shape` omission keeps working as now (it's checked against the complete
  in-memory edges).

#### Loading

- In `restorePieces`, for v14: before `shape` is rebuilt
  (`serialization.ts:323`), rebuild any missing mate path from its canonical
  edge. A missing path on a border edge, on a canonical edge, or whose mate
  is missing or also lacks a path is corrupt → throw (lands in the existing
  `unreadable/parse-error` handling and corrupt-save dialog).
- In-memory pieces stay complete; nothing outside `src/persistence/` changes.

#### Existing saves (v ≤ 13)

- Loaded exactly as today: no conversion, no rewrite. Their pieces keep
  both paths of every cut, so a v13 game in progress keeps its slightly
  mismatched mates until the player starts a new puzzle.
- The frozen v13 legacy saves in `move-receiver.test.ts` (plain and
  LZ-compressed) must keep loading. Never regenerate those fixtures.

#### Part 2 tests

- Round trip for every cut style: save → JSON → `recombine` gives pieces
  equal to the in-memory ones, and the blob omits the expected paths.
- A v13 blob loads unchanged (paths byte-identical to the stored ones), and
  resuming it writes no geometry.
- Corrupt v14 blobs (missing canonical path, etc.) are rejected.
- Update the size guard (`init-geometry-precision.test.ts`,
  `SIZE_GUARD_CHARS`) and its comment with measured numbers;
  `storage.test.ts:1311` (exactly two decodes per load) must still hold or be
  consciously adjusted.

### Load-time gate

Part 2 is kept only if loading a saved puzzle doesn't get noticeably slower.

- Measure before (part 1 only) and after (part 2), production build,
  Chromium with 4× CPU throttling and mobile emulation as in the audit
  (412×892, DPR 2.625), with a 192-piece Wavy 16×12 save (the largest).
- Report: time for `loadSavedGame` (decompress + parse + restore), and boot
  to first rendered board, median of ≥ 5 runs each; and the save size
  before/after (plain characters, and whether it still needs compression).
- Suggested bar (Claude's suggestion, Adrian decides with the numbers): under
  ~50 ms extra at 4× throttling for a normal v14 load.
- If part 2 is rejected, drop its commits; part 1 stays.

## Delivery

- One branch, one PR. Commit order: part 1 (1a and 1b as separate commits,
  each with its own test and digest updates), then the load-time baseline
  measurement, then part 2 commits.
- The measurements go in the PR description.

## Left to the builder

- Function names and exact placement of `deriveMatePath`.
- Where exactly offsets get quantized relative to mate derivation.
- Whether legacy Classic needs the derivation applied.
- How the load benchmark is scripted (Playwright against `vite preview`).
