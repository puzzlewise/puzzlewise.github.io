# Simple effects for limited devices

Issue: #703 (selection glow). Background: #687, #696 (edge-variant spike), #704.

## Intent

The blurred effects on piece groups look good and run fine on modern phones and
tablets. On an A10 iPad (iPad 6th gen, 2 GB RAM) they are expensive:

- **Selection glow:** three stacked `drop-shadow`s are painted in software. Selecting
  every group took layer memory from about 110 MB to 388–649 MB. Memory pressure is
  what pushes Safari into a conservative compositing mode that lasts for the whole
  web process.
- **Shadow edge preset:** composited drop-shadows on every group give 13 fps
  zoomed-out pans and 35 fps zoomed in.

The owner does not want to make modern devices look worse to help old ones. The
"rings" style from the #696 spike (stacked translucent strokes, no blur) is fast on
the iPad, but it is clearly uglier on high-resolution screens. So limited devices
get rings and everyone else keeps today's look. The app detects which case applies,
and a setting lets the player override the result.

## Goals

- Detect limited devices automatically and draw all group shadows as rings there.
- A Settings entry, **Effects**, with **Auto** (default), **Full** and **Simple**.
- In Simple, no CSS `filter` from these effects ends up on group layers. (The
  None/Outline idle path already uses `filter: none`; see #687.)

## Non-goals

- Making Full cheaper. Full stays exactly as it is today.
- Measuring performance at runtime to decide. rAF timing does not show compositor
  cost on iOS (rAF reported 60 fps while Core Animation displayed 13), so a
  benchmark would mislead.
- Changing the None and Outline edge presets, the merge pulse, or anything else that
  isn't a shadow or glow.

## Anti-goals

- Any visible or performance change for Full users. On a modern device with
  Auto, the app must look and perform exactly as it does today.
- Relying on a single unreliable signal, such as treating every touch device as
  limited.

## Decisions made with the owner

1. **Detection cutoff:** iOS/iPadOS **18 or lower** counts as limited. Every A10
   iPad stops at iPadOS 17 (6th gen) or 18 (7th gen). iPadOS 26 requires A12 or
   newer. False positives (a newer device that never updated past 18, iPhone
   XS/XR) are acceptable: they get Simple, nothing breaks, and the setting
   overrides it.
2. **Android:** Chromium's `navigator.deviceMemory` of **2 or less** counts as
   limited.
3. **Override setting:** Auto / Full / Simple, saved like the other preferences.
4. **Scope of Simple:** all group shadows: the Shadow edge preset, the drag lift
   shadow, the selection glow, and the completion glow.
5. **Look of the Simple selection glow:** anything that makes the selection obvious
   on any background is acceptable, whether stepped violet rings or a solid border.
   Start with violet rings (see below).

## Detection

A pure function takes
`{ userAgent, maxTouchPoints, deviceMemory, hasWebKit26Features }` and returns
`'simple' | 'full'`. It is unit tested with fixtures. The caller computes
`hasWebKit26Features` with `CSS.supports`.

**Apple touch devices** are detected by the UA. Either it contains `iPhone`, `iPad`
or `iPod`, or it is a Mac UA with `maxTouchPoints > 1`. iPad Safari reports a Mac
UA, and a real Mac reports 0 touch points, so it resolves to Full.

**On Apple touch devices the version comes from a feature check, not the UA.**
Every browser, home-screen web app and in-app web view on iOS runs the system
WebKit, so WebKit's features track the OS version. The UA does not:

- Safari 26 freezes the OS token at 18.x (`OS 18_6 like Mac OS X`, later `18_7`).
- Chrome on iOS has no `Version/` token.
- Home-screen apps and in-app web views may have neither.

`contrast-color()`, Scroll-driven Animations and CSS Anchor Positioning are all
listed as "Added support" in the Safari 26.0 release notes and appear in no 18.x
release notes. So:

- `hasWebKit26Features` = `CSS.supports('color', 'contrast-color(red)') || CSS.supports('animation-timeline', 'scroll()')`.
- **Apple touch device without WebKit 26 features → Simple**, which means iOS/iPadOS
  18 or lower.

The owner's iPad 6th gen (iPadOS 17.7) reports:
`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.14 Safari/605.1.15`,
`maxTouchPoints` 5, no `deviceMemory`. This must resolve to Simple, as a Safari tab
and as a home-screen app.

Everything else: limited if `deviceMemory` is a number ≤ 2, otherwise Full.

Auto is resolved once, at startup. Detection inputs don't change during a
session.

Sources for the version facts:

- iPadOS 18 support: MacRumors and AppleInsider, 2024-06-10.
- iPadOS 26 support: Neowin.
- The frozen OS token: WebKit bug 298260.
- The WebKit 26 features: Apple's Safari 26.0 and 18.1–18.6 release notes.

## Setting

- Label **Effects**. Options **Auto**, **Full** and **Simple**, using the same
  `preset-option` button row as Snap distance and Piece outline. Placed right after
  Piece outline.
- The setting's description explains that Simple swaps soft shadows and the
  selection glow for plainer ones that are lighter on older devices.
- The Auto option shows what it resolved to on this device, e.g. "Auto (Simple on
  this device)" in its label or description, so the player and the owner can see
  what detection decided.
- Persisted with `createIdPreferenceStore` under a new key, default `auto`.
- Changing it takes effect immediately, without a reload.
- Tracked with `trackSettingChange` (`setting: 'effects'`, string from/to). This
  needs adding to `SettingChangedData` in `src/analytics/umami.ts`. No other new
  analytics.

