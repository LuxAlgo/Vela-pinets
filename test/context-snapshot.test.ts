// The neutral engine-context snapshot (src/pinets/contextSnapshot.ts):
// serializable extraction, source-named variables, the neutral strategy translation,
// live-reference stripping, and the select filter.
import { describe, it, expect } from 'vitest';
import { snapshotFromCtx } from '../src/pinets/contextSnapshot';

/** A PineTS series variable: one entry per bar, the last one being the current value. */
const series = (...data: unknown[]): { data: unknown[]; offset: number } => ({ data, offset: 0 });

const ctx = {
    idx: 41,
    indicator: { title: 'My Ind', overlay: true, precision: 2 },
    plots: { ema: { title: 'EMA', options: {}, data: [{ time: 1, value: 10 }, { time: 2, value: 11 }] } },
    // The transpiler's positional slots — never anything the script named.
    params: { p3: series(14, 14) },
    var: { glb1_acc: series(1, 2, 3.5), _hidden: series(1), fn: () => 0 },
    let: { glb1_note: series('a', 'hi'), glb2_plain: 7 },
    warnings: [{ message: 'w1', bar: 5 }],
};

const strategyCtx = {
    ...ctx,
    strategy: {
        position_size: 2,
        position_avg_price: 100.5,
        equity: 10_500,
        openprofit: 250,
        netprofit: 500,
        grossprofit: 700,
        grossloss: 200,
        wintrades: 3,
        losstrades: 1,
        eventrades: 0,
        max_drawdown: 80,
        max_runup: 300,
        initial_capital: 10_000,
        closedtrades: [
            { id: 't1', entry_id: 'Long', entry_price: 100, entry_time: 1, exit_id: 'Exit', exit_price: 110, exit_time: 2, exit_comment: 'take', size: 2, status: 'closed' },
        ],
        opentrades: [{ id: 't2', entry_id: 'Short', entry_price: 120, entry_time: 3, size: -1, status: 'open' }],
    },
};

describe('snapshotFromCtx', () => {
    it('extracts the neutral envelope; functions and _private vars are dropped', () => {
        const s = snapshotFromCtx(ctx, 'idle');
        expect(s).toMatchObject({ language: 'pine', phase: 'idle', barIndex: 41 });
        expect(s.meta).toMatchObject({ title: 'My Ind', overlay: true, precision: 2 });
        expect(s.plots.ema).toEqual([{ time: 1, value: 10 }, { time: 2, value: 11 }]);
        expect(s.warnings).toEqual([{ message: 'w1', method: undefined, bar: 5 }]);
    });

    it('variables use SOURCE names and carry the value at the current bar', () => {
        const s = snapshotFromCtx(ctx, 'idle');
        // The `glb<n>_` scope mangle is the transpiler's business — it must not reach a host,
        // and a series collapses to its last entry rather than a per-bar buffer.
        expect(s.variables).toEqual({ acc: 3.5, note: 'hi', plain: 7 });
    });

    it('the transpiler positional slots stay out of variables', () => {
        // `params.p3` is the literal `14` in `ta.sma(close, 14)`, not something the script named.
        expect(Object.keys(snapshotFromCtx(ctx, 'idle').variables)).not.toContain('p3');
    });

    it('an indicator reports no strategy — its absence is what tags the run', () => {
        const s = snapshotFromCtx(ctx, 'idle');
        expect(s.strategy).toBeUndefined();
        expect(s.trades).toBeUndefined();
    });

    it('translates the broker ledger into the neutral vocabulary', () => {
        const s = snapshotFromCtx(strategyCtx, 'streaming');
        expect(s.strategy).toEqual({
            position: 2,
            avgPrice: 100.5,
            equity: 10_500,
            openPnl: 250,
            netPnl: 500,
            grossProfit: 700,
            grossLoss: 200,
            wins: 3,
            losses: 1,
            even: 0,
            maxDrawdown: 80,
            maxRunup: 300,
            initialCapital: 10_000,
        });
    });

    it('trades become round trips: a signed size splits into side + magnitude', () => {
        const s = snapshotFromCtx(strategyCtx, 'streaming');
        expect(s.trades).toEqual([
            { id: 't1', side: 'long', qty: 2, entry: { id: 'Long', time: 1, price: 100 }, exit: { id: 'Exit', time: 2, price: 110, comment: 'take' }, open: false },
            { id: 't2', side: 'short', qty: 1, entry: { id: 'Short', time: 3, price: 120 }, open: true },
        ]);
    });

    it('snapshots are copies — mutating them never touches the source', () => {
        const nested = { ...ctx, var: { glb1_acc: series({ levels: [1, 2, 3] }) } };
        const s = snapshotFromCtx(nested, 'streaming');
        (s.variables.acc as { levels: number[] }).levels.push(99);
        expect((nested.var.glb1_acc.data[0] as { levels: number[] }).levels).toEqual([1, 2, 3]);
    });

    it('select limits extraction to the requested keys', () => {
        const s = snapshotFromCtx(strategyCtx, 'idle', ['strategy', 'barIndex']);
        expect(s.strategy).toBeDefined();
        expect(s.variables).toEqual({});
        expect(s.plots).toEqual({});
        expect(s.trades).toBeUndefined(); // the ledger is opt-in — it never rides an ordinary pull
        expect(s.meta.title).toBe(''); // meta not selected
    });

    it('prefers fullContext when present (streamed pages)', () => {
        const s = snapshotFromCtx({ fullContext: strategyCtx }, 'streaming');
        expect(s.barIndex).toBe(41);
        expect(s.strategy?.equity).toBe(10_500);
    });
});
