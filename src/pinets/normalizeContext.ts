import type { PineRun, PinePlot, PinePlotPoint, PineRunMeta, PineTrade } from './PineRun';
import { asString, asNumber } from './PineRun';

/** Loose view of the raw PineTS Context (only what we read). */
interface RawContext {
    fullContext?: RawContext;
    plots?: Record<string, RawPlot | undefined>;
    indicator?: Record<string, unknown>;
    strategy?: {
        config?: Record<string, unknown>;
        opentrades?: unknown[];
        closedtrades?: unknown[];
    };
}
interface RawPlot {
    title?: unknown;
    options?: Record<string, unknown>;
    data?: PinePlotPoint[];
    plot1?: unknown;
    plot2?: unknown;
}

/**
 * During streaming PineTS re-executes the forming/new bar each tick and
 * re-appends that bar's plot point WITHOUT rolling back regular plot data
 * (it rolls back drawings, not plots). So a streamed plot's `data` accumulates
 * duplicate timestamps at the tail. Keep the LAST point per timestamp (the
 * latest re-execution wins). Fast-path returns the input unchanged when there
 * are no duplicates, so first-run / static output is untouched.
 */
function dedupeByTime(data: PinePlotPoint[]): PinePlotPoint[] {
    const lastIdx = new Map<number, number>();
    let hasDup = false;
    for (let i = 0; i < data.length; i += 1) {
        const t = data[i]!.time;
        if (lastIdx.has(t)) hasDup = true;
        lastIdx.set(t, i);
    }
    if (!hasDup) return data;
    const keep = new Set(lastIdx.values());
    return data.filter((_, i) => keep.has(i));
}

/**
 * The ONE choke point for PineTS Context outer-shape drift. During streaming
 * the page `ctx.plots` is sliced and the full history lives on
 * `ctx.fullContext.plots` — so we read from `fullContext` when present.
 */
export function normalizeContext(ctx: unknown): PineRun {
    const c = (ctx ?? {}) as RawContext;
    const root = c.fullContext ?? c;
    // A strategy script never calls Core.indicator(), so `ctx.indicator` stays unset and
    // the declaration lives on `ctx.strategy.config` (same field names) — read it there,
    // or an overlay strategy lands in its own pane with a placeholder legend title.
    const declared = root.indicator ?? root.strategy?.config ?? {};

    const meta: PineRunMeta = {
        title: asString(declared.title) ?? 'Indicator',
        overlay: declared.overlay === true,
        precision: asNumber(declared.precision),
        shorttitle: asString(declared.shorttitle),
        format: asString(declared.format),
    };

    const plotsObj = root.plots ?? {};
    const plots: PinePlot[] = Object.entries(plotsObj).map(([key, raw]) => {
        const p = raw ?? {};
        const options = (p.options ?? {});
        return {
            key,
            title: asString(p.title),
            style: asString(options.style),
            options,
            data: Array.isArray(p.data) ? dedupeByTime(p.data) : [],
            plot1: asString(p.plot1) ?? asString(options.plot1),
            plot2: asString(p.plot2) ?? asString(options.plot2),
        };
    });

    const trades = root.strategy ? normalizeTrades(root.strategy) : undefined;
    return { meta, plots, ...(trades ? { trades } : {}) };
}

/**
 * The ledger as-is: closed trades first, then the still-open ones. These arrays are
 * STATE (the current ledger), not an event log — no cross-tick dedupe is needed, and a
 * partial close legitimately leaves the same trade id in both lists (the closed lot and
 * the open remainder). Malformed entries are dropped.
 */
function normalizeTrades(strategy: NonNullable<RawContext['strategy']>): PineTrade[] {
    const out: PineTrade[] = [];
    const closed = Array.isArray(strategy.closedtrades) ? strategy.closedtrades : [];
    const open = Array.isArray(strategy.opentrades) ? strategy.opentrades : [];
    for (const raw of [...closed, ...open]) {
        const t = (raw ?? {}) as Record<string, unknown>;
        const entry_price = asNumber(t.entry_price);
        const entry_time = asNumber(t.entry_time);
        const size = asNumber(t.size);
        if (entry_price === undefined || entry_time === undefined || size === undefined || size === 0) continue;
        out.push({
            id: asString(t.id) ?? `trade_${out.length}`,
            entry_id: asString(t.entry_id) ?? '',
            entry_price,
            entry_time,
            entry_comment: asString(t.entry_comment),
            exit_id: asString(t.exit_id),
            exit_price: asNumber(t.exit_price),
            exit_time: asNumber(t.exit_time),
            exit_comment: asString(t.exit_comment),
            size,
            status: t.status === 'closed' ? 'closed' : 'open',
        });
    }
    return out;
}
