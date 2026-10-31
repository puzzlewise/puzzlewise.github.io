# Exact Mate Edges and Save Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both sides of every interior cut byte-identical mirrors (including corners), then store each cut once in a v14 save, kept only if loading doesn't get noticeably slower.

**Architecture:** Part 1 fixes path ends at the DCEL source (`faces-to-pieces.ts`), then adds one post-pass in `runGeneration` (after an image-space quantization) that rewrites every non-canonical interior path from its canonical side via a pure `deriveMatePath` and rebuilds `shape`. Part 2 makes `serializeStatic` omit paths `deriveMatePath` reproduces and `restorePieces` rebuild them, behind `STATE_VERSION = 14`. Old saves load unchanged.

**Tech Stack:** TypeScript, Vitest, Vite, Playwright (benchmark only).

**Spec:** `docs/superpowers/specs/2026-10-31-exact-mates-and-save-dedup-design.md`

## Global Constraints

- Work in `/Users/bot/src/puzzle-690`, branch `mate-paths-and-save-dedup`. Run Node tools only as `/Users/bot/homebrew/bin/fnm exec npm …` / `fnm exec npx …` (Node 22 from `.nvmrc`; never Node 24, never bare `npm`).
- All Part 1 commits come before any Part 2 commit; Part 1 must be green on its own.
- Never run `vitest -u`. Digest snapshot values (`src/puzzle/topology/__snapshots__/*.snap`) are edited by hand, only after the cause of each change is confirmed.
- Canonical side of an interior pair = the edge with the **lower `Edge.id`**.
- Geometry precision stays 2 decimals (`GEOMETRY_PRECISION_DECIMALS`); every coordinate written into a path goes through the same rounding as `quantize` then `fmt`.
- Existing (v ≤ 13) saves load exactly as today: no conversion, no rewrite. The frozen v13 fixtures in `src/move/move-receiver.test.ts` are never regenerated.
- Load-time gate: Part 2 is kept only if Adrian accepts the measured cost (suggested bar: < ~50 ms extra at 4× CPU throttling for a 192-piece Wavy load).
- Comments: follow `CLAUDE.md` (intent / not-in-code information only). Don't push or open a PR without asking Adrian.
- Every task ends with `fnm exec npx vitest run` (full suite), `fnm exec npm run lint`, and `fnm exec npx tsc --noEmit` green.

## Review Focus

1. **Self-mated edges** (Fractal orphan discs / diamond fillers mate with an edge on their own piece): align and save/load must treat them like any pair (`offA = offB`), not skip or double-process them.
2. **Pieces with holes** (inner loops in Fractal and topology styles): after shapes are rebuilt from aligned edges, loop breaks must still be detected (`buildShape` chain check) and the shape must match the piece's previous loop structure.
3. **A pair `deriveMatePath` can't reproduce** (unparseable or unusual path, asymmetric mate ids): generation leaves the pair as is, the save keeps the path, load uses it. Never throw during generation or save.
4. **Corrupt v14 blobs** (missing canonical path, missing path on a border edge, mate edge not found): load must reject through the existing `unreadable/parse-error` route, not crash or render a blank board.
5. **Unformatted legacy numbers** (`procedural-generator.ts:525` emits `L ${end.x} ${end.y}` with raw floats, possibly exponent notation): the parser accepts them; legacy Classic still aligns and round-trips.

---

### Task 1: Paths end at their corner vertices (spec 1a)

**Files:**
- Modify: `src/puzzle/topology/faces-to-pieces.ts:165-175` (`extractCurvePoints`)
- Modify: `src/puzzle/topology/__snapshots__/dcel-broad-phase-equivalence.test.ts.snap`, `src/puzzle/topology/__snapshots__/traced-geometry-digest.test.ts.snap` (hand-edited values)
- Test: `src/puzzle/topology/faces-to-pieces.test.ts` (create if absent; else add to it)

**Interfaces:**
- Produces: every topology-pipeline `EdgeDefinition` with `curvePoints` has `curvePoints[0]` equal to `start` and `curvePoints[last]` equal to `end` (same object values, piece-local).

