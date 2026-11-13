# WebGL Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SVG DOM renderer with a WebGL2 renderer that draws the table in
one draw call per frame. It should look the same or better, hold 60 fps on the iPad
6th gen, and keep memory bounded. Then delete the SVG renderer and the Simple
effects level.

**Architecture:** The geometry is prepared once per game: SVG path strings are
flattened, triangulated, and turned into stroke meshes. It goes into one static
vertex buffer. Each frame:
- per-piece transforms are written to a float data texture;
- the index buffer is rebuilt only when z-order or group membership changes;
- shadows and glow are cached per group, in group-local space, in a halo atlas
  produced by offscreen Gaussian passes;
- one shader draws halos, outline strokes and piece fills in z-order.

Hit-testing is done on the CPU against the flattened loops. The renderer itself
runs the completion zoom and spin. Appearance settings reach it through a
resolver that reads the existing CSS variables and attributes on `<html>`, so the
settings code is unchanged.

**Tech Stack:** TypeScript, WebGL2 (GLSL ES 3.00), earcut (new runtime dependency), Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-webgl-renderer-design.md`. Read it
first; this plan argues from it. Measurement tooling and the 192-piece fixture
are in `spike/render-perf/` (gitignored, local only; see its `README.md` and
`RESULTS.md`).

## Global Constraints

- **WebGL2 only.** No WebGL1 path and no SVG fallback after the switch.
- **One draw call per frame for the table, with no per-group state changes.**
  Halos, strokes and fills share one program, one vertex array and one index
  buffer. Exceptions: offscreen halo passes, which run only when a halo is
  (re)built, and debug overlays. Per-group draws cost ~10 fps on the iPad
  (spike ladder).
- **No MSAA** (`antialias: false`; MSAA costs ~35 fps on the iPad). Edges are
  antialiased in the shader.
- **Context:** `alpha: false`, cleared to the resolved `--puzzle-bg-color`.
- **World units:** all visual sizes are world units that scale with zoom, except
  constant-width outlines (screen units) and the 8 px hit probe (screen px).
- **Exact visual values:**
  - Outline stroke: 3 units wide, round joins and caps, colour
    `--piece-outline-color` (default `#080808`).
  - Inner outline: the inner 1.5 units, drawn above the pieces.
  - Shadow preset idle: `drop-shadow(0 0 4px rgba(0,0,0,.35))`.
  - Dragging: `drop-shadow(0 0 12px rgba(0,0,0,.45))`.
  - Selected: glows of `--selection-glow` of 6 units at 90%, then 14 at 70%,
    then 24 at 40%.
  - Selected and dragging: the drag shadow, then the three glows.
  - Shadow preset prefix: the 4 px idle shadow comes first in every chain.
  - CSS `drop-shadow` blur is a Gaussian with σ = radius / 2, and each shadow in a
    chain shadows the result of the previous ones.
  - Blank fill: `#ffffff`. Mateless-edge debug stroke: `#FF69B4`, 2 units.
  - Viewport scale is clamped to 0.05–5.
  - Completion zoom and spin: `VIEWPORT_TRANSITION_MS` = 800 with
    `cubic-bezier(.42,0,.58,1)`.
- **Visual target (spec decision 3):** pixel-identical is a working target; the
  real one is "same or better", and the floor is "still looks good" as judged by
  the owner. If identical stalls, keep the work and bring screenshots. Never
  discard a near-miss.
- **Performance gate:** the spec's targets table, displayed fps measured with
  xctrace Core Animation FPS. The Pixel 9a must match SVG's measured rate up to its
  refresh rate. No frame over 50 ms at drag start, completion zoom, overlay
  dismissal or a merge. First frame at most SVG + ~100 ms on the iPad.
- **No generation, model or persistence changes.** The bezier-js digest tests must
  stay green, and never re-record them (`CLAUDE.md`).
- **Comments:** the repo `CLAUDE.md` policy (categories 5–6 only, and only when
  definitely worth it). Planning docs are historical; don't edit them.
- **Tooling:** run Node via `/Users/bot/homebrew/bin/fnm exec npm …` (`.nvmrc`,
  Node 22). The tests are `fnm exec npm test`, plus `npm run lint` and
  `npm run build`.

## Review Focus

1. **Photo aspect ratio differs from `imageSize`** (borderless, fractal): the fill
   must crop exactly like SVG `xMidYMid slice`, not stretch. Pinned in Task 6.
2. **Pieces with holes** (`__startVennPuzzle`): holes are see-through and can't be
   grabbed (even-odd). Pinned in Tasks 6 and 8.
3. **A new game reuses piece ids from 0:** nothing from the previous game's
   meshes, halos or photo may survive (the 40f5a852 bug). Pinned in Task 7.
4. **Completion while the tab is hidden** (rAF paused): the transition promise must
   still resolve, or the completion overlay never appears. Pinned in Task 2 (SVG)
   and Task 11 (WebGL timer guard).
5. **WebGL context lost mid-game:** no blank table after restore, and model,
   selection and z-order survive. Pinned in Task 12 (device check with
   `WEBGL_lose_context`) and Task 7 (the scene is CPU-side and rebuildable).

## File map

New, under `src/renderer/webgl/` (each with a sibling `*.test.ts` unless marked GL glue):

| File | Responsibility |
|---|---|
| `path-flatten.ts` | Parse `M L H V C S Q T A Z` and flatten to polylines; deterministic. |
| `photo-mapping.ts` | `xMidYMid slice` UV mapping and `MAX_TEXTURE_SIZE` downscale size. |
| `piece-mesh.ts` | Per piece: fill triangles (earcut, even-odd holes), loops for hit-testing, per-edge polylines. |
| `stroke-mesh.ts` | Polyline → stroke vertices (centerline, normal, side, round joins and caps). |
| `scene.ts` | CPU scene: piece slots, groups, z-order, transform data, outer-edge sets, index assembly, dirty flags. |
| `hit-test.ts` | Screen point → piece id, in z-order with even-odd. |
| `animation.ts` | Cubic-bezier easing and the timed tweens for the viewport and group spin. |
| `halo-recipe.ts` | Pure: halo state per group, chain steps (σ, colour, alpha), kernel weights, atlas layout. |
| `halo-gl.ts` | GL glue: silhouette → blur → chain passes into the halo atlas. |
| `gl-context.ts` | GL glue: context creation, `WebGLUnsupportedError`, loss and restore events. |
| `shaders.ts` | GL glue: the main program and the halo programs (GLSL sources). |
| `debug-overlay.ts` | HTML overlay for debug piece labels and up-triangles (jsdom-tested). |
| `webgl-renderer.ts` | `WebGlRenderer implements Renderer`: wires everything (GL glue). |

