# Vela-pinets

The PineTS scripting engine for the [Vela](https://github.com/LuxAlgo/Vela) charting
library — Pine Script indicators executed in-process (`PineEngine`) or off the main
thread (`PineWorkerEngine`), plugged into Vela's public `ScriptingEngine` port.

```ts
import { Vela } from '@luxalgo/vela';
import { PineEngine } from '@luxalgo/vela-pinets';

const chart = new Vela('#chart', { symbol: 'BTCUSDT', timeframe: '60' });
chart.registerEngine('pine', new PineEngine());
chart.addIndicator(`//@version=5
indicator("EMA 20", overlay=true)
plot(ta.ema(close, 20), color=color.orange)`);
```

- **`PineEngine`** — in-process: the simplest setup; needs the `pinets` peer installed.
- **`PineWorkerEngine`** — the same Pine semantics in a Web Worker (source inlined at
  build time, spawned from a Blob URL): heavy scripts never block the chart.
- **Browser builds** — `vela-pinets.global.js` / `.global.min.js` expose
  `window.VelaPinets` for script-tag usage; load `vela.global.js` first.

## Development

```
npm install
npm run playground   # http://localhost:5192 — Vela widget + this engine, HMR
npm run typecheck && npm run lint && npm run test && npm run build
```

Vela is consumed as `file:../Vela` (built dist): clone this repo next to
[Vela](https://github.com/LuxAlgo/Vela) and build Vela first.

## License

[AGPL-3.0](LICENSE) — this package depends on `pinets`, which is AGPL-3.0 licensed.
The Vela charting library itself is Apache-2.0.
