# Simple Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On limited devices (iOS/iPadOS ≤ 18, or Android with `deviceMemory` ≤ 2), draw all
group shadows and glows as stepped rings instead of CSS `drop-shadow` filters. An
Effects setting (Auto / Full / Simple) overrides the detection.

**Architecture:** A new `src/ui/effects.ts` resolves the level and writes
`data-effects="simple" | "full"` on `documentElement`. The renderer's per-group
underlay gains ring `<use>` elements that reference the group's existing edge
paths. CSS keyed on `[data-effects="simple"]` shows the rings and removes the
group filters. Everything Full users see stays on today's CSS.

**Tech Stack:** TypeScript, Vite, Vitest (jsdom), plain CSS, inline SVG.

**Spec:** `docs/superpowers/specs/2026-11-06-simple-effects-design.md`

## Global Constraints

- **Full must not change** in look or performance. Every new rule that shows rings
  or removes a filter is scoped under `[data-effects="simple"]`.
- **Detection:** Apple touch device (UA contains `iPhone`/`iPad`/`iPod`, or a
  `Macintosh` UA with `maxTouchPoints > 1`) without WebKit 26 features → `simple`.
  Otherwise `deviceMemory` ≤ 2 → `simple`, and anything else → `full`.
- **WebKit 26 feature check:** `CSS.supports('color', 'contrast-color(red)') || CSS.supports('animation-timeline', 'scroll()')`.
- **Preference:** key `puzzle-effects`, ids `auto` | `full` | `simple`, default
  `auto`. Auto is resolved once per page load.
- **Comments:** follow the comment policy in the repo's `CLAUDE.md` (categories 5–6
  only, and only when definitely worth it).
- **Node:** run tools via `/Users/bot/homebrew/bin/fnm exec …` so `.nvmrc` (Node 22)
  applies.

## Review Focus

1. **Full users on the Outline preset:** the outline must look identical, including
   its color and "Same width at any zoom", after the stroke moves from the paths to
   a wrapper `<g>`. Pinned by the style guard in Task 3.
2. **A merge while in Simple:** the surviving group's ring `<use>` elements must
   still reference that group's edge paths after the underlay rebuilds. Pinned by
   a renderer test in Task 3.
3. **A saved value that is garbage, or `localStorage` throwing:** Effects falls back
   to Auto. Pinned in Task 1.
4. **Environments without `CSS.supports` (jsdom, old browsers):** reading the
   signals must not throw, and the result is `hasWebKit26Features: false`. Pinned in
   Task 1.
5. **Switching Effects while groups are selected, dragged or completed:** the
   switch takes effect live. It is pure CSS on the attribute, so Task 1 pins the
   attribute and Task 4 pins the rules.

---

### Task 1: Effects module, detection and boot wiring

**Files:**
- Create: `src/ui/effects.ts`
- Test: `src/ui/effects.test.ts`
- Modify: `src/ui/index.ts` (re-export the public names below)
- Modify: `src/app/install-background-color.ts` (apply at boot, next to `applyOutlineConstantWidth`)
- Test: `src/app/install-background-color.test.ts`

**Interfaces:**
- Produces, from `src/ui/effects.ts`:
  - `type EffectsLevel = 'full' | 'simple'`
  - `interface EffectsSignals { userAgent: string; maxTouchPoints: number; deviceMemory: number | undefined; hasWebKit26Features: boolean }`
  - `detectEffectsLevel(signals: EffectsSignals): EffectsLevel` (pure)
  - `readEffectsSignals(): EffectsSignals` (reads `navigator` and `CSS.supports`; `CSS` may be undefined)
  - `getDetectedEffectsLevel(): EffectsLevel`: memoized `detectEffectsLevel(readEffectsSignals())`, plus `resetDetectedEffectsLevelForTests(): void`
  - `interface EffectsPreset { id: 'auto' | 'full' | 'simple'; label: string; description: string }`
  - `EFFECTS_PRESETS: readonly EffectsPreset[]`, ordered auto, full, simple. Labels `Auto`, `Full`, `Simple`. Descriptions: Full `Soft shadows and glow`, Simple `Lighter on older devices`. Auto's description is computed; see `describeAuto`.
  - `describeAuto(level: EffectsLevel): string` → `'Full on this device'` / `'Simple on this device'`
  - `EFFECTS_PREFERENCE_KEY = 'puzzle-effects'`, `DEFAULT_EFFECTS_ID = 'auto'`
  - `loadEffectsPreference(): string`, `saveEffectsPreference(id: string): void`: via `createIdPreferenceStore` with `legacyOrder: []`
  - `resolveEffectsLevel(id: string, detected: EffectsLevel): EffectsLevel`. Unknown ids resolve as `auto`.
  - `applyEffects(id: string): void`: sets `document.documentElement.dataset.effects` to `resolveEffectsLevel(id, getDetectedEffectsLevel())`

