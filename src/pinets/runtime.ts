import { PineTS, Indicator } from 'pinets';
import type {
    PreparedScript,
    ExecutionMarket,
    VisibleBarRange,
    FetchSeries,
    EngineAlert,
    EngineWarning,
} from '@luxalgo/vela/plugin';
import type { OHLCV } from '@luxalgo/vela/plugin';
import type { InputValue, InputSchema } from '@luxalgo/vela/plugin';
import type { IndicatorModel } from '@luxalgo/vela/plugin';
import { normalizeContext, declarationExecuted } from './normalizeContext';
import { toScene } from './toScene';
import { mapInputs } from './inputsMeta';
import { mapProps, applyProps } from './propsMeta';
import { ensurePineTablePatch } from './tablePatch';
import { ensurePineMarkerPatch } from './markerPatch';

/**
 * The transport-agnostic PineTS runtime: parse a script, run it once over bars,
 * and map the PineTS context to the neutral model. Shared by the in-process
 * `PineEngine` and the worker-backed `PineWorkerEngine` — neither the bars source
 * nor `fetchSeries` care whether they're in-process or across a worker boundary,
 * so the same code runs in both. This (with the `pinets/` mapper) is the only PineTS
 * coupling; everything above it is neutral.
 */

/** One static run's neutral result. */
export interface PineRunResult {
    /**
     * The neutral model — or null when the run never executed the script body (zero
     * bars: empty initial load, unresolved symbol). Such a run carries no declaration,
     * so mapping it would fabricate default metadata (`title: "Indicator"`,
     * `overlay: false`) that contradicts the static scan and would strand the
     * indicator's pane routing in the host. Callers emit NOTHING for a null model and
     * let the session re-run when bars arrive.
     */
    model: IndicatorModel | null;
    alerts: EngineAlert[];
    warnings: EngineWarning[];
    reactsToViewport: boolean;
    /** The raw run context — engines derive read-only snapshots from it (never exposed live). */
    ctx: unknown;
}

/** A reusable PineTS Indicator instance, recreated only when the input-set changes. */
export interface IndicatorCache {
    lastKey?: string;
    lastInd?: InstanceType<typeof Indicator>;
}

/** The serializable identity of a prepared script (safe to cross a worker boundary). */
export interface PineToken {
    source: string;
    instanceId: string;
    /**
     * The declaration's `overlay` when the AST scan resolved it to a literal (named or
     * positional); absent for a computed/variable value. Carried on the token so
     * {@link pineCtxToModel} can pin every computed model's pane routing to the
     * DECLARATION — the runtime context is a lossy source for it (see there).
     */
    declaredOverlay?: boolean;
}

/**
 * Which scripts publish a declaration-props schema (the settings dialog's
 * "Properties" tab): every script, only `strategy()` scripts, or none.
 * Presentation-only — hidden props keep their source/spec values at run time,
 * and programmatic `setProps` overrides still apply.
 */
export type PropsVisibility = 'all' | 'strategy' | 'none';

/**
 * What the engines' `props` option accepts: a visibility mode, or an explicit
 * WHITELIST of prop keys — only those entries are published, in the LIST's
 * order, so the host controls both the subset and the layout of the Properties
 * tab. A script owning none of the whitelisted keys (e.g. an `indicator()`
 * under a strategy-only list) publishes no schema and gets no tab at all.
 */
export type PropsFilter = PropsVisibility | readonly string[];

/** The props schema `prepare` publishes under a filter (see {@link PropsFilter}). */
function propsFor(scanned: InstanceType<typeof Indicator>, defaultProps: Record<string, InputValue> | undefined, filter: PropsFilter): InputSchema[] {
    if (filter === 'none') return [];
    if (filter === 'strategy' && scanned.getDeclarationType() !== 'strategy') return [];
    const all = mapProps(scanned, defaultProps);
    if (typeof filter === 'string') return all;
    const byKey = new Map(all.map((p) => [p.key, p]));
    return filter.map((key) => byKey.get(key)).filter((p): p is InputSchema => p !== undefined);
}

/** Parse a Pine source: inputs + declaration-props schemas + metadata + viewport-dependence.
 *  No market data. `defaultProps` = the engine's configured prop defaults, folded into the
 *  props schema's effective `defval`s (beneath source-declared values); `propsVisibility`
 *  gates which scripts publish the schema — and which entries (default: every script,
 *  every mutable prop). */
