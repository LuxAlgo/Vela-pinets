# Changelog

All notable changes to Vela-pinets, newest first.

## [v0.1.0]

### Changed

- **This package is now Pine's only home.** Vela deleted its in-tree `PineEngine` /
  `PineWorkerEngine` (they no longer exist on `@luxalgo/vela`), so a Pine script can only
  run through this addon. Nothing changed in the engine code — the extraction was already
  behavior-identical — but two consequences follow: the workspace oracle suite
  (`oracle-tests/vela-pinets`) took ownership of the Pine scenario catalog and is now
  **Vela's** render oracle as well, and any Vela renderer/model change gets verified
  through here.

### Added

- **Run Pine from the playground.** A "Code" entry in the topbar opens a popup — a plain
  textarea, Run (⌘/Ctrl+Enter too), and an inline status — that executes arbitrary Pine
  through the addon engine with `chart.runIndicator`: injected only when the run succeeds,
  so a broken script reports its error inline instead of leaving a dead legend row. No
  package code changes; the page also picks up Vela's latest option vocabulary (the
  `provider` option is gone — a bare symbol resolves by provider declaration order, an
  `EXCHANGE:` prefix pins a venue) and now lists every unused option commented at its
  default.

## [v0.0.1]

The PineTS engines, extracted from Vela into their own addon package. Vela stays
Apache-2.0 and carries no Pine code; this package is AGPL-3.0 (as `pinets` is) and plugs
into Vela's public `ScriptingEngine` port — behavior parity with the engines Vela shipped
in-tree is pinned by the unit tests and by the workspace oracle suite, which replays
Vela's Pine scenario catalog through both engines.

### Added

- **`PineEngine`** — the in-process Pine Script engine: prepare (inputs schema +
  declaration metadata), static runs and re-runs, live streaming with an incremental
  context, `request.security` (HTF/LTF/cross-symbol, extended-ticker aware) through the
  chart's data feed, viewport-dependent scripts, context snapshots.
- **`PineWorkerEngine`** — identical Pine semantics off the main thread: the worker
  source is inlined at build time and spawned from a Blob URL — no separate file, no URL
  to configure. Same protocol-pinned behavior, heavy scripts never block the chart.
- **Browser globals** — `vela-pinets.global.js` / `.global.min.js` expose
  `window.VelaPinets` for script-tag usage next to `vela.global.js` (pinets bundled;
  `@luxalgo/vela` resolves to the page's `window.Vela`, never a second copy).