- [ ] **Step 1: Write the failing tests** in `src/ui/effects.test.ts` (`@vitest-environment jsdom`).

`detectEffectsLevel` is table-driven. Each row passes `{ userAgent, maxTouchPoints, deviceMemory, hasWebKit26Features }`:

| UA | touch | mem | wk26 | expect |
|---|---|---|---|---|
| `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.14 Safari/605.1.15` | 5 | undefined | false | `simple` |
| `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)` (home-screen app) | 5 | undefined | false | `simple` |
| `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15` | 0 | undefined | false | `full` |
| `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1` | 5 | undefined | true | `full` |
| `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1` | 5 | undefined | false | `simple` |
| `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36` | 5 | 2 | false | `simple` |
| same Android UA | 5 | 4 | false | `full` |
| `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0` | 0 | undefined | false | `full` |

Other tests:
- `readEffectsSignals` with `vi.stubGlobal('CSS', undefined)` → `hasWebKit26Features === false`, no throw.
- `readEffectsSignals` with a stubbed `CSS.supports` that returns true only for `('color', 'contrast-color(red)')` → `true`.
- `loadEffectsPreference`: returns `'auto'` when unset; returns `'auto'` for a saved `'bogus'`; round-trips `'simple'`; returns `'auto'` when `localStorage.getItem` throws (spy).
- `resolveEffectsLevel`: `('auto','simple')` → `simple`, `('auto','full')` → `full`, `('full','simple')` → `full`, `('simple','full')` → `simple`, `('bogus','simple')` → `simple`.
- `applyEffects('simple')` → `documentElement.dataset.effects === 'simple'`. A following `applyEffects('full')` → `'full'`.
- `describeAuto('simple') === 'Simple on this device'`.

- [ ] **Step 2: Run to verify they fail**