export function preparePine(source: string, instanceId: string, defaultProps?: Record<string, InputValue>, propsVisibility: PropsFilter = 'all'): PreparedScript {
    const scanned = Indicator.from(source);
    const inputs = mapInputs(scanned.getInputsMeta());
    const props = propsFor(scanned, defaultProps, propsVisibility);
    // The declared overlay comes from the same AST scan that feeds the props schema:
    // `scanned.prop` lays the declaration call's resolved args over the spec defaults,
    // handling named AND positional forms and never matching comments, string literals,
    // or a plot's `force_overlay` — the raw-source regex this replaces mis-routed all of
    // those (`indicator("I", "i", true)` mounted its placeholder in a sub pane, then
    // jumped to the price pane when the first computed model landed). A non-boolean scan
    // means the script passes a variable the scanner can't resolve — keep the literal
    // regex as the placeholder guess (word-bounded: a `my_overlay = true` assignment must
    // not match), and leave `declaredOverlay` unset so the computed model keeps the
    // runtime's own answer.
    const scannedOverlay = scanned.prop.overlay;
    const declaredOverlay = typeof scannedOverlay === 'boolean' ? scannedOverlay : undefined;
    const overlay = declaredOverlay ?? /(?<![\w.$])overlay\s*[:=]\s*true/.test(source);
    // strategy() declares exactly like indicator() — without the alternative, every
    // strategy script showed a placeholder "Indicator" legend title until its first run.
    // The title argument comes in two shapes — positional (`indicator("X")`) and named
    // (`indicator(title = "X")`) — and the string itself may hold the OTHER quote or
    // escapes; missing any of these left the generic "Indicator" on the loading legend
    // for the script's whole first compute. Anchored to a line start so a commented-out
    // declaration above the real one can never win.
    const declared = /^\s*(?:indicator|strategy)\s*\(\s*(?:title\s*=\s*)?(["'])((?:\\.|(?!\1).)*)\1/m.exec(source)?.[2];
    const title = declared?.replace(/\\(.)/g, '$1').trim() || 'Indicator';
    // Statically detect viewport dependence so the orchestrator can route:
    // viewport-dependent scripts keep the (debounced) full-run path; others stream.
    const reactsToViewport = /chart\.(left|right)_visible_bar(_time)?\b/.test(source);
    const token: PineToken = { source, instanceId, ...(declaredOverlay !== undefined ? { declaredOverlay } : {}) };
    return { language: 'pine', inputs, ...(props.length > 0 ? { props } : {}), meta: { title, overlay }, reactsToViewport, token };
}

/**
 * A fresh Indicator per (input, prop)-set: PineTS bakes input overrides at construction
 * and prop overrides via `.prop` writes, so reuse the last instance when both bags are
 * unchanged (live ticks / re-runs) to avoid re-transpiling on every poke.
 */
export function indicatorFor(cache: IndicatorCache, source: string, inputs: Record<string, InputValue>, props: Record<string, InputValue> = {}): InstanceType<typeof Indicator> {
    const key = JSON.stringify([inputs, props]);
    if (cache.lastKey !== key || !cache.lastInd) {
        const ind = new Indicator(source, inputs);
        applyProps(ind, props);
        cache.lastInd = ind;
        cache.lastKey = key;
    }
    return cache.lastInd;
}

/** Run a prepared script once over `bars`, returning the neutral model + alerts/warnings. */
export async function runPineStatic(opts: {
    ind: InstanceType<typeof Indicator>;
    bars: OHLCV[];
    market: ExecutionMarket;
    visibleRange: VisibleBarRange | undefined;
    prepared: PreparedScript;
    instanceId: string;
    inputs: Record<string, InputValue>;
    props?: Record<string, InputValue>;
    fetchSeries: FetchSeries | undefined;
}): Promise<PineRunResult> {
    const { ind, bars, market, visibleRange, prepared, instanceId, inputs, props, fetchSeries } = opts;
    ensurePineTablePatch();
    ensurePineMarkerPatch();
    const klines = toKlines(bars, market.timeframe, market.symbolInfo);
    // The virtual provider: serve the chart's own series in-memory (the bars Vela
    // owns), but route any OTHER (symbol, timeframe) — i.e. request.security HTF/LTF/
    // cross-symbol — back to Vela's cache-backed gateway. PineTS reuses this same
    // provider for its secondary contexts, so MTF data is real and timeframe-separated.
    const source = {
        getMarketData: (sym?: string, tf?: string, limit?: number, sDate?: number, eDate?: number) =>
            isChartSeries(sym, tf, market) ? Promise.resolve(klines) : secondaryKlines(fetchSeries, sym, tf, limit, sDate, eDate, syminfoForSymbol(market, sym)),
        getSymbolInfo: async (sym?: string) => syminfoForSymbol(market, sym),
    };
    const pine = new PineTS(source as never, chartTickerOf(market), market.timeframe, klines.length);
    await pine.ready();
    // Feed the chart viewport so `chart.left/right_visible_bar_time` resolve to the
    // visible window; a no-op for scripts that don't reference those built-ins.
    if (visibleRange) pine.setVisibleRange(visibleRange.left, visibleRange.right);
    const ctx = (await pine.run(ind)) as PineCtx;
    const reactsToViewport = typeof pine.usesVisibleRange === 'function' ? pine.usesVisibleRange() : false;

    return {
        model: declarationExecuted(ctx) ? pineCtxToModel(ctx, instanceId, prepared, inputs, props ?? {}, bars[0]?.time) : null,
        alerts: (ctx.alerts ?? []).map(mapAlert),
        warnings: (ctx.warnings ?? []).map(mapWarning),
        reactsToViewport,
        ctx, // raw run context — engines derive read-only snapshots from it (never exposed live)
    };
}

/**
 * Map a PineTS run/stream context to the neutral indicator model. `anchorTime` is the
 * time of the FIRST bar this run executed over — index-aligned renderers align the
 * model's dense arrays and `bar_index` drawings to the chart through it (offset 0 when
 * the run spanned the whole chart, the norm).
 */
export function pineCtxToModel(ctx: unknown, instanceId: string, prepared: PreparedScript, inputs: Record<string, InputValue>, props: Record<string, InputValue>, anchorTime?: number): IndicatorModel {
    const { model } = toScene(normalizeContext(ctx), instanceId);
    // Pane routing must follow the DECLARATION. Vela re-routes an indicator's pane when
    // the first computed model's `overlay` disagrees with the prepared meta, and the
    // runtime context is a lossy source for that flag — the strategy runtime drops
    // positional declaration args, so `strategy("S", "s", true)` executes with
    // `config.overlay: false` and would tear the placeholder off the price pane. The
    // statically scanned declaration is the truth; a host's prop override
    // (`setProps({ overlay })`, mutable per the Pine spec) is the one legitimate
    // runtime divergence and stays on top of it.
    const overlay = typeof props.overlay === 'boolean' ? props.overlay : (prepared.token as PineToken).declaredOverlay;
    if (overlay !== undefined) {
        model.overlay = overlay;
        model.paneHint = overlay ? 'price' : 'new';
    }
    model.inputs = prepared.inputs;
    model.inputValues = { ...defaultsOf(prepared.inputs), ...inputs };
    if (prepared.props) {
        model.props = prepared.props;
        model.propValues = { ...defaultsOf(prepared.props), ...props };
    }
    if (anchorTime != null) model.anchorTime = anchorTime;
    return model;
}

/** `HHMM-HHMM` → minutes-of-day span (wraps midnight when start > end, e.g. the
 *  futures trading day `1700-1600`); null for anything else (`24x7`, the synthesized
 *  `regular`, absent) — callers treat null as "no session vocabulary". */
function sessionSpan(s: unknown): { start: number; end: number } | null {
    if (typeof s !== 'string') return null;
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
    if (!m) return null;
    return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}

const inSpan = (m: number, s: { start: number; end: number }): boolean => (s.start <= s.end ? m >= s.start && m < s.end : m >= s.start || m < s.end);

/** Timezone offset per (tz, hour) via Intl, cached — one Intl call per distinct hour of
 *  data keeps a 10k-bar series in the sub-millisecond range. */
const tzOffsetCache = new Map<string, number>();
function wallMinuteOfDay(ts: number, tz: string): number | null {
    const key = `${tz}:${Math.floor(ts / 3_600_000)}`;
    let off = tzOffsetCache.get(key);
    if (off == null) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ts);
            const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
            off = Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - ts) / 60_000);
        } catch {
            off = NaN;
        }
        if (tzOffsetCache.size > 100_000) tzOffsetCache.clear();
        tzOffsetCache.set(key, off);
    }
    if (Number.isNaN(off)) return null;
    return ((Math.floor(ts / 60_000) + off) % 1440 + 1440) % 1440;
}