New: `src/renderer/appearance.ts` (+ test) holds `RendererAppearance` and the resolver
and observer.

Modified:
- `src/renderer/types.ts` (port), `src/renderer/index.ts`
- `src/renderer/svg-dom-renderer.ts` (implements the new port until it's deleted)
- `src/interaction/setup-interaction.ts`, `src/app/viewport-fit.ts`, `src/app/bootstrap.ts`
- `src/test-helpers/fake-renderer.ts`
- `package.json` (earcut)

Deleted in Milestone 7, as listed there.

---

## Milestone 1: port changes, SVG still the only renderer (one PR)

### Task 1: Classify presses by point, not by DOM target

**Files:**
- Modify: `src/interaction/setup-interaction.ts:165-182`, `src/renderer/types.ts`, `src/renderer/svg-dom-renderer.ts`, `src/test-helpers/fake-renderer.ts`
- Test: `src/interaction/setup-interaction.test.ts`

**Interfaces:**
- Produces: `Renderer` without `pieceIdFromTarget`. `classifyTarget` treats the
  container and anything inside `[data-puzzle-table]` as the table, so SVG piece
  elements and the WebGL canvas both count. For table targets it decides by
  `renderer.pieceIdAtPoint(point)`.

- [ ] **Step 1: Write the failing tests** in `setup-interaction.test.ts`:
  - `'a table press directly on a piece classifies via pieceIdAtPoint'`: the fake
    returns 7 at the press point → `{ kind: 'piece', pieceId: 7 }`.
  - `'a press whose target is an element inside [data-puzzle-table] classifies by point'`:
    the target is a child of the table, as SVG piece elements are today.
  - `'a table press near a piece falls back to the 8px probe'`: null at the point,
    7 at a probe offset → piece 7.
  - `'a press on a non-table element is ignored'`.
  - `'wheel (no point) on the table classifies as background'`.
- [ ] **Step 2: Run** `fnm exec npx vitest run src/interaction/setup-interaction.test.ts`.
  Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - In `classifyTarget`, the table check becomes
    `target === container || (target instanceof Element && target.closest('[data-puzzle-table]') !== null)`.
    Anything else is `ignore`, so UI elements above the table still block presses.
  - With a point, return `pieceIdAtPoint(point)` if it's non-null, otherwise
    `probeNearbyPieceId`. Without a point, return background.
  - Delete `pieceIdFromTarget` from the port, `SvgDomRenderer` and the fake.
  - SVG's `pieceIdAtPoint` (via `elementFromPoint`) already gives the same results.
- [ ] **Step 4: Run** the full suite, `fnm exec npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `refactor(interaction): classify table presses by point`

### Task 2: Renderer-owned completion zoom and spin

**Files:**
- Modify: `src/renderer/types.ts`, `src/renderer/svg-dom-renderer.ts`, `src/app/viewport-fit.ts:93-232`, `src/test-helpers/fake-renderer.ts`
- Test: `src/app/viewport-fit.test.ts`, `src/renderer/svg-dom-renderer.test.ts`

**Interfaces:**
- Produces, on `Renderer`:
  - `transitionViewport(scale: number, offsetX: number, offsetY: number): Promise<void>`.
    Animates from the current transform over `VIEWPORT_TRANSITION_MS` and
    resolves once the target is applied. It must resolve within
    `VIEWPORT_TRANSITION_MS + 200` even if no frame ever runs.
  - `animateGroupRotation(groupId: number, fromDeg: number, toDeg: number, pivotLocal: Point): Promise<void>`.
    Same duration and easing. The renderer pins the pivot and draws the
    group at the interpolated angle, then returns it to its model transform.
- Removes: `enableViewportTransition`, `disableViewportTransition`, `invalidateGroup`.
- `viewport-fit.ts` no longer imports `applyGroupTransform` or
  `VIEWPORT_TRANSITION`, and no longer queries the DOM.

- [ ] **Step 1: Write the failing tests.** In `viewport-fit.test.ts`, with the fake
  renderer recording calls and resolving the promises manually:
  - `'completion zoom calls transitionViewport with the fit transform and completes after it resolves'`
  - `'a rotated completed group spins via animateGroupRotation from its rotation to the shortest upright angle about the image centre'`.
    Example: from 300°, `toDeg` is 360 and `pivotLocal` is
    `getGroupImageCenter(...)`.
  - `'onComplete fires exactly once even if transitionViewport resolves twice'`

  In `svg-dom-renderer.test.ts`:
  - `'transitionViewport resolves on table transitionend'`
  - `'transitionViewport resolves after 1000ms with no transitionend'` (fake timers)
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the DOM spin code and the `transitionend` +
  fallback-timer logic from `viewport-fit.ts` into `SvgDomRenderer` behind the two
  methods. `zoomToFitCompletedPuzzle` keeps its model writes, unchanged: the
  upright `position` and `rotation = 0`. It awaits
  `Promise.all([transitionViewport(...), spin])` and then calls `renderCurrent` and
  `onComplete`.
- [ ] **Step 4: Run** `fnm exec npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `refactor(renderer): own the completion zoom and spin`

### Task 3: Appearance input for the renderer

**Files:**
- Create: `src/renderer/appearance.ts`, `src/renderer/appearance.test.ts`
- Modify: `src/renderer/types.ts`, `src/renderer/svg-dom-renderer.ts` (no-op), `src/test-helpers/fake-renderer.ts`, `src/app/bootstrap.ts:96-110`

**Interfaces:**
- Produces:
  ```ts
  export type Rgba = readonly [number, number, number, number]; // 0–1, straight alpha
  export interface RendererAppearance {
      outline: 'outline' | 'shadow' | 'none';
      outlineColor: Rgba;
      constantWidth: boolean;
      innerOutline: boolean;
      selectionGlowColor: Rgba;
      backgroundColor: Rgba;
      pieceOpacity: number;      // 0–1
      debugPieces: boolean;      // html.show-debug-pieces
      matelessEdges: boolean;    // html.show-mateless-edges
  }
  export function parseCssColor(value: string): Rgba | null;
  export function readRendererAppearance(root: HTMLElement, resolveColor: (cssValue: string) => string): RendererAppearance;
  export function observeRendererAppearance(root: HTMLElement, onChange: (a: RendererAppearance) => void): () => void;
  ```
  `Renderer.setAppearance(a: RendererAppearance): void`.
- Sources:
  - `outline` from `data-piece-outline`.
  - `innerOutline` = outline is `'outline'` and `loadOutlineInsidePreference()`,
    as at `bootstrap.ts:104-109` today. Keep `setInnerOutlineEnabled` on the port
    until Milestone 7; SVG still needs it.
  - `constantWidth` from `data-outline-constant-width`.
  - Colours: resolve `var(--piece-outline-color)`, `var(--selection-glow)` and
    `var(--puzzle-bg-color)` by setting them as `color` on a hidden probe
    element and reading the computed `color`. That handles `var()`,
    `color-mix` and theme flips.
  - `pieceOpacity` from `--piece-opacity` (default 1).
- The observer is a `MutationObserver` on `<html>` (`attributes`, with
  `attributeFilter` covering `style`, `class` and `data-*`) plus a
  `matchMedia('(prefers-color-scheme: dark)')` change listener. It coalesces to
  one `onChange` per frame and emits only when the value changed.

- [ ] **Step 1: Write the failing tests** (jsdom, with `resolveColor` injected):
  - `'parseCssColor reads rgb(), rgba() and #rrggbb'`, e.g.
    `parseCssColor('rgb(8, 8, 8)')` → `[8/255, 8/255, 8/255, 1]`.
  - `'readRendererAppearance maps data-piece-outline, constant width, opacity and debug classes'`
  - `'innerOutline is false unless outline is "outline"'`
  - `'observer emits once for several attribute changes in one frame'`
  - `'observer does not emit when nothing changed'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `appearance.ts`. In `bootstrap.ts`, call
  `renderer.setAppearance(readRendererAppearance(...))` once after `init`, and
  register `observeRendererAppearance`. `SvgDomRenderer.setAppearance` is a no-op,
  since CSS already drives it.
- [ ] **Step 4: Run** `fnm exec npm test && fnm exec npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(renderer): appearance input resolved from the page's CSS`

Open the Milestone 1 PR and wait for review before continuing (stacked-PR rule: fix
only the PR under review).

---

## Milestone 2: geometry pipeline, pure and tested (one PR)

### Task 4: Path flattening

**Files:** Create `src/renderer/webgl/path-flatten.ts`, `path-flatten.test.ts`

**Interfaces:**
- Produces: `flattenPath(d: string, tolerance: number): Point[][]`. Returns one
  polyline per subpath, closed loops without a duplicated end point, in
  piece-local units.
- Each curve segment gets `n = clamp(ceil(sqrt(length/tolerance)), 1, 64)` uniform
  `t` steps. `length` is the chord plus control-polygon estimate, which is
  symmetric under reversal. This way a mate edge flattened in reverse gives the
  same points, and fills stay watertight.
- Arcs follow SVG implementation notes F.6.5–F.6.6 (endpoint → centre
  parameterisation, radii scaled up when too small).

- [ ] **Step 1: Write the failing tests:**
  - `'M L Z gives one closed loop without duplicate end'`
  - `'H V and relative commands resolve to absolute points'`
  - `'cubic C endpoints are exact and interior points lie on the curve within tolerance'`
  - `'reversing a cubic yields the same point set'` (the watertight contract)
  - `'S and T reflect the previous control point'`
  - `'A arc: quarter circle r=10 has all points at distance 10±tolerance from centre'`
  - `'A arc with too-small radii scales radii up (F.6.6)'`
  - `'multi-subpath shape gives one loop per M..Z'`
  - `'every shape in a generated Venn puzzle and a fractal puzzle flattens without throwing'`
    (build them with the existing generator entry points used by `dev-hooks.ts`)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(renderer): SVG path flattening for WebGL`

### Task 5: Stroke mesh

**Files:** Create `src/renderer/webgl/stroke-mesh.ts`, `stroke-mesh.test.ts`

**Interfaces:**
- Produces:
  `buildStrokeMesh(polyline: Point[], closed: boolean, interiorSide: 1 | -1): StrokeMesh`,
  where
  `StrokeMesh { centers: Float32Array; normals: Float32Array; sides: Float32Array; indices: Uint32Array }`.
  The shader computes `center + normal * side * halfWidth`, so width and
  constant-width are decided per frame.
- `side` is −1 on the piece interior and +1 outside. The inner outline discards
  `side > 0`.
- Round joins and caps come from extra fan vertices. Normals are unit length.

- [ ] **Step 1: Write the failing tests:**
  - `'straight segment gives a quad whose sides are ±1'`
  - `'interiorSide flips which side is −1'`
  - `'a 90° corner adds round-join fan vertices whose normals sweep the outer angle'`
  - `'open polyline gets round caps at both ends'`
  - `'all normals are unit length'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(renderer): stroke meshes with round joins`

### Task 6: Piece meshes and photo mapping

**Files:**
- Create: `src/renderer/webgl/piece-mesh.ts`, `piece-mesh.test.ts`,
  `src/renderer/webgl/photo-mapping.ts`, `photo-mapping.test.ts`
- Modify: `package.json` (add `earcut` ^3 and its types)

**Interfaces:**
- Consumes: `flattenPath` (Task 4), `buildStrokeMesh` (Task 5).
- Produces:
  ```ts
  export interface PieceMesh {
      pieceId: number;
      fillVertices: Float32Array;   // piece-local xy
      fillIndices: Uint32Array;
      loops: Point[][];             // for hit-testing, even-odd
      bounds: PieceBounds;          // from piece.bounds
      edgeStrokes: Map<number, StrokeMesh>; // edge.id → stroke
  }
  export function buildPieceMesh(piece: Piece, tolerance: number): PieceMesh;
  export function sliceUv(imageSize: Size, photoSize: Size): { scale: Point; offset: Point };
  export function textureSizeFor(photoSize: Size, maxTextureSize: number): Size;
  ```
- Fills: even-odd. Classify loops by containment depth (odd depth = hole) and
  triangulate each outer loop with its direct holes via earcut. This also fixes
  #714's nonzero/even-odd inconsistency on the WebGL side.
- `sliceUv` reproduces `preserveAspectRatio="xMidYMid slice"` for an image element
  of `imageSize` showing a photo of `photoSize`.
- The UV of a piece-local point `p` is
  `((p - imageOffset) / imageSize) * scale + offset`.
- `textureSizeFor` downscales proportionally to fit `maxTextureSize`.

- [ ] **Step 1: Write the failing tests:**
  - `'square piece triangulates to area equal to its polygon area'`
  - `'piece with a hole (Venn) leaves the hole uncovered: triangle area = outer − hole'`
  - `'nested island inside a hole is filled (even-odd)'`
  - `'edgeStrokes has one stroke per edge with interiorSide pointing into the piece'`
  - `'sliceUv: same aspect → identity mapping'`
  - `'sliceUv: photo wider than imageSize crops left and right equally (xMid)'`
  - `'sliceUv: photo taller crops top and bottom equally (YMid)'`
  - `'textureSizeFor keeps aspect and fits 4096'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(renderer): piece fill meshes and photo slice mapping`

### Task 7: Scene model

**Files:** Create `src/renderer/webgl/scene.ts`, `scene.test.ts`

**Interfaces:**
- Consumes: `PieceMesh` (Task 6).
- Produces `class Scene`:
  - `constructor(meshes: PieceMesh[], state: GameState)`
  - `sync(state: GameState): SceneChanges`, with
    `SceneChanges { transforms: boolean; order: boolean; outerEdges: boolean; groupsChanged: number[] }`
  - `bringToFront(groupId: number): void`
  - `setSelected(groupId: number, on: boolean): void`
  - `setDragging(groupId: number, on: boolean): void`
  - `groupState(groupId: number): { selected: boolean; dragging: boolean }`
  - `orderedGroupIds(): readonly number[]` (bottom → top)
  - `pieceTransforms(): Float32Array`: per piece slot, 8 floats:
    `[cos, sin, tx, ty, groupSlot, 0, 0, 0]`, mapping piece-local to world
    (group rotation about the group origin, then group position, with the piece
    offset folded into `tx`/`ty`).
  - `isOuterEdge(edgeId: number): boolean`: true iff the mate piece is in a
    different group, or the edge has no mate.
  - `setRotationOverride(groupId: number, deg: number, pivotLocal: Point | null): void`,
    used by `animateGroupRotation`.
- Z-order semantics are today's:
  - new groups stack in creation order;
  - `bringToFront` moves a group to the top;
  - a merge keeps the surviving group's z-position;
  - the order survives `sync` (`reorderGroupsAfterDrop` keeps calling
    `bringToFront`).
- Selection and dragging live here and survive `sync`, so the
  re-apply-after-render calls become harmless no-ops.

- [ ] **Step 1: Write the failing tests:**
  - `'piece transform maps local (0,0) to group.position + offset for rotation 0'`
  - `'rotation 90 rotates about the group origin'`
  - `'bringToFront moves the group last in orderedGroupIds'`
  - `'merge keeps the surviving group z-position and drops the absorbed group'`
  - `'selection and dragging survive sync after a merge for the surviving group'`
  - `'isOuterEdge is false for edges whose mate joined the same group'`
  - `'sync on unchanged state reports no changes'` (the #717 dirty-tracking contract)
  - `'a Scene built for a new game shares nothing with the previous one'`:
    same piece ids, different shapes → transforms and outer edges come from the
    new meshes (Review Focus 3)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(renderer): CPU scene model for WebGL`

### Task 8: Hit-testing

**Files:** Create `src/renderer/webgl/hit-test.ts`, `hit-test.test.ts`

**Interfaces:**
- Consumes: `Scene` (Task 7), `PieceMesh.loops`.
- Produces:
  `hitTest(scene: Scene, meshes: ReadonlyMap<number, PieceMesh>, screen: Point, viewport: { scale: number; offsetX: number; offsetY: number }): number | null`.
  Topmost group first. Within a group, any piece whose loops contain the point
  (even-odd) after inverting the viewport and the piece transform, with a bounds
  pre-check.

- [ ] **Step 1: Write the failing tests:**
  - `'returns the topmost of two overlapping groups'`
  - `'a point inside a hole returns null'`
  - `'respects viewport scale and offset'`
  - `'respects group rotation'`
  - `'bringToFront changes which overlapping piece is hit'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** `feat(renderer): geometric hit-testing`

Open the Milestone 2 PR.

---

## Milestone 3: WebGL renderer behind `?renderer=webgl` (one PR)

### Task 9: Animation timing

**Files:** Create `src/renderer/webgl/animation.ts`, `animation.test.ts`

**Interfaces:**
- Produces:
  - `cubicBezierEase(x1, y1, x2, y2): (t: number) => number`
  - `EASE_IN_OUT = cubicBezierEase(.42, 0, .58, 1)`
  - `class Tween { constructor(durationMs: number, now: number); progress(now: number): number /* eased 0–1 */; done(now: number): boolean }`

- [ ] **Step 1: Write the failing tests:**
  - `'EASE_IN_OUT(0)=0, (1)=1, (0.5)=0.5'`
  - `'EASE_IN_OUT matches CSS ease-in-out at t=0.25 within 1e-3'` (0.1291)
  - `'Tween progress clamps to 1 after duration'`
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit:** `feat(renderer): easing and tweens`

### Task 10: GL context and shaders

**Files:** Create `src/renderer/webgl/gl-context.ts`, `src/renderer/webgl/shaders.ts` (GL glue; no unit tests)

**Interfaces:**
- Produces:
  - `class WebGLUnsupportedError extends Error { readonly cause: 'no-webgl2' | 'blocked' }`
  - `createGl(canvas: HTMLCanvasElement): WebGL2RenderingContext`. Throws
    `WebGLUnsupportedError`. Its `cause` is `'no-webgl2'` when
    `typeof WebGL2RenderingContext === 'undefined'`, and `'blocked'` when WebGL 2
    exists but `getContext('webgl2')` returned null. Never forward the
    `webglcontextcreationerror` `statusMessage`: in Chrome it carries the GPU's PCI
    vendor and device ids and the driver name, which is device data the app
    doesn't collect without consent.
    Options:
    `{ alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false }`.
  - `onContextLoss(canvas, { lost: () => void; restored: () => void }): () => void`.
    It calls `preventDefault()` on the loss event.
  - `MAIN_VS`, `MAIN_FS`: one program for all three primitive kinds, using a
    per-vertex `kind` attribute (0 fill, 1 stroke, 2 halo quad).
    - Fills sample the photo, or use white when blank, times `pieceOpacity`.
    - Fill edges are not antialiased per piece; that keeps groups seam-free.
    - Strokes do analytic AA from `side` and `halfWidth`.
    - Halos sample the halo atlas.
    - Per-piece transforms come from a `RGBA32F` data texture via `texelFetch`.
  - Halo programs `HALO_SILHOUETTE_FS`, `HALO_BLUR_FS` and `HALO_COMPOSE_FS` are
    used in Task 14.
  - `class ShaderBuildError extends Error { readonly log: string }`, and
    `createProgram(gl, vs, fs): WebGLProgram | null` (null only when the context is lost). It checks `COMPILE_STATUS` for both
    shaders and `LINK_STATUS` for the program, and throws `ShaderBuildError` with
    `getShaderInfoLog` / `getProgramInfoLog`. A rejected shader doesn't throw by
    itself; without this check the player gets a blank table and nothing is
    reported. Every program in Tasks 10 and 14 is built through it. Check
    `gl.isContextLost()` before throwing: while the context is lost the status
    queries return `null`, which is a loss, not a shader failure. Return without
    a program and leave the build to the restore path (Task 11). Otherwise a
    transient loss at startup would lock the player out as `'shader'`.
- The group's outer boundary is antialiased by a 1-screen-px fringe strip along
  outer edges, drawn as part of the fill pass. For `outline` and `shadow` the
  stroke or halo covers it; for `none` it is the only AA.

- [ ] **Step 1:** Implement both files.
- [ ] **Step 2:** `fnm exec npm run build && fnm exec npm run lint`. Expected: PASS.
- [ ] **Step 3: Commit:** `feat(renderer): WebGL2 context and shaders`

### Task 11: `WebGlRenderer`

**Files:**
- Create: `src/renderer/webgl/webgl-renderer.ts`
- Modify: `src/renderer/index.ts` (export it)

**Interfaces:**
- Consumes: Tasks 3–10.
- Produces: `class WebGlRenderer implements Renderer`. Behaviour:
  - **`init`:** creates a canvas inside a `div[data-puzzle-table="true"]`
    (context-menu and classification hooks), sized to the container at
    devicePixelRatio, and resizes on `ResizeObserver`.
  - **`renderState`:** builds meshes on a new game, `scene.sync` otherwise, and
    marks the frame dirty. At most one GL frame per rAF; nothing is drawn when
    clean.
  - **Mesh building:** must not block the first frame beyond the spec budget
    (SVG + ~100 ms on the iPad). Build fills for all pieces first (first frame),
    and strokes and halos in idle chunks afterwards. Use the existing idle-chunk
    helper (`src/app/idle-chunks.ts`) if it fits.
  - **Dirty uploads:**
    - transforms changed → `texSubImage2D` of the transform texture;
    - order or outer edges changed → rebuild the index buffer (concatenate
      per-group ranges: halo, then strokes of outer edges, then fills);
    - **never per-group draw calls.**
  - **Outlines:**
    - `outline` → strokes 3 units wide under the fills;
    - `innerOutline` → strokes above the fills with `side > 0` discarded;
    - `constantWidth` → width in screen px (3 / scale world units), applied
      continuously, including mid-pinch (spec decision 4);
    - `none` → no strokes.
  - **Photo:** loads with `crossOrigin = 'anonymous'`. `prefetchPhoto` uses the
    same mode. Downscales via `textureSizeFor` using `MAX_TEXTURE_SIZE`. Mipmaps
    with `LINEAR_MIPMAP_LINEAR`. `photoSettled` keeps today's semantics:
    `'loaded' | 'failed'`, reset when the photo URL changes.
  - **Pointer queries:** `pieceIdAtPoint` uses `hitTest`.
    `setViewportMoving` is a no-op.
  - **Animations:** `transitionViewport` and `animateGroupRotation` use `Tween`.
    Each also has a `setTimeout(VIEWPORT_TRANSITION_MS + 200)` guard that applies
    the final value and resolves if rAF never ran (Review Focus 4). Cancel rules:
    - a `setViewportTransform` call during a viewport tween cancels the tween,
      applies the new transform and resolves the tween's promise. A CSS
      transition retargets to the latest transform by itself; a tween that
      writes every frame would otherwise override a pinch or wheel in the 0.8 s
      after the last piece snaps;
    - installing a new game (`renderState` with a new piece set) cancels any
      rotation override and resolves its promise. Group ids restart at 0, so a
      leftover override would spin a group in the new game.

    Write the tests next to the renderer's pure parts (e.g. a small
    `TransitionController` in `animation.ts` with the cancel logic):
    `'setViewportTransform during a viewport tween cancels it and resolves its promise'`
    and `'a new game cancels the rotation override and resolves its promise'`.
  - **Context loss:** stop drawing and keep `Scene`. On restore, rebuild all GL
    resources from the scene and meshes, then redraw. Report every phase through
    one callback passed to the constructor,
    `onContextEvent(phase: 'lost' | 'restored' | 'gave-up')`:
    - `'lost'` immediately in the loss handler;
    - `'restored'` when the context comes back within 5 s;
    - `'gave-up'` when it doesn't.
    
    The caller (Task 12) acts on this one callback, so the message and the
    analytics events can't disagree. Reporting `'lost'` at once means a tab that
    is closed or suspended within those 5 s is still counted.
  - **`setAppearance`:** stores the appearance and marks dirty. Background colour
    → clear colour.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Verify in Chromium.** Start the dev server
  (`fnm exec npx vite --host`) and use the Playwright MCP tools. Open
  `/?renderer=webgl` once Task 12 lands; until then use a temporary local
  harness page that is not committed.
  - The 192-piece puzzle renders with the photo correctly mapped.
  - Drag, pan and pinch work.
  - Outline, None, inner outline and constant width all work.
  - A rotated group renders and hit-tests correctly.
  - The completion zoom and spin animate.
  - `__startVennPuzzle()` shows see-through, ungrabbable holes.
  - Close the browser and stop the server afterwards.
- [ ] **Step 3:** `fnm exec npm test && fnm exec npm run lint && fnm exec npm run build`.
  Expected: PASS.
- [ ] **Step 4: Commit:** `feat(renderer): WebGL renderer`

### Task 12: Dev flag, unsupported and context-lost messages

**Files:**
- Modify: `src/app/bootstrap.ts:96`, `src/analytics/umami.ts` (+ its test)
- Create: `src/ui/renderer-failure.ts`, `renderer-failure.test.ts`
- Test: `src/app/bootstrap.test.ts`

**Interfaces:**
- Produces: `chooseRenderer(search: string): 'svg' | 'webgl'`. Returns `'webgl'`
  iff `new URLSearchParams(search).get('renderer') === 'webgl'`. It is not
  persisted.
- Produces:
  `showRendererFailure(container: HTMLElement, kind: 'unsupported' | 'lost'): void`.
  Exact copy:
  - unsupported: **"Puzzlewise needs WebGL 2, which this browser doesn't support."**
  - lost: **"Graphics stopped working."** plus a **Reload** button that calls
    `location.reload()`.
- Produces two analytics events, documented in `src/analytics/umami.ts`'s
  query-spec comments like the existing failure events (`new-game-failed`,
  `save-failed`). Once SVG is gone there is no fallback, so these are the only
  record of players who are locked out or lose the canvas:
  - `renderer-failed { kind: 'no-webgl2' | 'blocked' | 'shader' | 'lost' }`, sent
    from wherever `showRendererFailure` is called. `bootstrap` catches
    `WebGLUnsupportedError` (kind = its `cause`) and `ShaderBuildError`
    (kind `'shader'`) from Task 10 and shows the unsupported message for all
    three. That keeps them away from the `unhandled-error` backstop, so the event
    is the only signal. Deliberately no free-text reason: browser and driver
    messages can carry hardware identifiers (see `createGl`). The catch also
    logs the error with `console.error`, including `ShaderBuildError.log`, as
    `runWithErrorReport` does for `logInProduction` callers
    (`src/app/run-with-error-report.ts`). Nothing leaves the browser, but the
    compiler message is then one console glance away.
  - `renderer-context-lost { pieceCount: number; visibilityState: DocumentVisibilityState }`,
    sent on `onContextEvent('lost')` (Task 11) for every loss, as it happens.
    That shows whether losses cluster on big games or hidden tabs. On
    `'gave-up'` the caller shows the "lost" message and sends
    `renderer-failed { kind: 'lost' }`. The share of losses that never recover is
    the ratio of the two events.

- [ ] **Step 1: Write the failing tests:**
  - `'chooseRenderer defaults to svg'`
  - `'chooseRenderer honours ?renderer=webgl'`
  - `'showRendererFailure unsupported renders the exact copy'`
  - `'showRendererFailure lost renders a Reload button'`
  - `bootstrap.test.ts`: `'webgl init throwing WebGLUnsupportedError shows the unsupported message and does not boot the game'`
  - `bootstrap.test.ts`: `'an unsupported WebGL tracks renderer-failed with its cause as kind'`,
    run for `no-webgl2` and `blocked`
  - `bootstrap.test.ts`: `'a ShaderBuildError at init shows the unsupported message, tracks renderer-failed with kind shader and console.errors its log'`
  - `bootstrap.test.ts`: `'onContextEvent lost tracks renderer-context-lost with pieceCount and visibilityState'`
  - `bootstrap.test.ts`: `'onContextEvent gave-up shows the lost message and tracks renderer-failed with kind lost'`
  - `bootstrap.test.ts`: `'onContextEvent restored shows nothing and tracks nothing'`
  - `gl-context.test.ts` (jsdom, `getContext` stubbed): `'createGl reports no-webgl2 without WebGL2RenderingContext and blocked when getContext returns null'`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify on the iPad** with a production build served on the LAN.
  The iPad can't load the Vite dev server: use `vite preview --host`, and the
  `spike/render-perf/probe/wk.mjs` client to drive Safari.
  - Play a 192-piece game with `?renderer=webgl`.
  - Force a loss with
    `gl.getExtension('WEBGL_lose_context').loseContext()`, then `restoreContext()`
    after 1 s. Expect the same pieces, selection and z-order (Review Focus 5).
  - Navigate Safari back to `https://puzzlewise.github.io/dev/` afterwards.
- [ ] **Step 5:** `fnm exec npm test`. Expected: PASS.
- [ ] **Step 6: Commit:** `feat(app): ?renderer=webgl dev flag and renderer failure messages`

Open the Milestone 3 PR. Its `/dev/` preview lets the owner try real games with
`?renderer=webgl`.

---

## Milestone 4: Full effects in WebGL (one PR)

### Task 13: Halo recipe

**Files:** Create `src/renderer/webgl/halo-recipe.ts`, `halo-recipe.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HaloState = 'idle' | 'selected' | 'dragging' | 'selected-dragging';
  export interface HaloStep { sigma: number; color: Rgba; alpha: number } // sigma in world units
  export function haloSteps(state: HaloState, outline: RendererAppearance['outline'], glow: Rgba): readonly HaloStep[];
  export function gaussianKernel(sigma: number, texelsPerUnit: number): Float32Array; // normalised, radius ceil(3σ)
  export function haloMargin(steps: readonly HaloStep[]): number; // world units = max cumulative 3σ
  ```
- `haloSteps` gives the CSS chains from Global Constraints, in order:
  - the Shadow preset prefix (σ 2, black, 0.35) first, where it applies;
  - dragging: σ 6, black, 0.45;
  - selected: σ 3 / 7 / 12 in the glow colour at 0.9 / 0.7 / 0.4;
  - `idle` with outline ≠ `shadow` → `[]`.

- [ ] **Step 1: Write the failing tests:**
  - `'idle with outline preset has no halo'`
  - `'idle with shadow preset is one σ2 black 0.35 step'`
  - `'selected-dragging is drag shadow then three glows, in order'`
  - `'shadow preset prefixes every non-empty chain'`
  - `'gaussianKernel sums to 1 and is symmetric'`
  - `'haloMargin covers the widest chain'`
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit:** `feat(renderer): halo recipes matching CSS drop-shadow chains`

### Task 14: Halo atlas and compositing

**Files:**
- Create: `src/renderer/webgl/halo-gl.ts` (GL glue)
- Modify: `webgl-renderer.ts`, `shaders.ts`

**Interfaces:**
- Consumes: `haloSteps`, `gaussianKernel` and `haloMargin` (Task 13), `Scene` (Task 7).
- Produces: `class HaloAtlas`:
  - `request(groupId: number, state: HaloState, key: string): AtlasRect | null`,
    where `AtlasRect { layer: number; x: number; y: number; w: number; h: number }`
    in texels.
    Returns null while the halo is not built yet. `key` covers the group's
    piece set, the outline preset and the glow colour.
  - `buildPending(budgetMs: number): void`
  - `release(groupId: number): void`
  - `dispose(): void`
- **Building a halo:** render the group silhouette (fills, plus the 3-unit outline
  stroke when the preset is `outline`, since CSS shadows the whole silhouette) in
  group-local space. **Resolution per halo:** `texelsPerUnit = min(1, 1.5 / σmin)`,
  where `σmin` is the smallest σ in that halo's chain, so the smallest blur still
  spans 1.5 texels. Skip the Shadow preset's σ 2 prefix when other steps follow
  it. Otherwise every Shadow chain would be pinned at 1 texel per unit, and the
  prefix still spans 1 texel at the selected chains' resolution. Selected or
  selected-dragging chains (σmin 3) get 0.5 texel per unit, dragging alone (σ 6)
  0.25, and the Shadow preset's idle halo (σ 2 alone) 0.75. If the Task 14
  screenshots show the glow visibly softer than CSS, bring that to the owner
  rather than raising the density on your own: memory is the binding
  constraint. Then for each step:
  1. separable Gaussian with that step's σ on the current alpha;
  2. tint it with the step colour × alpha;
  3. composite under the running image, matching the CSS chain;
  4. continue from the composite's alpha.
  Store the premultiplied RGBA result in an atlas region with an 8-texel gutter.
  The atlas is a single RGBA8 `TEXTURE_2D_ARRAY` with 2048 × 2048 layers, so the
  main draw binds it once, with mipmaps (`LINEAR_MIPMAP_LINEAR` for zoomed-out
  views).
- **Atlas slots:** when a game is installed, give each group one slot sized for
  the largest of its halo states at the resolutions above. That is not always
  selected and dragging: under Shadow, a large group's idle halo at 0.75 texels
  per unit can be the bigger one. Size the scratch region and the blur targets
  at install for the largest halo the whole puzzle can produce, i.e. the
  completed puzzle as one group, and count them in the Memory figure. Every
  merged group's halo is built there. Build every halo in the
  scratch region and copy it into the group's slot when it's complete
  (`copyTexSubImage3D`). The old halo stays drawn until that copy. This way the
  select-all → dragging switch, where 192 old halos must stay visible while 192
  larger ones are built, never needs extra space, and the atlas never
  reallocates mid-game. Drag start is one of the moments that must not hitch.
  On a merge, the absorbed groups' slots are freed and the merged group takes a
  new slot from free space. If the packer can't fit it, repack the atlas over
  several frames inside the `buildPending` budget, keeping old halos drawn.
- **Mip levels:** never call `generateMipmap` on the atlas. It rebuilds every
  level of every layer and can't update one region. After building a halo,
  downsample just that region into each mip level with a small box-filter pass
  (the gutter keeps neighbours from bleeding in), counted inside the
  `buildPending` budget.
- **Compositing:** each group's halo is a quad in group-local space, in the same
  index buffer, just below that group's strokes and fills. It is drawn in the
  same draw call and samples the atlas.
- **On a merge or a state change:** keep drawing the previous halo until the new
  one is built. `buildPending` runs with a 4 ms budget per frame, so no frame
  exceeds 50 ms (spec).
- **Memory:** the atlas must stay bounded. Free regions when groups merge or leave
  the state. Target: the whole atlas, counted in allocated 2048² layers with mip
  levels (~21 MiB per layer) plus the scratch region and blur targets, is
  ≤ 64 MB, i.e. at most 2 layers plus buffers. It must hold for every outline
  preset and for the largest shipped case: a 192-piece **portrait** game
  (1080 × 1614 photo, `src/app/bundled-image.ts`). Portrait Fractal pieces
  average ~158 × 160 units, against 87 × 81 for the landscape fixture. A
  review computed portrait Fractal under Shadow at ~35 MiB with perfect packing,
  which fits 2 layers. At the earlier 0.67 texels per unit it needed 4 layers
  (85 MiB).
- **Check when built:** the iPad's per-draw-state lesson must still hold. The main
  draw stays one call, and the offscreen passes happen only while building.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Parity check in Chromium.** Use Playwright to screenshot
  `?renderer=webgl` against default SVG at identical state and viewport. Cases:
  - a selected group;
  - a dragging group;
  - selected and dragging;
  - the Shadow preset idle;
  - zoom 0.3 and zoom 2.

  Save the pairs under `spike/render-perf/parity/` (local) and compute per-pixel
  difference. Identical is the working target. If it stalls, keep the closest
  result and bring the image pairs to the owner (Global Constraints, visual
  target).
- [ ] **Step 3:** `fnm exec npm test && fnm exec npm run lint && fnm exec npm run build`.
  Expected: PASS.
- [ ] **Step 4: Commit:** `feat(renderer): WebGL shadows and selection glow`

Open the Milestone 4 PR. Include the parity image pairs as attachments or links
in the PR description.

---

## Milestone 5: debug views (one PR)

### Task 15: Debug pieces, mateless edges, opacity

**Files:**
- Create: `src/renderer/webgl/debug-overlay.ts`, `debug-overlay.test.ts`
- Modify: `webgl-renderer.ts`, `shaders.ts`

**Interfaces:**
- **Mateless edges:** stroke meshes of `mateEdgeId === -1` edges, `#FF69B4`,
  2 units wide, drawn above fills in the main draw when
  `appearance.matelessEdges`.
- **Debug pieces:** fills become white, with a 1-unit black stroke on every piece
  edge. The photo is hidden.
- **Labels and triangles:**
  `createDebugOverlay(container: HTMLElement): { update(scene: Scene, meshes, viewport): void; setVisible(on: boolean): void; destroy(): void }`.
  It positions one absolutely-placed element per piece with a CSS transform
  (viewport ∘ group ∘ piece):
  - the piece id in `14px ui-monospace, Menlo, monospace`, black, centred on the
    piece bounds;
  - a black up-triangle with half-width 5 and height 7, tip at `minY + 4`,
    rotating with the group.
- **Opacity:** `pieceOpacity` multiplies fill alpha only, not strokes or halos.

- [ ] **Step 1: Write the failing tests** (jsdom):
  - `'overlay creates one label per piece showing its id'`
  - `'overlay transform combines viewport, group rotation and piece offset'`
  - `'setVisible(false) hides the overlay'`
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Verify in Chromium** with the debug toggles in Settings › Debug
  against SVG. Screenshot pairs go into `spike/render-perf/parity/`.
- [ ] **Step 6: Commit:** `feat(renderer): WebGL debug views`

Open the Milestone 5 PR.

---

## Milestone 6: gate measurements and owner sign-off (no product code)

### Task 16: Measure on devices, then parity matrix

**Files:** local only, under `spike/render-perf/` (gitignored):
- `web/harness.ts`: add `renderer=webgl-src`, which imports
  `src/renderer/webgl/webgl-renderer.ts` and drives it through the existing motion
  script and scenarios.
- `probe/` scripts as needed.
- Append the results to `RESULTS.md`.

- [ ] **Step 1: iPad 6th gen** (`variant.mjs`, xctrace CA fps, plus Activity
  Monitor memory with `MEM=1`). Compare against the spec targets:
  - scripted motion;
  - select-all Full with 82 groups;
  - select-all Full with 192 separate groups (`scenario=selectAll&groups=192` or
    equivalent);
  - select-all Full with 192 separate groups under the **Shadow** preset, on a
    192-piece **portrait Fractal** game: the largest shipped atlas case. Report
    allocated layers as well as process memory;
  - Shadow preset, zoomed-out pan;
  - first-frame time against SVG;
  - worst frame at merge, drag start and completion zoom (in-page long-frame
    observer cross-checked with CA).
- [ ] **Step 2: Pixel 9a** (adb + CDP traces). First measure SVG's displayed rate
  per scenario. Then measure WebGL against that rate. Run the bug regressions:
  #680, #735, #725, flicker while dragging at heavy zoom, missing tiles during the
  completion zoom, and the drag-start hitch with a big selection.
- [ ] **Step 3: Gate decision.** If any target is missed, stop and report to the
  owner with the numbers. This includes the 192-group case: below 57 fps it goes
  to the owner (spec decision 2), and Simple is not reintroduced.
- [ ] **Step 4: Parity matrix** (Chromium and iPad, SVG vs WebGL pairs):
  - each outline preset, with and without inner outline;
  - constant width;
  - selected, dragging, and both;
  - blank puzzle;
  - Venn holes;
  - borderless fractal and wavy;
  - rotated groups;
  - dark OS theme;
  - the debug views;
  - #711 seams, as a pixel diff along shared edges. Include one in-progress save
    created before 2026-10-31 (before `alignMatePaths`): its mate edges can
    differ by up to 0.014 units, while current puzzles' mates agree to ~3e-13.
- [ ] **Step 5: Owner sign-off.** Present the numbers and image pairs. Milestone 7
  starts only after the owner approves.

---

## Milestone 7: switch and delete (one PR, after sign-off)

### Task 17: WebGL by default; delete SVG and its workarounds

**Files:**
- Delete:
  - `src/renderer/svg-dom-renderer.ts`, `svg-dom-renderer.test.ts`
  - `src/renderer/group-outline.ts` (+test), `src/renderer/translate-path.ts` (+test)
    unless WebGL code imports them
- Modify:
  - `src/renderer/types.ts`: remove `setViewportMoving`, `setRingsEnabled`,
    `setInnerOutlineEnabled`.
  - `src/renderer/index.ts`: remove `applyGroupTransform` and `VIEWPORT_TRANSITION`.
  - `src/interaction/setup-interaction.ts`: remove the viewport-motion set.
  - `src/app/bootstrap.ts`: remove `chooseRenderer`, the flag and
    `syncInnerOutline`.
  - `src/style.css`: delete the renderer rules (rings, underlay, seam fill,
    `.dragging`/`.selected` filters, `will-change`, relayer,
    `data-viewport-moving`, `[data-piece-id]` and `[data-piece-blank]` rules). Keep
    `--selection-glow`, `--piece-outline-color` and `--puzzle-bg-color`; the
    appearance resolver reads them.
  - `src/style.test.ts`: delete the renderer-CSS tests. Add
    `'the colour variables the WebGL appearance resolver reads are still defined'`.
  - `src/app/bootstrap.test.ts`: replace the `SvgDomRenderer.prototype` spies with
    `WebGlRenderer` ones, mocking `createGl`.
  - `src/test-helpers/fake-renderer.ts`.
  - `src/ui/piece-outline.ts` (+ its test): remove the presets' `filter` and
    `idleFilter` fields, the two exported property names
    (`--piece-edge-filter`, `--piece-edge-idle-filter`) and the two
    `setProperty` calls in `applyPieceOutline`. Once the `.dragging`/`.selected`
    filter rules are gone nothing reads them, and the Shadow look would
    otherwise be defined twice: once as a dead `drop-shadow(...)` string, and
    once live in `halo-recipe.ts`.
  - `src/app/start-renderer.ts`, the renderer's `ContextLossMonitor` and
    `src/analytics/umami.ts` (+ tests): before WebGL becomes the default, make
    the 5 s restore cut-off (`CONTEXT_RESTORE_TIMEOUT_MS`) judgeable from data.
    Send `renderer-context-restored { latencyMs }` on an in-time restore, and
    `renderer-context-restored { latencyMs, late: true }` once for a restore
    that arrives after the give-up (still ignored for drawing). Without these,
    tabs closed inside the window look like recoveries, and a message shown for
    a context the browser was about to return goes unnoticed. While WebGL is
    behind the dev flag almost nobody would send these, so they wait for the
    switch.
  - Same files plus `WebGlRendererOptions`: an `onHalosUnavailable(kind)`
    option, and one `renderer-degraded { kind: 'halo-shader' | 'halo-atlas' }`
    event per page load (no free text). After the switch, a GPU family whose
    driver rejects a halo shader, or a puzzle too big for the atlas, would
    otherwise silently lose selection glow and drag shadows, with nothing in
    analytics: the failure is caught and only logged to the console.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `fnm exec npm test && fnm exec npm run lint && fnm exec npm run build`.
  Expected: PASS.
- [ ] **Step 3:** Repeat the Chromium smoke check from Task 11 Step 2 without the
  flag.
- [ ] **Step 4: Commit:** `feat(renderer): switch to WebGL and delete the SVG renderer`

### Task 18: Remove Simple effects and the Effects setting

**Files:**
- Delete: `src/ui/effects.ts` (+test)
- Modify:
  - `src/ui/settings-modal.ts:29-33,49,63,71,213-231,337,356`: remove the Effects
    setting and `onEffectsChanged`.
  - `src/ui/help-modal.ts:88`: copy becomes
    `'Snap distance, piece outlines and more'`.
  - `src/analytics/umami.ts`: remove `EffectsResolvedData`, the
    `effects-resolved` overload and the `setting: 'effects'` variant (around
    lines 16, 467–490, 1895). Keep the doc comments of what remains accurate
    (`CLAUDE.md`).
  - `src/app/bootstrap.ts`: remove `setEffects` and `reportEffectsResolved`.
  - The settings, help and analytics tests that reference them.
- Leave the stored `puzzle-effects` localStorage value alone. Nothing reads it any
  more.

- [ ] **Step 1: Write the failing tests:**
  - `settings-modal.test.ts`: `'settings modal has no Effects setting'`
  - `help-modal.test.ts`: `'settings button copy omits effects'`
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** `fnm exec npm test && fnm exec npm run lint && fnm exec npm run build`.
  Expected: PASS.
- [ ] **Step 6: Commit:** `feat(settings): remove the Effects setting now that every device gets Full`

Open the Milestone 7 PR. After merge, close #688 and draft PR #693 as moot, and
#714 as resolved by even-odd triangulation, with a short comment linking the PR.
Ask the owner before closing anything.
