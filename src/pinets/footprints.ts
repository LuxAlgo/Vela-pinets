/**
 * The host-facing order-flow seam behind Pine's `request.footprint()`.
 *
 * Vela owns bars, never order flow — so a host that HAS per-bar volume footprints
 * (a footprint-capable data provider) hands the engine a {@link FootprintSource},
 * and the engine exposes it to PineTS as the optional `getFootprintData` surface of
 * its virtual market-data provider. Without a source the surface is simply absent
 * and every `request.footprint()` call answers `na`, exactly as PineTS specifies.
 *
 * The shapes below are structurally identical to PineTS's `FootprintBar` /
 * `FootprintLevel` (declared here rather than imported so this package builds and
 * types against any pinets version — the surface only becomes REACHABLE once the
 * bundled pinets implements `request.footprint()`).
 */

/** Executed volume at one price level of a bar, split by aggressor side. */
export interface FootprintLevel {
    /** Level price — the LOW edge of the price bucket this level covers. */
    price: number;
    /** Volume executed by buy-aggressors (ask lifts) at this level. */
    buyVolume: number;
    /** Volume executed by sell-aggressors (bid hits) at this level. */
    sellVolume: number;
}

/**
 * The volume footprint of ONE chart bar, keyed by the bar's open time. Levels may
 * sit on any price grid: PineTS re-bins them into `ticks_per_row × mintick` rows
 * itself, so a source serves its finest granularity and never needs the row size.
 */
export interface FootprintBar {
    /** Bar open time, epoch ms — equals the matching bar's `time`. */
    openTime: number;
    /** Price step the levels were bucketed on. Informational only. */
    tick?: number;
    /** Price levels, any order; levels without volume may be omitted. */
    levels: FootprintLevel[];
}

/** The window PineTS asks for — mirrors its `getMarketData(…, limit, sDate, eDate)` slots. */
export interface FootprintRange {
    /** First bar open time (epoch ms), inclusive. Absent on a bare tail poll. */
    from?: number;
    /** Exclusive end (epoch ms). Absent = "up to now". */
    to?: number;
    /** Bar count of the loaded history on the initial load; absent on tail polls. */
    limit?: number;
}

/**
 * Per-bar footprints of `(symbol, timeframe)` over `range`, plain symbol (chart-type
 * modifiers never reach it: order flow is never derived). Usually the chart series,
 * but a `request.footprint()` evaluated inside `request.security()` asks for THAT
 * context's symbol and timeframe, which may differ from the chart's.
 *
 * Call pattern (PineTS's), per series: one call over the whole loaded history, then
 * — whenever the market data changes (a live tick, new bars) — a call from the
 * forming bar's open time onward. Returned bars REPLACE what PineTS holds for those
 * open times, so a live source just answers with its current state for the tail.
 * History is never asked for again within a run: a source that gains more of it
 * later says so through {@link FootprintSource.onChange}.
 * Bars the source cannot serve are omitted; the script reads `na` for them.
 */
export interface FootprintSource {
    (symbol: string, timeframe: string, range: FootprintRange): Promise<FootprintBar[]>;
    /**
     * Optional, for a source whose history arrives progressively: call `listener` whenever
     * the source can answer `(symbol, timeframe)` with more history than it last did. The
     * engine then runs the script again over its whole history. Returns the unsubscribe.
     *
     * An engine subscribes BEFORE its first ask for a series, until the script stops, so a
     * source can tell an ask that will be followed up from one that will not. Calls that
     * arrive while the script is running are folded into ONE more run: signal whenever
     * history lands.
     */
    onChange?: (symbol: string, timeframe: string, listener: () => void) => () => void;
}

/** One running script's link to its footprint source (see {@link watchFootprints}). */
export interface FootprintWatch {
    /** Ask the source, subscribing first to its change signal for that series. */
    ask(symbol: string, timeframe: string, range: FootprintRange): Promise<FootprintBar[]>;
    /** A run of the script began. `fresh`: it replaces every run begun before it (a restarted stream). */
    runStarted(fresh?: boolean): void;
    /** A run delivered its result, or failed. */
    runEnded(): void;
    /** End every subscription; later changes are not relayed. */
    stop(): void;
}

/**
 * Bind one running script to `source`: its asks pass through, and the first ask for
 * each `(symbol, timeframe)` subscribes to the source's change signal. A change calls
 * `rerun()` — unless a run is in flight, which holds an older answer: then ONE `rerun()`
 * follows it, however many changes arrived. Redoing a run at once would throw away a
 * stream's first run, so a source signalling faster than a run takes would starve the
 * script. Both engines go through this, on the thread the source lives on.
 */
export function watchFootprints(source: FootprintSource, rerun: () => void): FootprintWatch {
    const subscriptions = new Map<string, () => void>();
    let stopped = false;
    let running = 0;
    let stale = false;
    const changed = (): void => {
        if (stopped) return;
        if (running > 0) stale = true;
        else rerun();
    };
    return {
        ask(symbol, timeframe, range) {
            const key = `${symbol}\u0000${timeframe}`;
            // Its own listener per series: a source may tell subscriptions apart by it.
            if (!stopped && source.onChange && !subscriptions.has(key)) subscriptions.set(key, source.onChange(symbol, timeframe, () => changed()));
            return source(symbol, timeframe, range);
        },
        runStarted(fresh = false) {
            running = fresh ? 1 : running + 1;
            if (fresh) stale = false;
        },
        runEnded() {
            if (running === 0) return;
            running -= 1;
            if (running > 0 || !stale || stopped) return;
            stale = false;
            rerun();
        },
        stop() {
            stopped = true;
            for (const end of subscriptions.values()) end();
            subscriptions.clear();
        },
    };
}

/**
 * The optional `getFootprintData` member of a PineTS market-data provider, bound to
 * a host source — or NOTHING when the host has none, so PineTS's own capability
 * check (`typeof source.getFootprintData === 'function'`) stays the single switch.
 * Spread it into a provider object.
 *
 * `chartEnd` is where the chart's own series ends (its last bar's close). PineTS ends
 * its history ask there only when its bars carry a close time, which bars of a
 * continuous market do not: left open, the ask reads "up to now", past the end of a
 * chart that stops earlier (a replay, a symbol no longer traded). So the history ask
 * for the chart's series takes its end from `chartEnd` when PineTS gives none.
 */
export function footprintSurface(
    source: FootprintSource | undefined,
    chartSymbol: () => string,
    chartTimeframe: () => string,
    chartEnd?: () => number | undefined,
): FootprintSurface {
    if (!source) return {};
    return {
        getFootprintData: (symbol, timeframe, limit, sDate, eDate) => {
            const sym = plainSymbol(symbol ?? chartSymbol());
            const tf = timeframe ?? chartTimeframe();
            // `limit` marks the history ask: a tail poll carries none and stays open-ended.
            const ownHistory = limit != null && sym === plainSymbol(chartSymbol()) && tf === chartTimeframe();
            return source(sym, tf, { from: sDate, to: eDate ?? (ownHistory ? chartEnd?.() : undefined), limit });
        },
    };
}

/** What {@link footprintSurface} contributes to a provider object. */
export interface FootprintSurface {
    getFootprintData?(symbol?: string, timeframe?: string, limit?: number, sDate?: number, eDate?: number): Promise<FootprintBar[]>;
}

/** `"SYM;heikinashi"` → `"SYM"`: the modifier is a bar-routing marker, not part of the instrument. */
function plainSymbol(symbol: string): string {
    return symbol.split(';')[0] ?? symbol;
}