/** Chart timeframe → minutes, for the closeTime cap. Intraday and daily only — W/M
 *  session closes need trading-day grouping this template-local pass cannot do, so
 *  they (like unknown spellings) keep the engine's own `open + tf` net. */
function tfMinutesFor(tf: string | undefined): number | null {
    if (tf == null) return null;
    if (/^\d+$/.test(tf)) return Number(tf);
    if (/^1?D$/i.test(tf)) return 1440;
    return null;
}

/**
 * The per-bar SESSION close for a series on a session market — TV convention, and what
 * the engine's kline contract asks providers for: `min(open + tf, the declared session
 * window's end)`. A daily bar labeled at the session open closes at the session end
 * (08:30 → 15:15), the last intraday bucket runs short (15:00 + 1h → 15:15), and a
 * trading-day roll span (`1700-1600`) closes next-day. Which window rules — regular or
 * extended — is read off the BARS themselves: any bar outside the regular span means
 * the series is the extended tape. Template-local like the widget's session shading:
 * holidays/early closes are deliberately NOT recomputed here (the resolved calendar
 * stays the truth for consumers that need them), and a bar outside every declared
 * window falls back to the engine's `open + tf` net. DST transitions inside one bar's
 * open→close span keep the offset of the open (off by the jump on those bars, twice a
 * year).
 */
