# Agent Guide

Working guide for an AI agent contributing to Vela-pinets. **"The user"** means the human
directing the work. Vela-pinets is the PineTS scripting-engine addon for the Vela charting
library — read Vela's own `AGENTS.md` (../Vela) first: its working loop, gate discipline,
verification rules, and prose rules all apply here unchanged. This file only adds what is
specific to this package.

---

## What this package is

The Pine Script execution engines — `PineEngine` (in-process) and `PineWorkerEngine`
(worker-backed, its worker source inlined at build time and spawned from a Blob URL) —
implemented ENTIRELY against Vela's public engine-authoring surface: the `ScriptingEngine`
port, the model vocabulary, the `stableSeriesId` identity contract and the semantic
palette, all imported from `@luxalgo/vela/plugin`. A host registers an engine per chart
(`chart.registerEngine('pine', new PineEngine())`, or the widget's
`engines: { pine: () => new PineWorkerEngine() }`).

**The licensing boundary is the reason this code lives in its own repo**: `pinets` is
AGPL-3.0, so this package is AGPL-3.0 — while Vela itself stays Apache-2.0 and carries no
Pine code (its lint ACL bans the `pinets` import outright). This package is now Pine's
ONLY home: Vela's in-tree engines were deleted once these proved equivalent. Never move
code across that boundary in either direction without the user's explicit decision.

## Ground rules specific to this package

- **`@luxalgo/vela` is consumed as a package** (`file:../Vela`, built dist through its
  exports map). To see a Vela change here, rebuild Vela (`npm run build` there).
  Engine sources import runtime values from `@luxalgo/vela/plugin` only; tests and the
  playground may import `Vela`/`VelaWidget` entries too. Nothing ever reaches into
  `../Vela/src` internals.
- **Parity is the contract.** These engines replaced Vela's in-tree ones (now deleted
  there); identical Pine semantics is the promise. Behavior is pinned by this repo's unit
  tests and by the workspace oracle suite (`oracle-tests/vela-pinets`), which owns the
  Pine scenario catalog and runs it through BOTH engines — run it after every meaningful
  change (build Vela AND this repo first; see the workspace `AGENTS.md`). Since Vela ships
  no engine, that suite is also **Vela's** render oracle: a Vela renderer or model change
  is verified through here.
- **The two engines must stay behaviorally identical.** `PineEngine` and
  `PineWorkerEngine` share `src/pinets/runtime.ts` — new engine behavior belongs there (or
  deeper), never in one engine's wrapper only. `src/pinets-worker/protocol.ts` is the
  worker ABI; keep it in lockstep with `worker.ts` + `PineWorkerEngine.ts`.
- **The `inline-worker:` scheme has three resolvers** — tsup plugin (production build),
  vite plugin (playground), vitest stub (tests inject fake workers). A change to the
  worker bundling semantics must land in tsup + vite together (the stub stays empty).
- **The worker is a separate execution context.** Its nested build bundles its own pinets
  and the few `@luxalgo/vela/plugin` values it uses — that duplication is by design; never
  try to "share" the main thread's module graph with it. In the browser-global builds
  (`vela-pinets.global(.min).js`, `window.VelaPinets`), `@luxalgo/vela` maps to the page's
  `window.Vela` instead — the page must load `vela.global.js` first.

## The gate

`npm run typecheck` · `npm run lint` · `npm run test` · `npm run build` — all four, after
every meaningful change, plus the playground proof for anything a browser can observe.

## The playground

`npm run playground` → http://localhost:5192 (Vela OS uses 5190, Vela-pro 5191) — the Vela
widget + Binance provider (public API, no key, no server) with Pine served by THIS
package's `PineWorkerEngine`, engine sources straight from `src/` (vite, HMR). An EMA is
on from the first paint; `window.__workerSpawns >= 1` proves Pine runs off the main
thread. The **"Code" topbar entry** (right-hand cluster) opens a popup — a plain textarea,
Run, and an inline status — that executes arbitrary Pine through the addon engine via
`chart.runIndicator` (injected only on success, so a failing script shows its compile or
runtime error instead of leaving a dead legend row). It is the fastest way to try a
script against the engine, and it doubles as the SDK showcase (contributed widget action
+ kit `Dialog`). Every option the page does not set sits in it commented at its default —
uncomment to explore rather than hunting the docs.

Verification rules from Vela's guide apply with full force: prove painted reality
(canvas pixel sampling, real network entries), not element presence.
