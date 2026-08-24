# Changelog

All notable changes to Vela-pinets, newest first.

## [Unreleased]

### Fixed

- **Plot arguments render with Pine's semantics.** `display` now controls pane
  visibility across the plotting functions: a plot declared
  `display.status_line`, `display.price_scale`, or `display.data_window` stays
  off the chart (previously the first two still painted), and `display.none` is
  honored by `hline()`, `fill()`, `plotshape()`/`plotchar()`, `bgcolor()`, and
  `barcolor()` too. `trackprice = true` extends the plot's latest value across
  the pane as a dotted level line — including the level-only idiom with
  `display.none`. `show_last = N` draws only the last N bars of a plot (lines,
  histograms, shapes, candles, backgrounds, and bar colors alike). `histbase`
  re-bases `style_histogram` / `style_columns` / `style_area` plots instead of
  always growing from zero. An `hline()` without a `linestyle` defaults to
  dashed (and an explicit `hline.style_solid` stays solid), and a plain
  `plot()` defaults to line width 1, both as Pine defines them.
- **`na` and `color(na)` act as invisible colors.** A `plot()` whose color
  evaluates to `na` on some bars painted those segments in the series' fallback
  color; they are now invisible while the plotted value survives (fills keep
  their anchors and the value stays readable). A `plotshape()` / `plotchar()`
  marker whose color evaluates to `na` draws nothing on that bar. And a label
  with `color = na` keeps its declared style's placement — the bubble is simply
  not painted (pairs with the matching Vela renderer fix for the placement
  itself).

### Added

- **`force_overlay=true` now works across the plotting functions.** `plot()`,
  `plotcandle()` / `plotbar()`, `plotshape()` / `plotchar()` / `plotarrow()`, and
  `bgcolor()` carry the flag into the model, so a script in its own pane can pin
  those elements to the price pane — the drawing objects (`line.new`, `label.new`,
  `box.new`, `polyline.new`, `linefill.new`) already did, and `table.new` joins
  them. A `fill()` follows its two plots, as in Pine (where the function has no
  flag of its own and rejects plots with mixed flags): when both are forced to
  the price pane, the band renders there too.
- **Declaration props end to end.** Both engines now expose the mutable
  `indicator()` / `strategy()` declaration arguments (a strategy's
  `initial_capital`, `commission_value`, an indicator's `precision`, …) through
  Vela's new props channel: `prepare` publishes a props schema whose defaults are
  the *effective* values (source-declared ← engine default ← Pine spec),
  `capabilities.props` announces it, and prop overrides — add-time
  (`addIndicator({ props })`), live (`handle.setProps`), or edited on the settings
  dialog's new **Properties** tab — are applied via the PineTS `.prop` channel and
  replay the script. Requires `@luxalgo/vela` with props support in the
  `ScriptingEngine` port.
- **`props` visibility engine option** (`PineEngine` and `PineWorkerEngine`):
  which scripts publish the declaration-props schema — `'all'` (default), `'strategy'`
  (only `strategy()` scripts get a Properties tab), `'none'`, or an explicit
  **whitelist of prop keys**, published in the list's order, so the host controls both
  the subset and the tab's layout (a script owning none of the listed keys gets no
  tab). Presentation-only: hidden props keep their source/spec values and programmatic
  `setProps` still applies.
- **`defaultProps` engine option** (`PineEngine` and `PineWorkerEngine`):
  host-level defaults for declaration props, applied beneath source-declared
  values — a script that declares the prop keeps its own value; one that omits it
  gets the host default instead of the Pine spec one. Folded into the schema's
  defaults, so the dialog opens on them and "Reset defaults" restores them.

## [v0.2.3]

### Fixed

- **`input.source()` works again — from the settings dialog and from defaults.** pinets
  0.9.31 (now the minimum peer) resolves a runtime source override — which crosses the
  host/worker boundary as the series NAME (`'hlc3'`) — to the named series' per-bar value
  instead of handing the raw string to the script. Through this addon every `input.source`
  script was broken **on add**: Vela echoes input defaults back as overrides on start, so
  even the untouched `"close"` default reached the script as a string and every derived
  computation was `NaN`. No code change in this package — this release exists to re-freeze
  the fixed pinets into the dist, because the inlined worker bundles its **own** pinets at
  build time: npm-updating pinets in a host application never reaches `PineWorkerEngine`
  (nor the browser-global builds). The peer floor rises `>=0.9.29` → `>=0.9.31` so a
  resolvable-but-broken pinets can no longer satisfy the range; `PineEngine` (in-process,
  pinets external) picks the fix up from the host's own install as usual.

## [v0.2.0]

### Added

- **Strategies show their trades on the chart.** PineTS's broker emulator was already
  running every `strategy()` script and computing the full ledger — this package simply
  dropped it. The adapter now reads `ctx.strategy` and emits ONE execution per ORDER
  FILL as `IndicatorModel.trades`, at the fill bar and price the emulator recorded (a
  market order filled at the next bar's open shows there). Ledger slices of the same
  fill merge back together: a reversal (an entry that flips the position) paints a
  single entry marker carrying the summed quantity, and an exit order that closes
  several lots FIFO paints once. Order ids label the markers; a `comment=` replaces the
  id. Vela paints them as trade markers on the price pane (arrows + labels + fill-price
  ticks — see Vela's changelog); both engines emit them identically (the channel rides
  the model through the worker unchanged).

### Fixed

- **A strategy script now reaches the chart with its declared identity.** Three defects
  hid it before: the prepare-time title regex only matched `indicator(` (every strategy
  flashed a placeholder "Indicator" legend title), the run metadata only read
  `ctx.indicator` — never set by a strategy — so the real title AND `overlay=true` were
  dropped (an overlay strategy landed in its own pane), and the whole `ctx.strategy`
  state was discarded. The declaration now falls back to `strategy()`'s config, and an
  overlay strategy routes to the price pane like any overlay indicator.

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