function sessionCloser(bars: OHLCV[], tf: string | undefined, syminfo: unknown): ((openMs: number) => number | null) | null {
    // `unknown` on purpose: callers hand over whatever symbol-info shape their feed
    // declares (the port type varies across host versions) — one narrowing here keeps
    // every call site assertion-free under either set of typings.
    const si = typeof syminfo === 'object' && syminfo != null ? (syminfo as Record<string, unknown>) : null;
    const tfMin = tfMinutesFor(tf);
    const regular = sessionSpan(si?.session);
    const tz = typeof si?.timezone === 'string' ? si.timezone : null;
    if (tfMin == null || regular == null || tz == null || bars.length === 0) return null;
    const extended = sessionSpan(si?.session_extended);
    let active = regular;
    if (extended) {
        for (const b of bars) {
            const m = wallMinuteOfDay(b.time, tz);
            if (m != null && !inSpan(m, regular) && inSpan(m, extended)) {
                active = extended;
                break;
            }
        }
    }
    return (openMs: number): number | null => {
        const m = wallMinuteOfDay(openMs, tz);
        if (m == null || !inSpan(m, active)) return null;
        const untilEnd = (active.end - m + 1440) % 1440 || 1440;
        return openMs + Math.min(tfMin, untilEnd) * 60_000;
    };
}

/** OHLCV → PineTS kline shape (openTime-keyed). With a chart timeframe and a
 *  session-market syminfo, each kline carries its session {@link sessionCloser | closeTime}
 *  — continuous markets (and W/M) emit none and the engine's `open + tf` net applies. */
