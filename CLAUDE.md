# Repo conventions for Claude

## Comment policy: intent and not-in-the-code information only

**Audience — write for an AI agent, not a presumed human reader.** This repo's
source is read and written only by AI agents, which parse the code fluently;
no human skims it. A comment's only job is to carry what an agent cannot
recover from the code itself. So never orient, teach, or narrate: no
walkthroughs, no skim-summaries, no changelog voice ("now also handles…",
"previously this…"). This is *why* categories 1–4 below are forbidden — a
fluent reader needs no restatement or summary — and all that survives is
intent and the contracts the code can't express (5–6).

**Every comment carries significant intrinsic cost — weigh it before writing
or touching one.** Agent review loops in this repo have burned entire rounds
discussing and "fixing" comments without changing a line of code, at real
financial cost to the owner. The categories below are the floor, not the
bar: even a category-5/6 comment is added only when it is *definitely*
valuable against that cost. The same weighing applies before changing a
comment — whether the impulse is yours or a reviewer's: a comment not
clearly worth its upkeep is deleted in its entirety, not corrected. For
reviewers, deletion is the default remedy to propose for any comment
finding.

Code Complete's six kinds of comments, applied to this repo. **Forbidden** —
never write these, and delete them on sight when editing a file:

1. **Repeat of the code** — restates what the line says.
2. **Explanation of the code** — walks through *how* the code works. If code
   needs explaining, make the code clearer instead. Exception: where a
   reproducibility or geometry contract forbids that refactor (the modules
   pinned by the bezier-js geometry-digest tripwire — `apply-tabs.ts`,
   `dcel.ts`, `curve-clamp.ts`), the explanation *is* category 6 — keep it.
3. **Marker** — `TODO`/`FIXME`/section banners/notes-to-self.
4. **Summary** — condenses a block so a reader can skim it. In this repo no
   human skims the source, so summaries (including JSDoc that merely restates
   a signature) are pure drift risk with no reader.

**Allowed** — the only comments this repo should contain:

5. **Intent** — *why* this approach, at the level of the problem: rationale,
   rejected alternatives, constraints that shaped the code.
6. **Information the code cannot express** — contracts and invariants not
   capturable in types (units, ranges, call-order requirements,
   reproducibility contracts), workarounds for third-party bugs with a
   pointer to the cause, security rationale, spec/issue references.

Every comment must fall squarely in 5 or 6; shorten those to the load-bearing
core. When reviewing, never propose adding a category 1–4 comment — a
hard-to-follow block wants a code change, not commentary.

Scope and carve-outs:

- The policy governs the whole repo — workflow YAML and config files
  included. In workflows, a step's `name:` already serves the summary role,
  so a comment restating a step is category 1. Form does not decide
  category: a comment that carries rationale is 5/6 even when banner-shaped
  — `.oxlintrc.jsonc`'s rule-group banners are the canonical example, being
  the only record of the noise-vs-actively-wrong split described below.
- Lint, compiler, and test-runner pragmas are not comments, whatever their
  spelling: `eslint-disable*`, `@ts-expect-error`, `@vitest-environment`, and
  kin. Beware that `@vitest-environment` sits alone in a top-of-file `/** */`
  block — exactly the shape of a category-4 summary — and deleting it
  silently changes the file's test environment.
- `src/analytics/umami.ts`'s doc comments are the operator-facing query spec
  (category 6): keep them **accurate**. Spec means facts the code cannot
  express — external API behaviour, query semantics, absent-property
  caveats. Never restate behaviour readable from the source (call sites,
  spend patterns, coverage claims): those claims drift, and PR #543 spent an
  entire review round on exactly that. When a change falsifies such a claim,
  shed it rather than extend it.

## The oxlint config's disabled rules are load-bearing

`npm run lint` runs oxlint with type-aware rules. Ten rules are switched off in
`.oxlintrc.jsonc`, each with an inline reason. **Five are noise** — high hit
counts with no defect behind them (`no-underscore-dangle`,
`consistent-function-scoping`, `no-unsafe-type-assertion`, `unbound-method`,
and `unicorn/no-array-sort`, whose 27 hits contained zero real defects).

**The other five were verified to be actively wrong here**, and these are the
ones worth knowing before you touch the config:

- `typescript/no-unnecessary-boolean-literal-compare` **silently removes a
  security guard.** Its fix rewrote `cf.bl = c.borderless === true` to
  `cf.bl = c.borderless` in `share-link.ts`, dropping a coercion on a value
  decoded from an untrusted share link. It compiles fine — only a test caught
  it. This is the dangerous one.
- `typescript/no-unnecessary-type-assertion` **breaks the build**, removing a
  cast `tsc` requires in `sw-error-bridge.ts` (2× TS2769).
- `unicorn/no-array-reverse` fires on `Curve.reverse()`, a custom method that
  returns a new `Curve` rather than mutating.
- `unicorn/require-post-message-target-origin` fires on `Worker` and
  ServiceWorker-`Client` `postMessage`, which take `(message, transfer?)` and
  have no `targetOrigin` at all. Its fix would throw at runtime.
