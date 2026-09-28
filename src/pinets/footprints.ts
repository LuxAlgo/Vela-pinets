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
 * Bars the source cannot serve are omitted; the script reads `na` for them.
 */
export type FootprintSource = (symbol: string, timeframe: string, range: FootprintRange) => Promise<FootprintBar[]>;

/**
 * The optional `getFootprintData` member of a PineTS market-data provider, bound to
 * a host source — or NOTHING when the host has none, so PineTS's own capability
 * check (`typeof source.getFootprintData === 'function'`) stays the single switch.
 * Spread it into a provider object.
 */
export function footprintSurface(source: FootprintSource | undefined, chartSymbol: () => string, chartTimeframe: () => string): FootprintSurface {
    if (!source) return {};
    return {
        getFootprintData: (symbol, timeframe, limit, sDate, eDate) =>
            source(plainSymbol(symbol ?? chartSymbol()), timeframe ?? chartTimeframe(), { from: sDate, to: eDate, limit }),
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
