# Split Help and Settings Modals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single ℹ️ info modal with a ❓ Help modal and a ⚙️ Settings modal so players can find the settings (#723).

**Architecture:** A shared `createModalShell` owns the overlay, header, close button, focus and view-stat tracking (open time, seen %, scrolled). `help-modal.ts` fills it with Share, How to Play, Credits, About. `settings-modal.ts` fills it with the settings plus the Debug section (moved to `debug-section.ts`). `info-modal.ts` and `info-button.ts` are deleted at the end.

**Tech Stack:** TypeScript, vanilla DOM, Vitest + jsdom, oxlint, Vite.

**Spec:** Issue puzzlewise/puzzlewise.github.io#723 plus the decisions agreed in session (recorded under Global Constraints).

## Global Constraints

- Help modal contains, in order: Share (only when a game exists), How to Play, Credits, About.
- Settings modal contains, in order: the settings (Snap distance, Piece outline, Effects, Offset drag, Enclose to select), then the collapsed Debug section.
- Help button: label `❓`, title `Help`, class `help-button`. Settings button: label `⚙️`, title `Settings`, class `settings-button`.
- Help button keeps the ℹ️ button's slot: `top: 135px` (short landscape, `max-height: 400px`: `88px`). Settings button sits directly below it: `top: 178px` (short landscape: `112px`). Same size/styling as the old `.info-button`.
- DOM order: …deselect, background-color control, help button, settings button (Tab order follows DOM order).
- Modal titles (`h2.info-modal-title`, also the dialog's `aria-label`): `Help` and `Settings`. The settings modal drops the now-redundant `Settings` `h3`.
- Analytics event names, exactly: `help-modal-opened`, `help-modal-closed`, `settings-modal-opened`, `settings-modal-closed`. `info-modal-opened`/`info-modal-closed` are removed.
- `debugOpened` moves to `settings-modal-closed` only. `closedBy: 'solve'` exists only on `settings-modal-closed`.
- `puzzle-shared` and `share-failed` `source: 'info-modal'` becomes `'help-modal'`.
- Shared modal CSS class names (`info-modal-overlay`, `info-modal`, `info-modal-header`, `info-modal-title`, `info-modal-close`, `info-modal-content`, `info-section`, `info-setting-*`, `info-modal-solve-btn`) are kept as is — no CSS rename churn.
- The unused `onDismiss` and `onToleranceChanged` options of `InfoModalOptions` are not carried over (no production caller).
- User-facing copy is British English ("colour"); identifiers and comments are American English.
- Comment policy in `CLAUDE.md` applies: no new comments unless category 5/6 and definitely worth it.
- Run npm through fnm so `.nvmrc` picks Node: `/Users/bot/homebrew/bin/fnm exec npm …`.

## Review Focus

- Short-landscape layout (`max-height: 400px`): the settings button must sit below help without overlap — pinned in Task 4 (style test).
- Escape on the outline-colour swatch popover inside the Settings modal closes only the popover (#666) — keep the existing test in Task 3.
- Help opened with no game (boot failure, #488): no share section, no throw — test in Task 2.
- Settings opened with no game: repro block hidden, Solve still closes the modal — existing tests retained in Task 3.
- Tab order: settings button after help button in DOM — pinned in Task 4 (install-toolbar test).

---

### Task 1: Modal shell

**Files:**
- Create: `src/ui/modal-shell.ts`
- Test: `src/ui/modal-shell.test.ts` (`@vitest-environment jsdom`)

**Interfaces:**
- Produces:
  ```ts
  export type ModalDismissCause = 'button' | 'backdrop' | 'escape';
  export interface ModalViewStats { openMs: number; seenPercent: number; scrolled: boolean; }
  export function createModalShell<C extends string = never>(opts: {
      container: HTMLElement;
      title: string;
      buildContent: (close: (closedBy: 'button' | C) => void) => readonly HTMLElement[];
      onClosed: (closedBy: ModalDismissCause | C, stats: ModalViewStats) => void;
  }): void;
  ```
  `buildContent` runs once; its elements are appended to `.info-modal-content` before the first seen-sample. Overlay via `createDismissableOverlay` (`click` → `'backdrop'`, `escape` → `'escape'`). Close button → `'button'`. `onClosed` fires exactly once per modal.

- [ ] **Step 1: Write failing tests** in `src/ui/modal-shell.test.ts`, moving the shell-level cases out of `info-modal.test.ts`'s analytics block (geometry stubs and helpers come with them):
  - `renders a dialog labelled by its title`: `[role="dialog"]` has `aria-label` `'Help'` and `.info-modal-title` text `'Help'` for `title: 'Help'`.
  - `appends the built content and focuses it`: `.info-modal-content` contains the returned elements in order; `document.activeElement` is the content.
  - `it.each` `reports closedBy %s` for `button` / `backdrop` / `escape` → `onClosed` called once with that cause.
  - `passes a caller close cause through`: `buildContent` captures `close`, calling `close('solve')` → `onClosed('solve', …)` once and the overlay is removed.
  - `reports how long the modal was open` (fake timers, advance 1500 ms → `openMs: 1500`).
  - The four seen-percent cases from `info-modal.test.ts` (fits → `100`/`scrolled: false`; never scrolled → visible share; furthest point after scrolling back; overscroll capped at `100`).
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/ui/modal-shell.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `createModalShell`** by lifting the shell parts of `createInfoModal` (`src/ui/info-modal.ts:783-884`) minus the Debug toggle tracking and the `track` calls.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `refactor(ui): extract a shared modal shell`.

### Task 2: Help modal

**Files:**
- Create: `src/ui/help-modal.ts`, `src/ui/help-modal.test.ts`
- Modify: `src/analytics/umami.ts` (types + `track` overloads), `src/analytics/index.ts` (re-exports), `src/ui/share-section.ts:97,105`, `src/ui/share-section.test.ts:124,147`, `src/ui/index.ts`

**Interfaces:**
- Consumes: `createModalShell` (Task 1).
- Produces:
  ```ts
  export interface HelpModalOptions { container: HTMLElement; state?: GameState; }
  export function createHelpModal(options: HelpModalOptions): void;
  // umami.ts
  export type HelpModalOpenedData = Record<string, never>;
  export interface HelpModalClosedData {
      closedBy: 'button' | 'backdrop' | 'escape'; openMs: number; seenPercent: number; scrolled: boolean;
  }
  ```
  (Declare the fields directly in `umami.ts`; don't import UI types into analytics.) Move the existing `InfoModalClosedData` doc comment onto `HelpModalClosedData`, minus the Debug sentence, plus one line that `help-modal-*` replaced `info-modal-*`, whose content also included Settings and Debug. Leave `InfoModal*` in place until Task 4.

- [ ] **Step 1: Write failing tests** in `src/ui/help-modal.test.ts`; move the How to Play describe block and the `share section first` / `rotation` / `no Cut Styles` cases from `info-modal.test.ts` (retarget to `createHelpModal`), plus:
  - `is titled Help`: `.info-modal-title` text `'Help'`.
  - `holds no settings or debug`: no `[data-testid="tolerance-options"]`, no `[data-testid="debug-section"]`, no `.info-modal-solve-btn`.
  - `renders Credits and About after How to Play`: `h3` texts equal `['How to Play', 'Credits', 'About']` without state and `['Share this puzzle', 'How to Play', 'Credits', 'About']` with state.
  - `opens without a game`: `createHelpModal({ container })` doesn't throw and renders no `.share-section`.
  - `points to the Settings button`: How to Play text contains `'⚙️'` and `'Settings'`.
  - `sends help-modal-opened` → `umami.track` called once with `('help-modal-opened', {})`.
  - `reports view stats without debugOpened`: after close button, `help-modal-closed` data `toEqual({ closedBy: 'button', openMs: expect.any(Number), seenPercent: 100, scrolled: false })`.
  - In `share-section.test.ts`, expect `source: 'help-modal'`.
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/ui/help-modal.test.ts src/ui/share-section.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `createHelpModal` (move `buildHowToPlaySection`, `buildCreditsSection`, `buildAboutSection`, `appendInline*`, `inlineToolIcon` from `info-modal.ts`; `info-modal.ts` keeps its own copies until Task 4 deletes it — or imports them from `help-modal.ts`, implementer's choice). Add a bullet after the 🎨 Background one, exact copy: `['⚙️ ', ['strong', 'Settings'], ' — Snap distance, piece outlines, effects and more']`. Add the `HelpModal*` types, `track` overloads and re-exports. Change share `source` to `'help-modal'` in `PuzzleSharedData`, `ShareFailedData` (and its doc's "info-modal share section" → "help-modal share section"), `share-section.ts`. Export `createHelpModal`/`HelpModalOptions` from `src/ui/index.ts`.
- [ ] **Step 4: Run** the Step 2 command plus `/Users/bot/homebrew/bin/fnm exec npm run build` — expect PASS.
- [ ] **Step 5: Commit** `feat(ui): add a help modal`.

### Task 3: Settings modal

**Files:**
- Create: `src/ui/settings-modal.ts`, `src/ui/debug-section.ts`
- Move: `git mv src/ui/info-modal.test.ts src/ui/settings-modal.test.ts`
- Modify: `src/analytics/umami.ts`, `src/analytics/index.ts`, `src/ui/index.ts`

**Interfaces:**
- Consumes: `createModalShell<'solve'>` (Task 1).
- Produces:
  ```ts
  // settings-modal.ts
  export interface SettingsModalOptions {
      container: HTMLElement;
      onEffectsChanged?: (preference: string) => void;
      onSolve?: () => void;
      getState?: () => GameState | null | undefined;
  }
  export function createSettingsModal(options: SettingsModalOptions): void;
  // debug-section.ts
  export function buildDebugSection(args: {
      state: GameState | null | undefined;
      onSolve?: () => void;
  }): HTMLDetailsElement;
  // umami.ts
  export type SettingsModalOpenedData = Record<string, never>;
  export interface SettingsModalClosedData {
      closedBy: 'button' | 'backdrop' | 'escape' | 'solve';
      openMs: number; seenPercent: number; scrolled: boolean; debugOpened: boolean;
  }
  ```
  `debug-section.ts` gets `buildDebugSection` and its private helpers (repro, device label, opacity, debug toggles). `settings-modal.ts` gets the settings builders, `buildPresetSetting`, `buildCheckboxSetting`, `trackSettingChange`. Solve: `close('solve')` then `onSolve()`, as today. `SettingsModalClosedData`'s doc: the `seenPercent` definition and the "expanded Debug section counts toward the height" sentence.

- [ ] **Step 1: Rework the moved test file**: retarget every case to `createSettingsModal`; delete the cases now owned by `modal-shell.test.ts` and `help-modal.test.ts`; keep all Settings, Debug, Device label, swatch-Escape (#666) and `setting-changed` cases. Add/adjust:
  - `is titled Settings with no Settings subheading`: `.info-modal-title` text `'Settings'`; no `h3` with text `'Settings'`.
  - `puts the settings before Debug`: first `.info-section` contains `[data-testid="tolerance-options"]`; last child of `.info-modal-content` is `[data-testid="debug-section"]`.
  - `holds no help content`: no `h3` with text `'How to Play'`, no `.share-section`.
  - `sends settings-modal-opened` → `('settings-modal-opened', {})`.
  - `reports view stats with debugOpened`: close button → `settings-modal-closed` `toEqual({ closedBy: 'button', openMs: expect.any(Number), seenPercent: 100, scrolled: false, debugOpened: false })`.
  - Existing `closedBy solve` and `debugOpened true once expanded` cases, renamed to `settings-modal-closed`.
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/ui/settings-modal.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** per Interfaces; add `SettingsModal*` types, `track` overloads, re-exports; export `createSettingsModal`/`SettingsModalOptions` from `src/ui/index.ts`.
- [ ] **Step 4: Run** the Step 2 command plus `npm run build` — expect PASS.
- [ ] **Step 5: Commit** `feat(ui): add a settings modal`.

### Task 4: Toolbar buttons, wiring and removal of the info modal

**Files:**
- Move: `git mv src/ui/info-button.ts src/ui/help-button.ts`, `git mv src/ui/info-button.test.ts src/ui/help-button.test.ts`
- Create: `src/ui/settings-button.ts`, `src/ui/settings-button.test.ts`
- Delete: `src/ui/info-modal.ts`
- Modify: `src/ui/index.ts`, `src/app/install-toolbar.ts`, `src/app/install-toolbar.test.ts`, `src/app/bootstrap.test.ts:497-522,1056`, `src/style.css:1251-1282,1604-1611`, `src/style.test.ts`, `src/analytics/umami.ts` + `index.ts` (remove `InfoModal*` types and `info-modal-*` overloads), `CLAUDE.md` ("Keep the in-app help text correct")

**Interfaces:**
- Consumes: `createHelpModal` (Task 2), `createSettingsModal` (Task 3).
- Produces:
  ```ts
  export function createHelpButton(o: { container: HTMLElement; onShowHelp: () => void }): () => void;
  export function createSettingsButton(o: { container: HTMLElement; onShowSettings: () => void }): () => void;
  ```
  Both via `createToolbarButton` with the labels/titles/classes in Global Constraints. `installToolbar` wires help → `createHelpModal({ container, state: session.current() })`, settings → `createSettingsModal({ container, getState: () => session.current(), onSolve: solve, onEffectsChanged })`.

- [ ] **Step 1: Write failing tests**:
  - `help-button.test.ts`: existing cases retargeted; class `'help-button'`, text `'❓'`, title `'Help'`.
  - `settings-button.test.ts`: same shape; class `'settings-button'`, text `'⚙️'`, title `'Settings'`.
  - `install-toolbar.test.ts`: DOM-order list ends `'background-color-marker', 'help-button', 'settings-button'`; selector list has `.help-button` and `.settings-button`; Effects and Solve cases click `.settings-button`; new `opens the help modal from the help button`: click `.help-button` → `.info-modal-title` text `'Help'`.
  - `bootstrap.test.ts`: Effects case clicks `.settings-button`; order case asserts picker < help < settings; line 1056 checks `.help-button` and `.settings-button`.
  - `style.test.ts`: `stacks the settings button below help`: `pxValue('.settings-button', 'top') >= pxValue('.help-button', 'top') + pxValue('.help-button', 'height')`.
- [ ] **Step 2: Run** `/Users/bot/homebrew/bin/fnm exec npm test -- src/ui/help-button.test.ts src/ui/settings-button.test.ts src/app/install-toolbar.test.ts src/app/bootstrap.test.ts src/style.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**: buttons; CSS (`.info-button` rules → shared help/settings rules, tops per Global Constraints, both layouts — arrange rules so `pxValue` finds `top`/`height` for each selector); `installToolbar` wiring, and fix its comments that now say "info modal"/"Info" (→ settings modal / Help); `src/ui/index.ts` exports; delete `info-modal.ts` and the `InfoModal*` types/overloads/re-exports. In `CLAUDE.md`, rewrite the section's opening so it names the help modal (`src/ui/help-modal.ts`) as the in-app help and the settings descriptions in `src/ui/settings-modal.ts` as also covered; "How to Play or Settings sections" becomes "the How to Play section or a setting's description".
- [ ] **Step 4: Verify**: `grep -rn "info-modal-opened\|info-modal-closed\|'info-modal'\|createInfoModal\|createInfoButton\|info-button" src CLAUDE.md` returns nothing; `/Users/bot/homebrew/bin/fnm exec npm test`, `npm run lint`, `npm run build` all pass.
- [ ] **Step 5: Visual check** with the `run` skill: screenshot the toolbar at 390×844 and 844×390 (short landscape) and both modals open; confirm no overlap and ⚙️ directly under ❓.
- [ ] **Step 6: Commit** `feat(ui): split the info button into Help and Settings (#723)`.