- `typescript/consistent-return` fires on exhaustive enum switches; satisfying
  it means adding a `default` that *removes* the compile error a newly-added
  enum member would otherwise cause.

Do not re-enable one to "fix more things" without reading
`docs/superpowers/specs/2026-08-02-oxlint-adoption-design.md` first.

Separately, `oxc/approx-constant` is **enabled for all source** and disabled
only for `**/*.test.ts`, because the decimal fixtures there — `3.14159265`,
`2.71828182` — are deliberately awkward quantization inputs, not
approximations of pi. A stray `3.14159` anywhere under `src/`, `diagnostics.ts`
included, is still flagged. That scoping is why `overrides` has **two** entries
rather than one with a merged `files` list: `no-console` is off for tests *and*
`diagnostics.ts`, `approx-constant` for tests only. Collapsing them silently
widens `approx-constant` onto a source file — which is exactly what happened
once here.

**Never add `--type-check` (or `options.typeCheck`).** `src/pwa/sw.ts` is
excluded from `tsconfig.json`, so tsgolint resolves it against a project
without the WebWorker lib and emits ten bogus errors. Worth knowing that the
underlying seam survives the prohibition: `sw.ts` is linted with type-aware
rules resolved against a project that does not contain it, so its worker types
and `import.meta.env` don't resolve. (`self` itself is fine — the file declares
it as `ServiceWorkerGlobalScope` at `src/pwa/sw.ts:30`, shadowing the global.)
Nothing fires there today, but the constraint is "sw.ts sits outside the
linter's type universe", not "one flag is cursed".

Lint scope is `src`, matching `tsconfig.json`'s `include`, so a new top-level
directory is not silently opted in. Note the one gap that follows from the
paragraph above rather than contradicting it: `src/pwa/sw.ts` is inside that
scope but *excluded* from `tsconfig.json`, so it is the one linted file whose
type-aware rules run against a project it does not belong to.

Rules and severities live in `.oxlintrc.jsonc` rather than the npm scripts, and `ignorePatterns` covers the directories no tsconfig owns
— so a single-file `npx oxlint src/foo.ts`, a bare `npx oxlint`, or an editor
run agree with CI on *what is checked and how hard it fails*.

They do **not** agree on config discovery, and cannot. `--disable-nested-config`
and `-c .oxlintrc.jsonc` have no `options` equivalent — they choose which
config files load, so by construction they can only be flags — and both sit on
the `lint`/`lint:fix` scripts. If you find yourself moving them into `options`
to satisfy the paragraph above: there is no such key, and deleting them instead
reopens a nested `src/**/.oxlintrc.json` silencing an entire subtree. The
reason is recorded beside the `options` block itself.

`src/lint-config.test.ts` pins both `options` keys and the script's scope.
`reportUnusedDisableDirectives` is the one setting with no self-protection —
deleting it leaves every existing directive valid, so CI would stay green
while suppressions quietly resumed accumulating.

`lint:fix` is a local convenience, not something CI runs. It is safe under the
committed config, but `npm run build` and `npm test` are the backstop.

## Planning docs are historical — don't propose updates to them

Everything under `docs/superpowers/` — specs, plans, design docs — records what
was **intended before the work happened**. None of it is a maintained artifact.

- **Do read them when reviewing.** They carry the *why* a diff cannot: the
  problem being solved, the alternatives rejected and on what grounds, the
  constraints in force. That is how you tell a deliberate choice from an
  accidental one.
- **Never propose editing them.** Not "the spec's line citations are stale",
  not "§2 doesn't record this change", not "the numbers in the design doc no
  longer match". Drift between a plan and the merged code is the *expected*
  end state, not a defect. The PR conversation already records the divergence,
  and it is the durable record.

**Specs are not exempt.** "The plan is historical but the spec is maintained"
is a tempting distinction and a wrong one. Both are planning docs.

`CLAUDE.md` is the opposite case and the reason the distinction matters: it is
live instruction loaded into every session, so keeping it accurate *is* the
job. Fix it whenever a change makes it wrong.

Worth naming the failure mode, because it recurs: doc-vs-code mismatches are
unusually easy to spot and easy to state precisely, which makes them attractive
filler for a review that is otherwise coming up clean. A findings list that is
mostly "the doc says X, the code does Y" is a signal the review has run out of
real material. On PR #516 seven of nine final recommendations were doc-update
proposals, and several earlier rounds had already produced fixup commits doing
that work — all of it waste, and it crowded out the genuine findings.

## Keep the in-app help text correct

The info modal (`src/ui/info-modal.ts`) is the only in-app place where the
player learns how the app works — there is no separate README shown in the
UI. The goal is a **short, useful** modal: explain the things a player might
actually need explained, and leave out what they'd already expect.

The requirement is that the help text stays **correct**, not that every
user-visible behaviour is documented. When a change makes an existing
sentence in the **How to Play** or **Settings** sections
wrong or misleading, fix it in the same PR. When a change removes a feature
the modal describes, remove that description too.

