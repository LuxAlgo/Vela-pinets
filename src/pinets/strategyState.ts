// PineTS's broker ledger → Vela's NEUTRAL strategy vocabulary. Same narrow-contract
// philosophy as PineRun.ts: read the few fields we promise, translate the names, and let
// PineTS reshape everything else without this package noticing.
//
// The translation is the point. `EngineContextSnapshot.strategy` is a Vela contract, not a
// Pine one, so a dashboard written against it reads a strategy from ANY engine — which is
// exactly why the Pine spellings (`netprofit`, `wintrades`, `position_avg_price`) stop here.
import type { StrategyState, StrategyTrade } from '@luxalgo/vela/plugin';
import { asString, asNumber } from './PineRun';

/** The slice of PineTS's `ctx.strategy` this folder reads. */
interface RawStrategy {
    position_size?: unknown;
    position_avg_price?: unknown;
    equity?: unknown;
    openprofit?: unknown;
    netprofit?: unknown;
    grossprofit?: unknown;
    grossloss?: unknown;
    wintrades?: unknown;
    losstrades?: unknown;
    eventrades?: unknown;
    max_drawdown?: unknown;
    max_runup?: unknown;
    initial_capital?: unknown;
    opentrades?: unknown[];
    closedtrades?: unknown[];
}

const num = (v: unknown): number => asNumber(v) ?? 0;

/** The broker summary at the last computed bar. Null when the script declared no strategy. */
export function toStrategyState(raw: unknown): StrategyState | undefined {
    if (raw == null || typeof raw !== 'object') return undefined;
    const s = raw as RawStrategy;
    return {
        position: num(s.position_size),
        avgPrice: num(s.position_avg_price),
        equity: num(s.equity),
        openPnl: num(s.openprofit),
        netPnl: num(s.netprofit),
        grossProfit: num(s.grossprofit),
        grossLoss: num(s.grossloss),
        wins: num(s.wintrades),
        losses: num(s.losstrades),
        even: num(s.eventrades),
        maxDrawdown: num(s.max_drawdown),
        maxRunup: num(s.max_runup),
        initialCapital: num(s.initial_capital),
    };
}

/**
 * The ledger as round trips, closed first then open — the order PineTS keeps. `size` is
 * SIGNED there and carries the direction; Vela splits that into `side` + a magnitude, so
 * host code never has to know the sign convention. Malformed entries are dropped.
 */
export function toStrategyTrades(raw: unknown): StrategyTrade[] {
    if (raw == null || typeof raw !== 'object') return [];
    const s = raw as RawStrategy;
    const out: StrategyTrade[] = [];
    for (const entry of [...(Array.isArray(s.closedtrades) ? s.closedtrades : []), ...(Array.isArray(s.opentrades) ? s.opentrades : [])]) {
        const t = (entry ?? {}) as Record<string, unknown>;
        const entryPrice = asNumber(t.entry_price);
        const entryTime = asNumber(t.entry_time);
        const size = asNumber(t.size);
        if (entryPrice === undefined || entryTime === undefined || size === undefined || size === 0) continue;
        const exitPrice = asNumber(t.exit_price);
        const exitTime = asNumber(t.exit_time);
        out.push({
            id: asString(t.id) ?? `trade_${out.length}`,
            side: size > 0 ? 'long' : 'short',
            qty: Math.abs(size),
            entry: {
                id: asString(t.entry_id) ?? '',
                time: entryTime,
                price: entryPrice,
                ...(asString(t.entry_comment) !== undefined ? { comment: asString(t.entry_comment)! } : {}),
            },
            ...(exitPrice !== undefined && exitTime !== undefined
                ? {
                      exit: {
                          id: asString(t.exit_id) ?? '',
                          time: exitTime,
                          price: exitPrice,
                          ...(asString(t.exit_comment) !== undefined ? { comment: asString(t.exit_comment)! } : {}),
                      },
                  }
                : {}),
            open: t.status !== 'closed',
        });
    }
    return out;
}
