# WebGL renderer replacing the SVG DOM renderer

Background: the 2026-11-11 render-performance spike (`spike/render-perf/`, gitignored;
`RESULTS.md` there has every measurement). Rendering bugs this removes: #680, #725,
#735, #688 (open), #687, #703, plus the residuals listed under Acceptance checks.

## Intent

The SVG DOM renderer gets its speed from the browser's compositor (one layer per
group, `will-change` juggling, CSS filters), and most rendering bugs since October
come from that compositor running out of tiles or GPU memory: pieces vanish,
interactions lag, and memory balloons. Selecting everything under Full effects
peaks around 850 MB in Safari on a 2 GB iPad. Each fix has been a workaround
that moves the problem somewhere else.

The spike showed that a WebGL renderer which draws the whole table in **one draw
call per frame** holds 59–60 displayed fps on the iPad 6th gen, the same as native
Metal. That held for pan, zoom, drags, and select-all with glow and shadow, at
about a third of SVG's memory. The owner tried it by hand on the iPad and wants it.
The goal is to keep a single web codebase instead of writing native apps.

What success looks like, in the owner's words: the app is fast and smooth, pieces
never disappear, and no interaction lags, especially on a Pixel 9a or better.
Otherwise the app looks, feels and works the same as today.

## Goals

- A WebGL2 renderer that implements the `Renderer` port and draws everything the
  SVG renderer draws today, at visual parity (see the parity checklist).
- 60 displayed fps on the reference devices for the scenarios under Performance
  targets, and bounded memory.
- Delete the SVG renderer and every SVG/compositor-specific workaround once WebGL is
  at parity.
- Remove the Simple effects level and the Effects setting: every device gets the
  Full look.

## Non-goals

- New visuals or new features. Anything a player would notice as different, apart
  from smoothness and the absence of bugs, is out of scope.
- Changing puzzle generation, the model, persistence or share links. The renderer
  reads `GameState` and must not touch the seeded-PRNG or geometry contracts
  (`CLAUDE.md`).
- A native app or app-store packaging.
- Keeping SVG as a fallback after the switch.

## Anti-goals

- Anything that feels or works differently from today, or looks worse. The
  spike's approximated shadow and glow were "pretty ugly" in the owner's words,
  which is the kind of result this rules out.
- Fast on average but still hitching in the moments that used to break: drag start
  with a big selection, the completion zoom, dismissing the completion overlay.
- A blank or frozen canvas after the GPU drops the WebGL context.

## Decisions made with the owner

1. **WebGL replaces SVG, and the SVG renderer is deleted** once WebGL is at parity.
   There is no runtime fallback to SVG.
2. **Full effects only.** The Simple level (rings), the Effects setting, the
   automatic device detection, and `setRingsEnabled` go away. This decision depends
   on the performance gate: if true soft shadows and glow cannot reach the targets
   on the iPad 6th gen, stop and bring it back to the owner. Do not quietly keep
   Simple.
3. **Visual target.**
   - Pixel-identical to today is a working target, not the real one: it is
     easy to measure.
   - The real target is "same or better".
   - The minimum acceptable is "not quite the same but still looks good". Only
     the owner can judge that, from side-by-side screenshots.
   - So when identical proves hard (most likely for the Gaussian shadow and glow),
     keep the work, and bring the closest result and the comparison images to the
     owner. Don't throw it away or keep iterating blindly.
   - The spike's straight-edge distance-field shadow and glow fall below the
     minimum.
4. **Constant-width outlines follow the zoom continuously during a pinch,**
   instead of snapping back after the zoom settles as today. The owner confirmed
   this as an improvement; it is the one intended visible change.

## Calls made in this design (not discussed with the owner; flag if wrong)

- **WebGL2 is required.** Without it, the app shows a plain "this browser isn't
  supported" message instead of the table. All target browsers support WebGL2
  (Safari on iOS 15+, any current Chromium).
- **Context loss is recoverable.** On `webglcontextlost`: prevent the default,
  keep all model state, and rebuild GPU resources on `webglcontextrestored`. If
  restore never comes, show a message offering a reload. The spike saw context
  failure once on the iPad after heavy use.
