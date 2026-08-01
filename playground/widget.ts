// The replacement proof, interactive form: Vela's own widget playground page with the
// Pine engine coming from THIS package instead of Vela's in-tree one — same widget,
// same provider (Binance public API, no key), same manifest shape. Pine indicators
// behaving identically here and on Vela's playground (5190) is the point of the page.
// The "Code" topbar entry runs arbitrary Pine through the addon engine on demand.
import { VelaWidget } from '@luxalgo/vela/widget';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { registerWidgetAction, registerIcon, type WidgetContext } from '@luxalgo/vela/plugin';
import { Dialog } from '@luxalgo/vela/ui';
import { PineWorkerEngine } from '../src';

// Worker-path instrumentation: count real Web Worker spawns so a browser probe can
// PROVE Pine runs off the main thread through the addon (window.__workerSpawns >= 1).
const RealWorker = window.Worker;
(window as unknown as { __workerSpawns: number }).__workerSpawns = 0;
window.Worker = class extends RealWorker {
    constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        (window as unknown as { __workerSpawns: number }).__workerSpawns++;
    }
};

const widget = new VelaWidget('#chart', {
    symbol: 'BTCUSDT', // bare = first declared provider (binance); 'coinbase:BTC-USD' pins a venue
    timeframe: '60',
    live: true,
    theme: 'dark',
    autofocus: true, // the chart IS the page — shortcuts work from the first keystroke
    providers: { binance: () => new BinanceProvider() },
    engines: { pine: () => new PineWorkerEngine() }, // THE point of this page: Pine served by the addon
    indicators: [
        {
            name: 'EMA 20',
            enabled: true, // on from the first paint — the visible proof the addon engine plots through Vela
            script: `//@version=5
indicator("EMA 20", overlay=true)
plot(ta.ema(close, 20), color=color.orange, linewidth=2)`,
        },
        {
            name: 'RSI 14',
            enabled: false, // pick it from the indicators dialog — exercises prepare/inputs on demand
            script: `//@version=5
indicator("RSI 14", overlay=false)
plot(ta.rsi(close, 14), color=color.purple)`,
        },
    ],

    // ── The rest of the CHART options, at their defaults — uncomment to play ─────────
    // bars: 1000,                     // history depth to load (paints progressively: newest window first)
    // data: myBars,                   // offline OHLCV[] — replaces the provider entirely (no fetches, no live)
    // visibleRange: '3M',             // initial window: '1D'|'1W'|'1M'|'3M'|'6M'|'1Y'|'5Y'|'YTD'|'ALL' or {from,to} in ms
    // priceStyle: 'candles',          // 'candles'|'bars'|'line'|'area'|'baseline'|'heikinashi' or a registered chart-type id
    // volume: true,                   // the built-in volume columns (native indicator); false opts out
    // logScale: false,                // logarithmic price scale
    // currentPriceLine: true,         // dashed line + axis chip at the latest price
    // upColor: '#089981',             // bullish candles (default: the palette's bullish green)
    // downColor: '#f23645',           // bearish candles (default: the palette's bearish red)
    // glow: 0,                        // neon glow on line series, 0..~0.6 — WebGL2 backend only
    // animations: { zoom: true, pan: true }, // eased zoom + inertial pan; false disables both
    // nativeBackend: 'auto',          // 'auto' = WebGL2 when available, else canvas2d; or force either
    // renderer: NativeRenderer,       // a custom IChartRenderer class (default: the native renderer)
    // drawings: true,                 // user drawings — default: toolbar VISIBLE; false hides it (the
    //                                 //  chart.drawings API stays); {tools/groups, toolbar} customizes
    // defaultLanguage: 'pine',        // language for addIndicator calls that name none — 'pine' is what
    //                                 //  the engine above registers, so scripts need no `language`
    // height: 600,                    // px or CSS size (default: fill the container)

    // ── The rest of the SHELL options, at their defaults ──────────────────────────────
    // indicators: async () => (await fetch('/my/manifest.json')).json(), // the manifest can also
    //                                 //  be an ASYNC LOADER (filesystem, authenticated API, …)
    // timeframes: ['1', '5', '15', '60', '240', 'D', 'W'], // topbar timeframe presets
    // timezone: 'Etc/UTC',            // display timezone (IANA), switchable from the bottom bar
    // statusline: true,               // chrome: the status line
    // watermark: true,                // chrome: the symbol watermark behind the candles
    // bottombar: true,                // chrome: the range-presets + timezone bar
    // persist: true,                  // restore market/config/drawings/indicators across reloads
    //                                 //  (key 'vela-widget'); storage defaults to localStorage
    // storage: memoryStorageAdapter(), // session-only persistence — from '@luxalgo/vela/workspace'
    // urlState: false,                // mirror symbol/tf/style/tz in the URL (shareable links)
});

