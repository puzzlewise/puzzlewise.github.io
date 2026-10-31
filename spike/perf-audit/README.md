Scripts from the 2026-10-31 performance audit of `8e17e47f` (#685, sub-issues #686–#689).

| Dir | Area | Issues |
|---|---|---|
| `gen/` | Generation benchmarks, CPU profiles, the exact-equivalence `reduce()`/`bbox()` prototypes, and `vsetup/` (a vitest config + setup file that patches bezier-js and runs the repo's tests unmodified) | #686 |
| `render/` | GPU/compositor measurements: layer memory, frame stages per outline preset, relayer, merge pulse | #687, #688 |
| `load/` | Cold/warm load scenarios; `scripts/serve2.cjs` is the throttling server (CDP network throttling doesn't apply to service-worker traffic); `proto-src.diff` is the preload/deferred-SW prototype | #689 |
| `interact/` | Per-event JS profiles, long tasks, `s8-proto.js` (dirty-check + rAF render and z-index bring-to-front prototypes, patched in-page) | #685 |
| `memory/` | Leak runs across and within games, storage sizes, idle traces | #685 |

The scripts were written as one-off probes, not tooling. They hard-code absolute paths: the repo at `/Users/bot/src/puzzle`, Playwright from `/Users/bot/.npm/_npx/e41f203b7505f1fb/node_modules/playwright`, and per-area dev-server ports 5201–5205. Run Node through fnm so `.nvmrc` (Node 22) applies.