Adding new copy is a judgment call, not an obligation. Add it only when a
player would plausibly be confused or miss the feature without it — a new
toolbar button, a new cut style or new option in the new-game dialog, a new
setting, or a non-obvious interaction or behaviour change. Do **not** add
copy for behaviour a user would naturally expect (e.g. "your zoom and pan
are remembered across reloads"); spelling out the obvious only makes the
modal longer and less useful.

If the change is purely internal (refactor, perf, bug fix with no visible
behaviour change), or the visible behaviour is what a player would already
expect, no help-text update is needed.

## Isolate new seeded randomness behind a sub-PRNG

The puzzle reproduces puzzles from a share link or save by replaying a
single seeded PRNG through `generateProceduralPuzzle`. The exact number
and order of `random()` calls during generation is a **reproducibility
contract**: adding, removing, or reordering calls silently breaks every
existing share link and save.

When you add a new feature that consumes `random()` (a new tab
generator, a new piece-layout variation, a new cosmetic jitter), don't
make those calls directly on the outer PRNG. Instead, draw **one** outer
value, use it to seed a local sub-PRNG, and make all internal calls
against the local stream:

```ts
import { createSeededRandom } from '../puzzle/seeded-random.js';

function seedFromFloat(v: number): number {
    return Math.floor(v * 4294967296);
}

function generate(random: () => number): SomeOutput {
    const subSeed = random();                                  // ONE outer call
    const local = createSeededRandom(seedFromFloat(subSeed));

    // All per-feature randomness comes from `local`.
    const paramA = local();
    const paramB = local() < 0.5;
    // ...
}
```

The outer stream advances by exactly one call regardless of how much
randomness the feature internally consumes. Future changes to the local
block — new parameters, reordered calls — affect that feature's output
for a given seed, but they do **not** disturb the rest of the puzzle's
seeded generation. Share links and saves stay valid for everything
except the changed feature's own output, which is the smallest possible
breakage.

Use this pattern whenever you can defer the outer-stream contract to a
smaller scope. The alternative — padding with reserved-but-unused outer
calls — caps your future flexibility (pick N reserved slots, need N+1
later, you're stuck) and still consumes shared outer state.

Don't retrofit this onto existing generators. Their current outer-call
counts are the contract; reshuffling them silently breaks every share
link that targets that generator.

## bezier-js's pinned version is part of the geometry contract

The seeded PRNG above is not the only input to a reproduced puzzle. Cut
geometry comes out of bezier-js's numerics, and `package.json` allows any
6.x, so the version resolved in `package-lock.json` decides the piece paths
too. The tripwires are
`src/puzzle/topology/dcel-broad-phase-equivalence.test.ts`, which digests
the piece paths of 11 `none`/`classic` generator configurations, and
`src/puzzle/topology/traced-geometry-digest.test.ts`, which digests 5
traced configurations (#574) — the latter also guards the traced-only
splice path (`spliceSmoothedFromPath` and friends) against in-repo
retunes, which no other test would catch.

A red digest in either means something moved generated geometry. Work out
what, and decide whether to take or pin the change — do **not** re-record.
Those digests are external snapshots, so `vitest -u` rewrites them all
without a word and takes the alarm with them.

## Keep `main.ts` an entry point

`src/main.ts` is loaded by `index.html` as a side-effecting module, so
nothing in it can be imported or called by a test — importing it would boot
the app. It reached 1939 lines because it was also the composition root, and
every feature appended to it.

The composition root is now `src/app/bootstrap.ts`, which exports a function,
runs nothing on import, and has tests (`bootstrap.test.ts` asserts the wiring
order: global handlers first, rotation UI before the session, the `hashchange`
listener after boot is kicked off). **Put new wiring there, with a test.**

`src/main.test.ts` enforces that `main.ts` holds nothing but its two CSS
imports and the `bootstrap()` call. It is deliberately not a line-count cap —
a threshold is just a number the next feature raises by ten. If you find
yourself wanting to relax that assertion rather than clear it, the thing you
are adding belongs in `bootstrap.ts` or in a module it wires.

## Check for orphaned test workers after an interrupted run

After any interrupted or timed-out test run, check for orphaned vitest workers:

```
ps -Ao pid,ppid,%cpu,etime,command | awk '$2==1 && /vitest/'
```

Kill any whose command line points into this repo's `node_modules/vitest`.
That includes workers started from worktrees with `node_modules` symlinked
here, since their paths resolve to this checkout, not the worktree.

A worker stuck in a synchronous loop survives `pkill -f 'vitest run …'`: that
pattern matches only the parent, and the worker never notices it has gone. One
spun for three days and exhausted the Mac mini's memory. To stop a hung run,
stop the whole background task or process group, not a pattern match.
The watchdog in `src/test-helpers/vitest-setup.ts` kills such workers within
a second or two, but check anyway: it can't help if it never started.