- [ ] **Step 1: Write the failing test** `it('starts and ends curve samples at the edge vertices')`: for classic traced (`cutStyle 'classic'`, `classicConfig {traceSetVersion: 1}`, 16×12) and wavy (`wavyConfig {traceSetVersion: 1}`, 16×12), 1080×720, seed 4242, run the strategy's `scaleGrid → inscribePuzzleSize → generatePieces` (as `generateRaw` in `init-geometry-precision.test.ts`; register `tracedTabGenerator` in `beforeAll`) and assert for every edge: the last coordinate pair parsed from `edge.path` equals `fmt(edge.end.x)`, `fmt(edge.end.y)` as strings.
- [ ] **Step 2: Run it, expect FAIL** (`fnm exec npx vitest run src/puzzle/topology/faces-to-pieces.test.ts`), with a mismatch such as `70.58` vs `70.38`.
- [ ] **Step 3: Implement.** In `extractCurvePoints`, run `isEssentiallyStraight` on the raw samples unchanged, then return the mapped samples with the first replaced by `he.origin.position` and the last by `he.twin.origin.position` (both minus `bbox.min`). Classification must not change.
- [ ] **Step 4: Run the test, expect PASS.**
- [ ] **Step 5: Digests.** Run `fnm exec npx vitest run src/puzzle/topology/`. For each red digest: stash-free check of cause by temporarily reverting Step 3 (WIP edit, not `git stash`) and confirming that config goes green again; then hand-edit that config's `digest` (and `count`, which must not change) in the `.snap` file to the new value. Record which configs changed (expect: every curved topology config; `none`-tab straight-grid configs may stay unchanged).
- [ ] **Step 6: Full suite, lint, tsc green.** `init-geometry-precision.test.ts` `piecesKeepingShape` may move; update those counts to the measured values.
- [ ] **Step 7: Commit** `fix(topology): end every edge path at its corner vertex`, body: the root cause (vertex merge within `VERTEX_MERGE_TOLERANCE` without moving curves; up to 0.53/1.05 px), the list of digest configs that changed and why, `Refs #690`.

### Task 2: Edge-path parse/format/derive module

**Files:**
- Create: `src/model/edge-path.ts`
- Modify: `src/model/quantize-geometry.ts` (export `quantize`)
- Test: `src/model/edge-path.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PathSegment =
      | { cmd: 'L'; to: Point }
      | { cmd: 'C'; c1: Point; c2: Point; to: Point }
      | { cmd: 'A'; rx: number; ry: number; rotation: number; largeArc: 0 | 1; sweep: 0 | 1; to: Point };
  export function parseEdgePath(path: string): PathSegment[] | null; // null on any unrecognized token/command, or empty
  export function formatEdgePath(segments: PathSegment[]): string;
  export function deriveMatePath(path: string, start: Point, fromOffset: Point, toOffset: Point): string | null;
  ```
  and `export function quantize(value: number): number` from `quantize-geometry.ts` (existing body).