void widget.chart.ready().then(() => console.log('[vela-pinets] chart ready — Pine served by the addon engine'));

// Handy for poking around from the browser console.
(window as unknown as { widget: VelaWidget }).widget = widget;

// ── "Code" topbar entry — paste Pine, Run it, injected on success. The editor is a
// plain textarea on purpose: what this page demos is the ENGINE, not an editor.
// `runIndicator` injects only when the run succeeds, so a failing script surfaces its
// compile/runtime error inline instead of leaving a dead legend row. ──
registerIcon(
    'code',
    '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 4.5-4 3.5 4 3.5M10.5 4.5l4 3.5-4 3.5"/></svg>',
);

// Lazy UI singletons — DOM state only, so the edited script survives a reopen. The
// WidgetContext is NEVER stored: `run(ctx)` rebinds the Run handler on every
// invocation, so the ctx lives in that closure alone and always belongs to the
// invoking widget (the pattern that keeps working in a multi-chart shell).
let codeDialog: Dialog | null = null;
let codeArea: HTMLTextAreaElement | null = null;
let codeStatus: HTMLElement | null = null;
let codeRun: HTMLButtonElement | null = null;

registerWidgetAction({
    id: 'pinets.code',
    target: 'topbar',
    label: 'Code',
    icon: 'code',
    run: (ctx) => {
        if (!codeDialog) {
            codeArea = document.createElement('textarea');
            codeArea.value = `//@version=5
indicator("My RSI", overlay=false)
plot(ta.rsi(close, 14), color=color.purple)`;
            codeArea.spellcheck = false;
            codeArea.style.cssText =
                'width:560px;max-width:80vw;height:260px;resize:vertical;background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft);border-radius:var(--vela-radius-md);padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;outline:none;';
            // Ctrl/⌘+Enter runs without leaving the keyboard (the textarea keeps plain Enter).
            codeArea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    codeRun?.click();
                }
            });
            codeRun = document.createElement('button');
            codeRun.textContent = 'Run';
            codeRun.style.cssText =
                'all:unset;margin-top:8px;padding:6px 18px;border-radius:var(--vela-radius-sm);background:var(--vela-accent);color:#0b0e14;font-weight:600;cursor:pointer;';
            codeStatus = document.createElement('div');
            codeStatus.style.cssText = 'margin-top:8px;min-height:1.3em;font-size:var(--vela-font-size-md);white-space:pre-wrap;';
            codeDialog = new Dialog({
                title: 'Run a Pine indicator',
                host: ctx.host, // first invoker's root hosts the singleton (fine for the one-widget page)
                closeOnInteractOutside: true,
                content: (body) => body.append(codeArea!, codeRun!, codeStatus!),
            });
        }
        // Rebind per invocation — `ctx` stays in this closure, no module-level context.
        codeRun!.onclick = () => void runCode(ctx);
        codeStatus!.textContent = '';
        codeDialog.show();
        setTimeout(() => codeArea?.focus(), 0);
    },
});

async function runCode(ctx: WidgetContext): Promise<void> {
    if (!codeArea || !codeStatus) return;
    codeStatus.style.color = 'var(--vela-fg-muted)';
    codeStatus.textContent = 'Running…';
    const r = await ctx.chart.runIndicator(codeArea.value);
    if (r.ok) {
        codeStatus.style.color = 'var(--vela-accent)';
        codeStatus.textContent = `✓ ${r.handle!.title || 'Indicator'} added to the chart`;
    } else {
        codeStatus.style.color = 'var(--vela-danger)';
        codeStatus.textContent = `✗ ${r.error!.message}`;
    }
}

// The widget is already built — project the freshly registered action into its topbar.
widget.refreshActions();