- **Frame rate follows the display, not a fixed 60.** The Pixel 9a's screen runs
  at up to 120 Hz, and Chromium may already pan and zoom SVG at that rate through
  its compositor. Under the anti-goal, WebGL must not fall below what SVG achieves
  today on any device. On the Pixel 9a, measure SVG's current displayed rate per
  scenario first, and set that (up to the display's refresh rate) as the
  pass/fail target. The per-frame budget there may be 8.3 ms, not 16.7 ms.
- **Load and merge must feel the same as today.**
  - Resuming a game or starting a new one may delay the first painted frame by at
    most about 100 ms more than SVG on the iPad 6th gen, measured with the 192-piece
    fixture.
  - A merge may not produce a frame over 50 ms, including snapping onto a 111-piece
    group (#725's case).
  - Expensive preparation (triangulation, blurred silhouettes) therefore cannot all
    run synchronously before the first frame or inside the merge frame. The
    builder picks the structure: a worker, lazy or idle-time work, or keeping the
    old glow on screen until the new one is ready. The spike spent ~590 ms on
    geometry and ~380 ms on its cheaper glow at load on the iPad.
- **Delivery through a dev flag.** Build the renderer in `src/renderer/` behind a
  dev-only switch (e.g. `?renderer=webgl`, not persisted) so the owner can try it
  on `/dev/` previews with real games. Make it the default and delete SVG in a final
  step, after the parity screenshots and device measurements pass.

## Constraints

**Reference devices and how to measure.** Measure on real devices, never by rAF
(on the iPad, rAF said 60 while the display showed 13 and 50 in two separate cases):

- **iPad 6th gen** (A10, 2 GB, iPadOS 17.7, Safari, 60 Hz): xctrace "Core Animation
  FPS" over USB, with the harness approach from `spike/render-perf/probe/`
  (`variant.mjs`, `cafps.py`, `wk.mjs`). Memory comes from xctrace Activity Monitor.
- **Pixel 9a** (Brave/Chrome): remote CDP traces over adb (see the
  android-brave-remote-debugging notes in the owner's memory).

**Performance lessons from the spike** (`RESULTS.md`, afternoon section):

- Safari's WebGL cost on this iPad comes from **state changes between draws**
  (switching shader, buffer, texture or blend per group, which goes through the GPU
  process to Metal). It does not come from JS, pixel fill, or canvas presentation.
  The renderer must draw the table in one draw call, or a small constant number,
  with no per-group state changes. Per-group transforms go in a uniform array or
  data texture.
- 4× MSAA costs about 35 fps on the iPad. Antialias edges in the shader instead.
- The 192-separate-groups, all-glowing case ran at 53–58 fps in the spike. It is
  the hardest case and must be measured.

**Geometry.**

- Piece `shape` and edge `path` strings use `M L C A` (elliptical arcs from
  `model/edge-path.ts` and `puzzle/fractal/convert.ts`). `translate-path.ts` also
  accepts `H V S Q T`.
- Pieces can have holes. Fill and hit-testing are even-odd today. The group-outline
  clip is nonzero; #714 notes the inconsistency, and the WebGL renderer should pick
  even-odd for fills and hits.
- Flatten and triangulate at load. The spike used earcut. Cache per piece; geometry
  is immutable after generation. Cache keys must survive piece IDs restarting at 0
  each game (commit 40f5a852 fixed exactly this bug in SVG).

**Photo.**

- Today the photo maps through SVG `preserveAspectRatio="xMidYMid slice"` sized to
  `state.imageSize`. The texture mapping must reproduce that crop exactly, which
  matters for borderless and fractal puzzles.
- Texture uploads need CORS-clean images. Unsplash and the service-worker offline
  stash are CORS-compatible. Share links accept any http(s) or `data:` URL, but the
  CSP limits images to `'self'` and `*.unsplash.com`. `prefetchPhoto` must prefetch
  in the same CORS mode the texture load uses, or the prefetch is wasted.
- Respect `MAX_TEXTURE_SIZE`: downscale photos larger than the device limit.
- `photoSettled()` semantics feed the `puzzle-image-loaded` analytics event.

**Settings that today only reach CSS** must reach the renderer, and the renderer
must redraw when they change:

- outline preset
- outline colour (a palette variable that changes with `prefers-color-scheme`)
- constant width
- inner outline
- selection-glow colour (depends on `data-ui-scheme` and OS theme)
- piece opacity and translucency
- the debug toggles

Resolve colours via `getComputedStyle` and refresh on change, including OS theme
flips.

## Parity checklist

Exact values and code locations are in the inventory below the checklist. All
sizes are world units and scale with zoom, as today.

1. **Piece fill:** photo, or blank white `#ffffff` regardless of theme. No seams or
   hairlines between pieces in a group (#711's measured case: zero wrong pixels
   along shared edges).
2. **Outline presets:**
   - **Outline** (default): a 3-unit round-join stroke on the group's outer edges,
     drawn under the pieces so about 1.5 units shows.
   - **Shadow:** an idle `drop-shadow(0 0 4px rgba(0,0,0,.35))` on every group.
   - **None.**
   - Plus outline colour, constant width, and the inner outline (#722: the inner
     1.5 units drawn above the pieces).
3. **Full effects:**
   - selected groups get three stacked glows of `--selection-glow` (6 units at 90%,
     14 at 70%, 24 at 40%);
   - dragging groups get `drop-shadow(0 0 12px rgba(0,0,0,.45))`;
   - selected and dragging gets the shadow, then the glows;
   - all of it follows the group's full silhouette, including the outline stroke,
     matching CSS `drop-shadow` (a Gaussian whose standard deviation is half the
     radius).
4. **Z-order:** `bringGroupToFront` and `reorderGroupsAfterDrop` semantics, with
   new groups stacking in creation order (#183).
5. **Rotation:** free and quarter-turn, plus the completion spin upright about the
   image centre, with the same 800 ms `ease-in-out` as the completion zoom. Today the
   spin is done in `viewport-fit.ts` directly on the DOM; the renderer must own it.
6. **Viewport:** pan and zoom (scale 0.05–5) and the completion zoom animation,
   `VIEWPORT_TRANSITION_MS` with `cubic-bezier(.42,0,.58,1)`. The renderer must
   signal completion (callback or promise) in place of `transitionend`.
7. **Hit-testing:**
   - topmost group in z-order, even-odd holes not grabbable, and the existing 8 px
     near-miss probe (`interaction/hit-probe.ts`);
   - UI elements above the canvas must still block hits;
   - wheel events need a point;
   - the context-menu suppression in `app/global-handlers.ts` must keep working.
8. **Debug views:**
   - mateless-edge strokes (`#FF69B4`, 2 units);
   - debug piece view (white fill, 1 unit black stroke, the piece id as text at
     14 units in a monospace font, an up-triangle that rotates with the group);
   - piece opacity and translucent pieces.
   Text may use a canvas-2D-generated atlas or an HTML overlay.
9. **Background:** `--puzzle-bg-color` still shows through gaps and around pieces.

Full inventory with file:line references: produced 2026-11-11 during design. If it
isn't at hand, regenerate it by walking `src/renderer/svg-dom-renderer.ts`,
`src/style.css:376–636`, `src/ui/{effects,piece-outline,piece-outline-color,outline-constant-width,background-color,debug-section}.ts`,
and `src/app/viewport-fit.ts`.

## Port changes (`src/renderer/types.ts`)

- **Remove:**
  - `setRingsEnabled` (Simple is gone);
  - `setViewportMoving` (a #735 compositor workaround);
  - `pieceIdFromTarget` (a canvas target carries no id; classify by point);
  - `invalidateGroup` (existed only for the out-of-band DOM spin).
- **Replace:** `enable/disableViewportTransition` with a renderer-owned animated
  viewport transition that reports when it finishes. Add a renderer-owned group
  rotation animation for the completion spin.
- **Add:** an appearance input carrying outline preset, colours, constant width,
  inner outline, opacity and debug flags, replacing the CSS-only path.
- The re-apply-`setGroupSelected`-after-`renderState` pattern in `game-session.ts`,
  `merge-result.ts`, `rotation-ui.ts` and `bootstrap.ts` exists because DOM
  elements get recreated. It can go once selection lives in renderer state that
  survives renders.

## Deleted with the SVG renderer

- `svg-dom-renderer.ts`, `group-outline.ts`, and `translate-path.ts`. Keep any
  geometry helper the WebGL path reuses.
- `applyGroupTransform` and `VIEWPORT_TRANSITION`.
- The renderer CSS in `style.css` (ring, underlay, seam-fill, filter,
  `will-change`, relayer, `data-viewport-moving` rules).
- `ui/effects.ts`, the Effects entry in `ui/settings-modal.ts`, the `puzzle-effects`
  preference, and the `data-effects` attribute.
- The relayer (#680) and #688 / draft PR #693, both moot; close them.
- Tests that assert on SVG DOM or renderer CSS: `svg-dom-renderer.test.ts` (101),
  about 30 in `style.test.ts`, the DOM parts of `viewport-fit.test.ts`, and the
  `SvgDomRenderer.prototype` spies in `bootstrap.test.ts`. Replace them with tests
  of the new renderer's pure parts: geometry flattening and triangulation, hit
  testing, transforms, appearance resolution, the animation timing functions.
- `spike/render-perf/web/harness.ts` imports `SvgDomRenderer`. That's fine:
  `spike/` is gitignored and throwaway.

## Analytics and in-app text

- `effects-resolved` and the effects `setting-changed` values go away. Update
  `src/analytics/umami.ts`'s query-spec doc comments so they stay accurate
  (`CLAUDE.md`).
- Remove the Effects setting's description from the settings modal. Check the
  help modal's How to Play for anything the change makes wrong (`CLAUDE.md`).
- A WebGL-unsupported or context-lost message is new user-visible text. Keep it
  short.

## Performance targets (the gate)

Displayed fps on the iPad 6th gen (60 Hz), with the 192-piece fixture or real
192-piece games. On the Pixel 9a the same scenarios are a pass/fail gate against
SVG's measured rate, as above.

| Scenario | Target |
|---|---|
| The spike's scripted pan/zoom, big-group drag, and single drags | ≥ 59 mean per phase |
| Select all + Full effects, whole selection dragged, 82 groups | ≥ 59 |
| Select all + Full effects, 192 separate groups | ≥ 57 (stretch: 59). If it can't be met, bring it to the owner |
| Shadow outline preset, zoomed-out pan (today about 14 fps on the iPad) | ≥ 59 |
| Drag start with a large selection, completion zoom, overlay dismissal, merges | no frame over 50 ms |
| First painted frame on resume or new game | ≤ SVG's time + ~100 ms |
| Peak WebContent memory, worst case above, iPad | well under SVG's ~850 MB; the spike reached ~280 MB, so aim for ≤ 300 MB |

## Acceptance checks (bug regressions)

Each must be demonstrably absent on the device named:

- #680: pieces cut off after zooming in and out. Brave on Android, and iPad.
- #735: sections vanish after closing the Success overlay or switching tabs.
  Pixel 9a, 192 pieces, zoomed out.
- #725: blinking when snapping onto a large group. iPad.
- Flicker while dragging a large group at heavy zoom (accepted in #682). Android.
- Missing tiles during the completion zoom (the #736 residual). Pixel 9a.
- Hitch at drag start with many pieces selected, and big-selection drag
  sluggishness. Pixel 9a.
- #711: hairline seams inside groups. Pixel diff, Chromium and iPad.
- #183: small groups hidden under larger ones after a drop.
- A new game never shows the previous photo or pieces (40f5a852 / 4672fa3f).

Visual parity is shown by side-by-side screenshots of SVG vs WebGL, taken while
both still exist. The matrix covers:

- each outline preset, with and without inner outline;
- constant width;
- selection, dragging, and selection + dragging;
- blank puzzle;
- a puzzle with holes (`__startVennPuzzle`);
- borderless fractal and wavy;
- rotated groups;
- dark OS theme;
- the debug views.

The owner signs off on these images before SVG is deleted. Differences are
fine if the owner judges them same-or-better or still good-looking (decision 3).

## Left to the builder

- **How the Full shadow and glow are made fast enough while looking right.** A likely
  route is a per-group blurred-silhouette texture cached in group-local space, so
  rotation and translation are free, kept in one atlas so the single draw call
  survives. Re-blur only when the group's shape changes (a merge) or when zoom
  crosses a resolution band. Any approach is fine if it meets the visual target
  (decision 3), the performance targets, and keeps memory bounded.
- Outline and stroke technique: shader-antialiased, round joins and caps, widths in
  world units.
- Triangulation library, flattening tolerance relative to zoom, and buffer layout.
- How hit-testing is structured, as long as it gives the parity behaviour.
- Splitting into PRs. Suggested order: core renderer behind the flag; effects and
  outlines; animations and hit-testing; appearance plumbing and debug views;
  measurements and parity sign-off; switch the default and delete SVG.
- Reusing spike code (`spike/render-perf/web/webgl-renderer.ts`, `halo.ts`). It is
  throwaway quality, so port the ideas, not the code as is.