## Rendering

Applied as a document-level attribute, e.g. `data-effects="simple"` on
`documentElement`. CSS keys off it. When the attribute is absent, today's CSS
applies unchanged, which guarantees Full is untouched.

Rings are drawn in the existing per-group SVG underlay
(`SvgDomRenderer.syncOutlineUnderlay`, `src/renderer/svg-dom-renderer.ts`). It
already holds each piece's boundary-edge path (edges shared with a groupmate are
left out) beneath the pieces, which cover the inner half of any stroke. In
Simple:

| Effect | When shown | Rings | Replaces |
|---|---|---|---|
| Edge shadow | edge preset is Shadow, always | dark, faint (spike used `rgba(0,0,0,0.12)`, widths 12/8/4 px) | `--piece-edge-filter` / idle filter `drop-shadow` |
| Lift shadow | `.dragging` | dark, a bit stronger than the edge shadow | the `drop-shadow(0 0 12px …)` in `.dragging` / `.selected.dragging` |
| Selection glow | `.selected` | `--selection-glow` violet, strongest innermost | the three glow `drop-shadow`s |
| Completion glow | `.completion-glow` on the container (`src/ui/completion-overlay.ts`) | `--color-amber-default` amber, plus a faint dark ring; offsetting the dark ring 2 px down to echo `0 2px 4px` is optional | `.completion-glow [data-group-id]`'s two `drop-shadow`s and its 1 s `filter` transition |

Requirements:

- **No seam artifacts.** Each piece is its own path, so translucent strokes from
  neighboring pieces overlap where their edges meet and leave darker or brighter
  spots along the group outline. The spike's 12%-black rings hid this; a violet glow
  at 40–90% would not. Draw each ring with an opaque stroke inside a `<g>` that
  carries the ring's opacity, so the overlap is flattened. That opacity is applied
  when the group repaints, not on every frame.
- **Layering:** the Outline preset's stroke sits above all rings. Selection rings sit
  above lift rings when a selected group is dragged.
- **Hidden rings must not grow the layer.** Ring groups that aren't shown use
  `display: none`, so idle groups don't pay layer memory for them.
- **Group filters in Simple:** the Shadow preset's filter variables resolve to the
  no-op values the None/Outline path uses (idle `none`, state `opacity(1)`).
  `.selected`, `.dragging` and `.selected.dragging` must not add a `drop-shadow`.
  The merge pulse keyframes keep working, since they compose onto
  `--piece-edge-filter`.
- **Scale:** the rings sit inside the group, so they scale with zoom the same way
  today's drop-shadows do. The Outline "Same width at any zoom" compensation does
  not apply to rings.
- **Color scheme:** the selection rings use `--selection-glow`, so they flip with
  the background scheme like today's glow (#460).
- **Completion glow in Simple appears without the 1 s fade.** Animating the rings'
  opacity would repaint the whole-puzzle layer on every frame for a second, which
  is the cost Simple exists to avoid. (Designer's call.)

Existing guards in `src/style.test.ts` (three glow layers per selected rule,
`--piece-edge-filter` composition, the merge-pulse ordering from #704) must
keep passing for the Full path.

## Verification

- Unit tests for the detection function:

  | Case | Expected |
  |---|---|
  | The iPad UA above, without 26 features | Simple |
  | Mac Safari 18, `maxTouchPoints` 0 | Full |
  | iPhone Safari 26 with a frozen `OS 18_6` token and 26 features | Full |
  | iPhone UA without 26 features (any `Version/` or `CriOS`) | Simple |
  | Android Chrome, `deviceMemory` 2 | Simple |
  | Android Chrome, `deviceMemory` 4 | Full |
  | Desktop Chrome, no `deviceMemory` | Full |

- On the iPad: check `CSS.supports` returns false for both feature checks.
- Tests for the setting: persistence, Auto resolving, and the attribute
  changing live.
- On the owner's iPad 6th gen (USB, Instruments Core Animation FPS, inspector
  LayerTree):
  - With all groups selected in Simple, layer memory should stay close to the
    unselected baseline (about 110–125 MB, against 388–649 MB today). The spike
    measured roughly +30 MB for 192 groups with rings shown.
  - Zoomed-out pan under the Shadow preset in Simple should be near 60 fps
    (13 fps today).
  - Completing a puzzle in Simple shows the amber rings without a layer-memory
    spike, compared with Full on the same puzzle.
  - Check that Safari's compositing policy stays normal: a `will-change` probe
    element still gets its own layer.
- On a modern device in Full: no visual difference from `main`.

## Designer's calls

These were not decided by the owner. They are open to revision.

- Detect the iOS version with a WebKit 26 feature check instead of UA version
  tokens. This survives the frozen OS token, Chrome on iOS, home-screen apps and
  in-app web views.
- Use `deviceMemory ≤ 2` for Android.
- The setting is named **Effects**, sits after Piece outline, and shows what Auto
  resolved to.
- Auto is resolved once at startup.
- Track the setting with `trackSettingChange` only.
- Draw rings in per-ring `<g opacity>` groups to avoid seam artifacts.
- The completion glow in Simple has no fade.

## Left to the builder

- Exact ring widths, opacities and count for each effect, tuned by eye against
  the Full look on the iPad and in a desktop browser.
- Whether the rings share the outline underlay's paths (for example via `<use>`)
  or duplicate them.
- The detection module's location and the attribute name.
- The wording of the setting's description.