export function toKlines(bars: OHLCV[], tf?: string, syminfo?: unknown): Array<Record<string, number>> {
    const closer = sessionCloser(bars, tf, syminfo);
    return bars.map((b) => {
        const k: Record<string, number> = { openTime: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
        const ct = closer?.(b.time);
        if (ct != null) k.closeTime = ct;
        return k;
    });
}

/**
 * The ticker the CHART SERIES is addressed by — THE CHART TYPE IS THE TICKER, the single
 * channel through which PineTS learns it. On a bar-transforming style the chart's data
 * is its derived view, so the chart ticker is the EXTENDED ticker (`"SYM;heikinashi"`):
 * PineTS derives `chart.is_heikinashi` + the `syminfo.tickerid` suffix from it, and a
 * PLAIN same-symbol request becomes unambiguous — it can only mean STANDARD data
 * (routed through the gateway), never the in-memory view. Without this,
 * `security(ticker.standard(...), <chart tf>, …)` would collide with the chart series
 * and silently receive derived bars. Only the bar-transforming style matters — every
 * other Vela price style draws standard data.
 */
export function chartTickerOf(market: ExecutionMarket): string {
    return market.chartStyle === 'heikinashi' ? `${market.symbol};heikinashi` : market.symbol;
}

/** True when PineTS is asking for the chart's own series (served in-memory) — addressed by {@link chartTickerOf}. */
export function isChartSeries(sym: string | undefined, tf: string | undefined, market: ExecutionMarket): boolean {
    return (sym == null || sym === chartTickerOf(market)) && (tf == null || tf === market.timeframe);
}

/** Klines for a secondary (non-chart) series via Vela's cache-backed gateway. */
export async function secondaryKlines(
    fetchSeries: FetchSeries | undefined,
    sym: string | undefined,
    tf: string | undefined,
    limit?: number,
    sDate?: number,
    eDate?: number,
    syminfo?: Record<string, unknown>,
): Promise<Array<Record<string, number>>> {
    if (!fetchSeries || !sym || !tf) return [];
    const bars = await fetchSeries(sym, tf, { from: sDate, to: eDate, limit });
    return toKlines(bars, tf, syminfo);
}

/** The streaming provider a live PineTS session polls (see {@link makeLiveProvider}). */
export interface LiveProvider {
    markDirty(): void;
    getMarketData(ticker: string, tf: string, limit?: number, sDate?: number, eDate?: number): Promise<unknown[]>;
    getSymbolInfo(ticker?: string): Promise<Record<string, unknown>>;
}

/**
 * A provider adapter that serves the chart's OWN live bars to a streaming PineTS
 * instance (no extra network). Dedupes so the stream only re-executes when the
 * bars actually change (or when `markDirty()` forces it, e.g. on a visible-range
 * change). Mirrors `IProvider.getMarketData(ticker, tf, limit, sDate, eDate)`:
 * `sDate == null` = the stream's initial full-history load; non-null = a live
 * poll for the tail, where an EMPTY result means "no change — skip execution".
 * Shared by the in-process live engine and the worker's streaming session (the
 * only difference is how `getBars` is backed: a closure vs a message-fed array).
 */
export function makeLiveProvider(getBars: () => OHLCV[], getMarket: () => ExecutionMarket, fetchSeries: FetchSeries | undefined): LiveProvider {
    let lastKey = '';
    let dirty = false;
    return {
        markDirty: () => {
            dirty = true;
        },
        getMarketData: async (ticker, tf, limit, sDate, eDate) => {
            // Secondary series (request.security HTF/LTF/cross-symbol) → cache-backed gateway.
            const market = getMarket();
            if (!isChartSeries(ticker, tf, market)) {
                return secondaryKlines(fetchSeries, ticker, tf, limit, sDate, eDate, syminfoForSymbol(market, ticker));
            }
            const klines = toKlines(getBars(), market.timeframe, market.symbolInfo);
            // Initial load (no sDate): full history.
            if (sDate == null) return klines;
            // Streaming update: only the forming candle + any newer bars.
            const tail = klines.filter((k) => (k.openTime ?? 0) >= sDate);
            const last = tail[tail.length - 1];
            const sig = last ? `${tail.length}|${last.openTime}|${last.close}|${last.high}|${last.low}|${last.volume}` : '';
            if (!dirty && sig === lastKey) return []; // unchanged → no re-execution
            dirty = false;
            lastKey = sig;
            return tail;
        },
        getSymbolInfo: async (ticker) => syminfoForSymbol(getMarket(), ticker),
    };
}

/** A running live stream (see {@link openLiveStream}). */
export interface LiveStreamHandle {
    stop(): void;
    setVisibleRange(left: number, right: number): void;
    /** Force the next poll through the provider's dedupe (e.g. after a viewport change). */
    markDirty(): void;
    /** The most recent raw run context (null before the first streamed evaluation). */
    lastCtx(): unknown;
}

/**
 * Open ONE persistent streaming PineTS session over the caller's bars: PineTS polls the
 * {@link makeLiveProvider} adapter (its dedupe makes quiet polls free) and re-executes only
 * the forming/new bars per tick; each emission maps to a neutral model stamped with the
 * stream's anchor (its first bar — the history is frozen at open, so a deepened chart needs
 * a REOPEN, not a poke). Shared by the in-process live engine and the worker's live
 * sessions — the transport differs, the session logic doesn't.
 */
export function openLiveStream(opts: {
    token: PineToken;
    cache: IndicatorCache;
    prepared: PreparedScript;
    inputs: Record<string, InputValue>;
    props?: Record<string, InputValue>;
    bars: () => OHLCV[];
    market: () => ExecutionMarket;
    fetchSeries?: FetchSeries;
    visibleRange?: VisibleBarRange;
    onModel(model: IndicatorModel): void;
    onAlert?(alert: EngineAlert): void;
    onWarning?(warning: EngineWarning): void;
    onError?(error: Error): void;
}): LiveStreamHandle {
    const bars = opts.bars();
    ensurePineTablePatch();
    ensurePineMarkerPatch();    
    const ind = indicatorFor(opts.cache, opts.token.source, opts.inputs, opts.props ?? {});
    const anchorTime = bars[0]?.time;
    // pageSize = full length: the initial drain must emit ONE complete model (a smaller
    // page would mount a partial one); ≥1 so an empty array can't zero the page size.
    const initialLen = Math.max(1, bars.length);
    const provider = makeLiveProvider(opts.bars, opts.market, opts.fetchSeries);
    const pine = new PineTS(provider as never, chartTickerOf(opts.market()), opts.market().timeframe, initialLen);
    if (opts.visibleRange) pine.setVisibleRange(opts.visibleRange.left, opts.visibleRange.right);
    const evt = pine.stream(ind, { live: true, interval: 1000, pageSize: initialLen }) as {
        on(e: string, cb: (arg: unknown) => void): void;
        stop(): void;
    };
    let stopped = false;
    let lastCtx: unknown = null;
    evt.on('data', (ctx) => {
        if (stopped) return;
        lastCtx = ctx;
        // A tick that never executed the script body (a stream opened over zero bars)
        // carries no declaration — emit nothing rather than a fabricated default model
        // (same rule as runPineStatic's null model).
        if (!declarationExecuted(ctx)) return;
        try {
            opts.onModel(pineCtxToModel(ctx, opts.token.instanceId, opts.prepared, opts.inputs, opts.props ?? {}, anchorTime));
        } catch (err) {
            opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
    });
    evt.on('alert', (a) => opts.onAlert?.(mapAlert(a as never)));
    evt.on('warning', (w) => opts.onWarning?.(mapWarning(w as never)));
    evt.on('error', (e) => opts.onError?.(e instanceof Error ? e : new Error(String(e))));
    return {
        stop: () => {
            stopped = true;
            evt.stop();
        },
        setVisibleRange: (left, right) => {
            pine.setVisibleRange(left, right);
            provider.markDirty();
        },
        markDirty: () => provider.markDirty(),
        lastCtx: () => lastCtx,
    };
}

/** syminfo for a (possibly secondary) symbol — synthesizes per-symbol when it differs from the chart. */
export function syminfoForSymbol(market: ExecutionMarket, sym: string | undefined): Record<string, unknown> {
    // A secondary symbol may arrive as an extended ticker ("SYM;heikinashi"); synthesize
    // the display fields from the PLAIN symbol (the modifier is a data-routing marker,
    // not part of the instrument's identity).
    const plain = sym ? sym.split(';')[0]! : sym;
    return plain && plain !== market.symbol ? syminfoFor({ symbol: plain, timeframe: market.timeframe }) : syminfoFor(market);
}

/** Symbol info for execution: prefer the feed's, else synthesize from the ticker. */
function syminfoFor(market: ExecutionMarket): Record<string, unknown> {
    if (market.symbolInfo) return market.symbolInfo;
    const symbol = market.symbol;
    const base = symbol.replace(/(USDT|USDC|USD|PERP|BUSD)$/i, '') || symbol;
    return {
        ticker: symbol,
        tickerid: symbol,
        main_tickerid: symbol,
        description: symbol,
        prefix: '',
        root: symbol,
        type: 'crypto',
        basecurrency: base,
        currency: 'USD',
        timezone: 'UTC',
        session: 'regular',
        mintick: 0.01,
        minmove: 1,
        pointvalue: 1,
        pricescale: 100,
    };
}

interface PineCtx {
    alerts?: RawAlert[];
    warnings?: RawWarning[];
}
interface RawAlert {
    id?: unknown;
    message?: unknown;
    title?: string;
    time?: unknown;
    bar_index?: unknown;
    freq?: string;
}
interface RawWarning {
    message?: unknown;
    method?: string;
    bar?: unknown;
}

function defaultsOf(inputs: PreparedScript['inputs']): Record<string, InputValue> {
    const out: Record<string, InputValue> = {};
    for (const input of inputs) out[input.key] = input.defval;
    return out;
}

export function mapAlert(a: RawAlert): EngineAlert {
    return {
        id: String(a.id ?? ''),
        message: String(a.message ?? ''),
        title: a.title,
        time: Number(a.time ?? 0),
        barIndex: Number(a.bar_index ?? 0),
        freq: a.freq,
    };
}

export function mapWarning(w: RawWarning): EngineWarning {
    return { message: String(w.message ?? ''), method: w.method, bar: Number(w.bar ?? 0) };
}