- Format (must match today's emitters byte-for-byte for already-2-decimal values): `L x y`; `C x1 y1, x2 y2, x y`; `A rx ry rotation largeArc,sweep x y`; segments joined by one space; every number via `fmt(quantize(n))`.
- `deriveMatePath`: `start` is the canonical edge's `start`; `fromOffset`/`toOffset` are the canonical and mate pieces' `imageOffset`s. Each point `p` maps to `quantize(p.x - fromOffset.x + toOffset.x)` (same for y). Reversal, with `P0 = start` and `P_i` the `to` of segment i:
  ```
  for i = n..1:  segment i goes P_{i-1} → P_i
    L          → { L, to: P_{i-1} }
    C c1 c2    → { C, c1: c2, c2: c1, to: P_{i-1} }
    A …,sweep  → { A, same rx/ry/rotation/largeArc, sweep: 1 - sweep, to: P_{i-1} }
  ```
  Returns null if the path doesn't parse.

- [ ] **Step 1: Write failing tests:**
  - `parseEdgePath`/`formatEdgePath` round-trip these exactly: `'L 10 0'`, `'C 12 3, 12 7, 10 10'`, `'A 12.50 12.50 0 0,1 25 0'`, a mixed `'L 1.50 2 C 3 4, 5 6, 7.25 8 L 9 10'`; parse accepts `'L 135.00000000001 -2e-7'` (legacy raw floats) and formats it as `'L 135 0'`; returns null for `'Q 1 2 3 4'`, `'L 1'`, `''`.
  - `deriveMatePath('L 5 0 L 10 0', {x:0,y:0}, {x:0,y:0}, {x:-10,y:0})` → `'L -5 0 L -10 0'`.
  - `deriveMatePath('C 1 2, 3 4, 5 6', {x:0,y:0}, {x:0,y:0}, {x:0,y:0})` → `'C 3 4, 1 2, 0 0'`.
  - `deriveMatePath('A 5 5 0 0,1 10 0', {x:0,y:0}, {x:0,y:0}, {x:0,y:0})` → `'A 5 5 0 0,0 0 0'`.
  - Involution: for each mixed path above, `deriveMatePath(deriveMatePath(p, s, a, b)!, startOfMate, b, a) === formatEdgePath(parseEdgePath(p)!)` where `startOfMate` is the translated last point of `p`, with non-integer 2-decimal offsets such as `{x:-64.33,y:0}` / `{x:-118.4,y:-0.07}`.
  - Float noise: `deriveMatePath('L 0.1 0', {x:0,y:0}, {x:0.2,y:0}, {x:0.3,y:0})` → `'L 0.10 0'` (raw sum is 0.09999999999999998).
- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** `src/model/edge-path.ts` per the interface; tokenizer splits on whitespace and commas, accepts JS number syntax.
- [ ] **Step 4: Run, expect PASS.** Full suite, lint, tsc green.
- [ ] **Step 5: Commit** `feat(model): parse, format and derive mate edge paths`, `Refs #690`.

### Task 3: Exact mates in generated puzzles (spec 1b)

**Files:**
- Modify: `src/model/quantize-geometry.ts` (`quantizeEdge` rounds `start`/`end` in image space)
- Create: `src/model/align-mates.ts`
- Modify: `src/game/generation-core.ts:78`
- Modify: `src/game/init-geometry-precision.test.ts` (replace the byte-identity test; `piecesKeepingShape` → measured, expected all 0)
- Test: `src/model/align-mates.test.ts`, `src/game/exact-mates.test.ts`

**Interfaces:**
- Consumes: `parseEdgePath`, `formatEdgePath`, `deriveMatePath`, `quantize` (Task 2).
- Produces: `export function alignMatePaths(pieces: GeneratedPiece[]): GeneratedPiece[]` (pure). `runGeneration` becomes `sealPieceGeometry(alignMatePaths(quantizePieceGeometry(rawPieces)))`.
- Quantization change: with `offRaw` = the piece's raw `imageOffset` and `offQ = quantizePoint(offRaw)`, each edge's `start`/`end` becomes `quantize(quantize(p - offRaw) + offQ)` per axis (round in image space, then convert to the quantized local frame). `curvePoints` and `imageOffset` keep today's rounding.
- `alignMatePaths`, per interior edge `e` on piece `A` with `e.id < e.mateEdgeId` whose mate `m` on piece `B` exists and has `m.mateEdgeId === e.id`, and whose path parses:
  1. canonical path = `formatEdgePath(segments with the last segment's `to` set to e.end)`;
  2. `m.path = deriveMatePath(canonicalPath, e.start, A.imageOffset, B.imageOffset)`.
  Pairs failing any condition stay untouched. Then every piece's `shape = buildShape(edges)`. Inputs are not mutated.

- [ ] **Step 1: Write failing tests.**
  - `align-mates.test.ts`: two hand-built pieces (offsets `{x:0,y:0}` and `{x:-64.33,y:0}`) with a mated pair whose mate path is off by 0.01 in one coordinate → aligned mate path equals `deriveMatePath(...)` of the canonical; canonical's last point snapped to its `end`; a self-mated pair on one piece (Review Focus 1); an asymmetric pair (mate's `mateEdgeId` points elsewhere) and an unparseable path (`'Q 1 2 3 4'`) are left byte-identical (Review Focus 3); input objects unchanged; `shape === buildShape(edges)` for every output piece.
  - `exact-mates.test.ts`, for each style case in `init-geometry-precision.test.ts` (same grids, `SEED = 4242`, `createNewGame`): for every interior pair (lower id canonical) `mate.path === deriveMatePath(canon.path, canon.start, A.imageOffset, B.imageOffset)`; `mate.start` deep-equals the canonical `end` translated by the same rule and `mate.end` the canonical `start`; every path's last point equals `fmt(end)` strings; every piece's `shape === buildShape(piece.edges)`; for Fractal and any style with holes, the number of `M` subpaths in `shape` equals that of the raw generator's shape (Review Focus 2).
  - In `init-geometry-precision.test.ts`, replace `'leaves shape and path strings byte-identical to the raw generator output'` with `'moves no path coordinate more than 0.02 px from the raw generator output'`: parse each final edge path and the raw one; same segment count and commands; every number within 0.02.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the quantization change and `align-mates.ts`; wire into `runGeneration`.