Run: `/Users/bot/homebrew/bin/fnm exec npx vitest run src/ui/effects.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/ui/effects.ts`**, following `src/ui/piece-outline.ts` (preset list + `createIdPreferenceStore` + `apply*`). `readEffectsSignals` reads `navigator.deviceMemory` as `number | undefined` (it isn't in the DOM lib types, so narrow with `typeof`).

- [ ] **Step 4: Wire at boot.** In `installBackgroundColor`, call `applyEffects(loadEffectsPreference())` next to `applyOutlineConstantWidth(...)`. Extend the existing `'applies the saved piece-outline settings'` test in `install-background-color.test.ts`: with `localStorage['puzzle-effects'] = 'simple'`, expect `documentElement.dataset.effects === 'simple'`.

- [ ] **Step 5: Run both test files; expect PASS.**

Run: `/Users/bot/homebrew/bin/fnm exec npx vitest run src/ui/effects.test.ts src/app/install-background-color.test.ts`

- [ ] **Step 6: Commit** — `feat(ui): detect limited devices and resolve an effects level`

---

### Task 2: Effects setting in the info modal

**Files:**
- Modify: `src/ui/info-modal.ts`: new `buildEffectsSetting()`, appended in `buildSettingsSection` right after `buildPieceOutlineSetting()`
- Modify: `src/analytics/umami.ts:444`: add `'effects'` to the string-valued `setting` union of `SettingChangedData`
- Test: `src/ui/info-modal.test.ts`

**Interfaces:**
- Consumes: `EFFECTS_PRESETS`, `describeAuto`, `getDetectedEffectsLevel`, `loadEffectsPreference`, `saveEffectsPreference`, `applyEffects` from Task 1.

The setting:
- Label `Effects`.
- Description `Simple draws shadows and the selection glow as plain rings, which is much lighter work for older devices.`
- Uses the same `preset-options` / `preset-option` markup as Piece outline.
- Container `data-testid="effects-options"`, buttons `data-testid="effects-<id>"`.
- The Auto button's description is `describeAuto(getDetectedEffectsLevel())`.
- On click: `trackSettingChange({ setting: 'effects', from, to })`, then save, `applyEffects(id)`, and move `.selected`.

- [ ] **Step 1: Write failing tests** in a new `describe('effects setting')` in `info-modal.test.ts`. Reset `localStorage`, call `resetDetectedEffectsLevelForTests()`, and remove `data-effects` in `beforeEach`.
  - It renders three buttons in order `effects-auto`, `effects-full`, `effects-simple`, with `effects-auto` selected by default.
  - The Auto button's `.preset-option-desc` text equals `describeAuto(getDetectedEffectsLevel())`. In jsdom (no touch, no `deviceMemory`) that is `'Full on this device'`.
  - Clicking `effects-simple` stores `'simple'` under `puzzle-effects`, sets `documentElement.dataset.effects` to `'simple'`, and moves `.selected` to it.
  - It sits right after the piece-outline setting: the `.info-setting` following the one containing `[data-testid="piece-outline-options"]` contains `[data-testid="effects-options"]`.

- [ ] **Step 2: Run; expect FAIL.**

Run: `/Users/bot/homebrew/bin/fnm exec npx vitest run src/ui/info-modal.test.ts`

- [ ] **Step 3: Implement** `buildEffectsSetting()`, and add `'effects'` to `SettingChangedData`.

- [ ] **Step 4: Run; expect PASS.** Also run `/Users/bot/homebrew/bin/fnm exec npm run lint`.

- [ ] **Step 5: Commit** — `feat(ui): add an Effects setting with Auto, Full and Simple`

---

### Task 3: Ring elements in the group underlay (hidden by default)

**Files:**
- Modify: `src/renderer/svg-dom-renderer.ts`: `syncOutlineUnderlay` (around line 349)
- Modify: `src/style.css`: the outline underlay block (around lines 369–393)
- Test: `src/renderer/svg-dom-renderer.test.ts` (`describe('outline underlay')`), `src/style.test.ts`

**Interfaces:**
- Produces: inside each `svg[data-outline-underlay]`, children in this order (bottom to top):
  1. One `<use data-ring="<name>" href="#group-edges-<groupId>">` per name in `RING_NAMES`.
  2. `<g data-edge-outline>` containing `<g id="group-edges-<groupId>">`, which holds the existing per-piece `<path>`s (same `d` and `transform` as today).
- `export const RING_NAMES = ['edge-1', 'edge-2', 'edge-3', 'lift-1', 'lift-2', 'lift-3', 'completion-shadow', 'completion-1', 'completion-2', 'glow-1', 'glow-2', 'glow-3'] as const` (in `svg-dom-renderer.ts`). Within each family, `-1` is the widest ring, drawn lowest.

The rings reference the paths instead of copying them, so a group's path count is unchanged. The outline's stroke moves from `path` to `[data-edge-outline]`, because rules matching the referenced paths also apply inside each `<use>`. The rings can only take their own stroke if the paths set none.

- [ ] **Step 1: Write failing renderer tests**
  - `'adds a ring for every ring name, before the outline, each referencing the group edges'`: the underlay's first `RING_NAMES.length` children are `use` elements whose `data-ring`s equal `RING_NAMES` in order, each with `href === '#group-edges-0'`. The last child is `g[data-edge-outline]`, and `underlay.querySelector('#group-edges-0')` is inside it.
  - `'keeps ring references valid after a merge'`: render `makeMatedPairState(false)` then `makeMatedPairState(true)`. For group 0, every `use[data-ring]`'s `href` target exists inside the same underlay, and `drawnEdgeCounts(0)` is still `[3, 3]`.
  - The existing tests in this `describe` must pass unchanged. `querySelectorAll('path')` still finds exactly the edge paths, since jsdom does not expand `<use>`.

- [ ] **Step 2: Write the failing style guard** in `src/style.test.ts`:
  - `declarationsFor(styleCss, '[data-edge-outline]')` matches `/stroke:\s*var\(--piece-outline-color, #080808\)/` and `/stroke-width:\s*calc\(3px \* var\(--outline-stroke-scale, 1\)\)/`.
  - `declarationsFor(styleCss, '[data-outline-underlay] path')` does **not** match `/stroke:|stroke-width:/`.
  - `declarationsFor(styleCss, '[data-ring]')` matches `/display:\s*none/` and `/fill:\s*none/`.
  - `declarationsFor(styleCss, '[data-edge-outline]')` matches `/display:\s*none/`, and `declarationsFor(styleCss, '[data-piece-outline="outline"] [data-edge-outline]')` matches `/display:\s*inline/`.

- [ ] **Step 3: Run both; expect FAIL.**

Run: `/Users/bot/homebrew/bin/fnm exec npx vitest run src/renderer/svg-dom-renderer.test.ts src/style.test.ts`

- [ ] **Step 4: Implement.**
  - **Renderer:** build the ring `<use>`s and the two wrapper `<g>`s once, when the underlay is created. On a membership change, replace only the children of `#group-edges-<id>`. The early return on an unchanged `data-pieces` key stays.
  - **CSS:**
    - Move `stroke` and `stroke-width` from `[data-outline-underlay] path` to `[data-edge-outline]`. Keep `fill`, `stroke-linejoin` and `stroke-linecap` on the path rule.
    - Add `[data-edge-outline] { display: none }` and `[data-piece-outline="outline"] [data-edge-outline] { display: inline }`.
    - Add `[data-ring] { display: none; fill: none; stroke-linejoin: round; stroke-linecap: round }`.
    - The `[data-piece-outline="outline"] [data-outline-underlay] { display: block }` rule stays as it is.

- [ ] **Step 5: Run; expect PASS. Then the full suite and the build.**

Run: `/Users/bot/homebrew/bin/fnm exec npm test` and `/Users/bot/homebrew/bin/fnm exec npm run build`
Expected: all green.

- [ ] **Step 6: Check Full is unchanged in a browser.** Run `npm run dev` on this branch and on `main` (a `main` worktree). Open the same share link in both (make one with Info → Share this puzzle). For each of the None, Shadow and Outline presets, and Outline with "Same width at any zoom" on, take a Playwright Chromium screenshot with one group selected. They must match pixel for pixel. Do the same for the completion glow, using Debug → Solve.

- [ ] **Step 7: Commit** — `refactor(renderer): reference group edges from hidden ring elements`

---

### Task 4: Simple-mode CSS (rings on, group filters off)

**Files:**
- Modify: `src/style.css`: a new block placed **after** the `[data-group-id]` state rules (around line 467) and after `.completion-glow [data-group-id]` (around line 537), so that equal-specificity rules win by order
- Test: `src/style.test.ts`

Rules (selectors exact, since the guards match them):

| Selector | Declarations |
|---|---|
| `[data-effects="simple"] [data-outline-underlay]` | `display: block` |
| `[data-effects="simple"] [data-group-id]` | `--piece-edge-filter: opacity(1); --piece-edge-idle-filter: none` |
| `[data-effects="simple"] [data-group-id].selected`, `[data-effects="simple"] [data-group-id].dragging` | `filter: none` |
| `[data-effects="simple"] .completion-glow [data-group-id]` | `filter: none; transition: none` |
| `[data-effects="simple"][data-piece-outline="shadow"] [data-ring^="edge-"]`, `[data-effects="simple"] [data-group-id].dragging [data-ring^="lift-"]`, `[data-effects="simple"] .completion-glow [data-ring^="completion-"]`, `[data-effects="simple"] [data-group-id].selected [data-ring^="glow-"]` | `display: inline` |

Ring looks are starting values for tuning in Task 5. Opacity goes on the `<use>`, so overlapping piece paths are flattened within each ring:

| Ring | stroke | stroke-width | opacity |
|---|---|---|---|
| `edge-1/2/3` | `#000` | 12px / 8px / 4px | 0.12 each |
| `lift-1/2/3` | `#000` | 24px / 16px / 8px | 0.15 each |
| `completion-shadow` | `#000` | 8px, plus `transform: translate(0, 2px)` | 0.2 |
| `completion-1/2` | `var(--color-amber-default)` | 40px / 16px | 0.35 / 0.5 |
| `glow-1/2/3` | `var(--selection-glow)` | 48px / 28px / 12px | 0.4 / 0.5 / 0.9 |

- [ ] **Step 1: Write failing guards** in `src/style.test.ts`, in a `describe('simple effects')`:
  - Each selector in the first table yields its declarations through `declarationsFor`.
  - `declarationsFor(styleCss, '[data-ring^="glow-"]')` matches `/stroke:\s*var\(--selection-glow\)/`.
  - No rule whose selector contains `[data-effects="simple"]` declares `drop-shadow`. Scan the comment-stripped CSS for blocks whose prelude includes it.
  - The existing Full guards (three glow layers, `--piece-edge-filter` composition, merge-pulse order) still pass untouched.

- [ ] **Step 2: Run; expect FAIL.**

Run: `/Users/bot/homebrew/bin/fnm exec npx vitest run src/style.test.ts`

- [ ] **Step 3: Add the CSS.**

- [ ] **Step 4: Run style tests, the full suite, lint and build; expect PASS.**

- [ ] **Step 5: Smoke-test in Chromium** with the dev server and Effects → Simple:
  - Shadow preset shows faint rings.
  - Selecting a group shows violet rings that flip on a light background.
  - Dragging shows lift rings.
  - Debug → Solve shows amber rings without a fade.
  - `getComputedStyle(group).filter` is `none` on idle, selected and dragged groups.
  - Switching back to Full restores today's look without a reload.

- [ ] **Step 6: Commit** — `feat(ui): draw shadows and glows as rings under Simple effects`

---

### Task 5: Tune and verify on the iPad, open the PR

No new tests. This is measurement and tuning. The recipe is in the
`ipad-webkit-remote-inspection` memory: `ios_webkit_debug_proxy`, scripts in
`/tmp/ipadprobe/`, and Instruments' Core Animation FPS.

- [ ] **Step 1: Push the branch and open a PR** (body ends with the Claude Code line), so the preview deploys to `/dev/`. Watch CI to completion. On the iPad, confirm the live stylesheet contains `data-effects`, since a stale service-worker build may be cached. Reload if not.
- [ ] **Step 2: Detection on the device.** In the page, check `CSS.supports('color','contrast-color(red)')` and `CSS.supports('animation-timeline','scroll()')` are both `false`, and `documentElement.dataset.effects === 'simple'` under Auto. The Info modal's Auto option reads "Simple on this device". Also check that the rings actually render in Safari 17: select a group and look at a screenshot. `<use>` referencing a `<g>` under a hidden wrapper is the part of the design that Chromium alone does not prove.
- [ ] **Step 3: Measure on the iPad.** Work on the 192-piece board at fit scale (0.235864). Never write to the save or settings: set state in-page and reload to restore.
  - **Memory:** layer memory with all groups selected in Simple, against unselected. Target: close to the unselected 110–125 MB, against 388–649 MB in Full.
  - **Panning:** zoomed-out pan under the Shadow preset in Simple. Target: about 60 fps, against 13 in Full.
  - **Completion:** layer memory during the completion glow in Simple against Full.
  - **Compositing policy:** the will-change probe still gets its own layer after each run.
- [ ] **Step 4: Tune the ring values by eye** on the iPad and in desktop Chromium: the selection must be obvious on dark and light backgrounds, and the Shadow rings must stay subtle. Commit the changes as `fixup!` commits of Task 4.
- [ ] **Step 5: Put the measurements in the PR body** (`Fixes #703`), and report them to the owner with screenshots of Simple's selection and Shadow rings.