- [ ] **Step 4: Run the new tests, expect PASS.** Set `piecesKeepingShape` to the measured counts (expected 0 for every style; if not 0, find out why before writing the number down).
- [ ] **Step 5: Full suite, lint, tsc green.** The topology digests must **not** change in this task (they digest raw generator output); if one does, stop and find out why.
- [ ] **Step 6: Commit** `fix(generation): derive each mate edge from one canonical side`, body: separate per-frame rounding made mates differ by up to 0.014 px; same seed now generates geometry within 0.02 px of before (accepted, spec); `Refs #690`.

### Task 4: Baseline measurements (no commit)

**Files:** throwaway script in `/tmp/puzzle-690-bench/` (outside the repo); results in `/tmp/puzzle-690-bench/results.md`.

- [ ] **Step 1: Generate the benchmark save.** With `fnm exec npx vite` (dev server) running from the worktree, the Playwright MCP browser (CDP via `page.context().newCDPSession(page)` in `browser_run_code_unsafe`; don't install browsers) opens the app origin, then in-page: `await import('/src/puzzle/topology/traced-tab-generator.ts')` + `registerTabGenerator`, `createNewGame('img', {width:1080,height:720}, {width:1200,height:900}, {cols:16,rows:12}, {cutStyle:'wavy', wavyConfig:{traceSetVersion:1}, seed:4242})`, `saveNewPuzzle(state)` from `/src/persistence/storage.ts`. Record `localStorage` key lengths (`puzzle-game-state`, `puzzle-progress`) and whether the geometry value starts with `'\x01LZ'`.
- [ ] **Step 2: Time `loadSavedGame`** in the same page with CDP `Emulation.setCPUThrottlingRate {rate: 4}` and mobile emulation (412×892, DPR 2.625): 3 warm-up calls, then median and p90 of 20 calls (`performance.now()` around `loadSavedGame()`).
- [ ] **Step 3: Time boot to rendered board** on a production build (`fnm exec npm run build`, `fnm exec npx vite preview`): copy the two localStorage values into the preview origin, reload with the same throttling and emulation, measure from navigation start until the board's piece elements are in the DOM; median of 7 runs.
- [ ] **Step 4: Write** the numbers and commit SHA into `results.md` under "Part 1 baseline".

### Task 5: Save format v14 (spec part 2)

**Files:**
- Modify: `src/persistence/serialization.ts` (`STATE_VERSION`, version history, `SUPPORTED_VERSIONS`, `SerializedEdge`, `serializeStatic`/`serializeState` piece serialization, `restorePieces`)
- Modify: `src/game/init-geometry-precision.test.ts` (`SIZE_GUARD_CHARS` and its comment numbers)
- Test: `src/persistence/serialization.test.ts`, `src/game/init-geometry-precision.test.ts`

**Interfaces:**
- Consumes: `deriveMatePath` (Task 2); aligned pieces (Task 3).
- `SerializedEdge` becomes `Omit<Edge, 'path'> & { path?: string; curvePoints?: Point[] }`.
- `function serializePieces(pieces: Piece[]): SerializedPiece[]` replaces `pieces.map(serializePiece)` in both writers. A non-canonical interior edge (`mateEdgeId >= 0 && mateEdgeId < id`) omits `path` only if its canonical edge exists, points back, and `deriveMatePath(canon.path, canon.start, canonPiece.imageOffset, piece.imageOffset) === edge.path`. Shape omission unchanged.
- `restorePieces`, version ≥ 14: before building `shape`, fill every missing path from its canonical edge (lookup map edge id → {edge, piece}). Throw `Invalid state: piece ${i} edge ${id} has no path` when the edge is a border edge, is canonical, its canonical edge is missing / doesn't point back / has no path, or derivation returns null; throw `Invalid state: piece ${i} edge ${id} has a non-string path` for a present non-string. v ≤ 13 unchanged.
- Version history line: `v14: a non-canonical interior edge (mateEdgeId < id) omits path when deriveMatePath (model/edge-path.ts) rebuilds it byte-identically from its mate; this makes edge-path.ts part of the format.`

- [ ] **Step 1: Write failing tests** in `serialization.test.ts`:
  - `'omits rebuildable mate paths and restores them'`: for each style (reuse the `init-geometry-precision.test.ts` cases or a `createNewGame` helper), `recombine(JSON round-trip of serializeStatic, serializeProgress)` gives `pieces` deep-equal to `state.pieces`, and the blob has exactly one `path` per interior pair (count = interior pairs) — including Fractal's self-mated pairs (Review Focus 1).
  - `'keeps a mate path it cannot rebuild'`: alter one mate path by 0.01 in memory; the blob keeps that path; round trip restores it verbatim (Review Focus 3).
  - Corrupt v14 rejects (Review Focus 4): canonical path deleted; border edge path deleted; mate id pointing to a missing edge; each makes `recombine` throw an `Invalid state:` error, and `loadSavedGame` returns `unreadable/parse-error` (one storage-level case in `storage.test.ts`).
  - `'loads a v13 blob unchanged'`: a v13 static blob (hand-built or derived from the existing v12/v13 fixtures in this file) restores with every `edge.path` byte-identical to the blob's.
  - Version: `serialized.version === 14`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per the interface.
- [ ] **Step 4: Run, expect PASS.** Run the size test; set `SIZE_GUARD_CHARS` to ~16% above the new measured Wavy 16×12 size (rounded up to the next 50 000) and update the comment's numbers (measured size, old 1.15 MiB). `storage.test.ts:1311` (two decodes per load) must still pass unchanged.
- [ ] **Step 5: Full suite, lint, tsc, `fnm exec npm run build` green.**
- [ ] **Step 6: Commit** `feat(persistence): store each interior cut once (v14)`, body with measured size before/after, `Closes #690`.

### Task 6: Load-time gate

- [ ] **Step 1:** Repeat Task 4 Steps 1–3 on the Task 5 commit; write numbers under "Part 2" in `results.md`, plus the deltas.
- [ ] **Step 2:** Report to Adrian: save size before/after (characters, % of the ~4.75M-char quota), `loadSavedGame` median/p90 before/after, boot-to-board median before/after, all at 4× throttling. Ask whether Part 2 stays.
- [ ] **Step 3:** If Part 2 is rejected, drop the Task 5 commit (`git reset --keep <task-3-sha>` after confirming a clean tree). #690 then stays open; Part 1 commits only say `Refs #690`.
- [ ] **Step 4:** Ask Adrian before pushing (`git push -u origin mate-paths-and-save-dedup`) and opening a PR; the PR description carries the measurements and the digest-change list from Task 1.
