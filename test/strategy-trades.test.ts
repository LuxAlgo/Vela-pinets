import { describe, it, expect } from 'vitest';
import { Vela } from '@luxalgo/vela';
import type { MarketDataFeed, VelaTheme, IndicatorRenderHandle, VisibleRange, InputChangeEvent, CrosshairEvent, ClickEvent } from '@luxalgo/vela';
import type { OHLCV, Pane, IndicatorModel, ScenePatch, InputValue, TradeExecution } from '@luxalgo/vela/plugin';
import { PineEngine } from '../src/pinets/PineEngine';
import { normalizeContext } from '../src/pinets/normalizeContext';
import { toScene } from '../src/pinets/toScene';
import { preparePine } from '../src/pinets/runtime';

type Unsubscribe = () => void;

// ── unit layer: the ledger → executions mapping, no PineTS run involved ──

/** A raw context shaped like a PineTS strategy run (only the fields we read). */
function strategyCtx(over: Partial<Record<string, unknown>> = {}, trades: unknown[] = [], open: unknown[] = []): unknown {
    return {
        plots: {},
        strategy: {
            config: { title: 'My strat', overlay: true, precision: 2, ...over },
            closedtrades: trades,
            opentrades: open,
        },
    };
}

const closedLong = {
    id: 'trade_1',
    entry_id: 'Long',
    entry_price: 100.5,
    entry_bar_index: 10,
    entry_time: 1_000,
    size: 2,
    status: 'closed',
    exit_id: 'close_Long',
    exit_price: 110.25,
    exit_bar_index: 20,
    exit_time: 2_000,
    profit: 19.5,
};

describe('strategy runs — normalizeContext', () => {
    it('reads the declaration from strategy.config when indicator() never ran', () => {
        const run = normalizeContext(strategyCtx());
        expect(run.meta.title).toBe('My strat');
        expect(run.meta.overlay).toBe(true);
        expect(run.meta.precision).toBe(2);
    });

    it('indicator metadata still wins when present (indicator scripts untouched)', () => {
        const run = normalizeContext({ plots: {}, indicator: { title: 'Ind', overlay: false } });
        expect(run.meta.title).toBe('Ind');
        expect(run.trades).toBeUndefined();
    });

    it('collects closed then open trades, dropping malformed entries', () => {
        const run = normalizeContext(
            strategyCtx({}, [closedLong, { id: 'bad' }, null], [{ id: 'trade_2', entry_id: 'S', entry_price: 111, entry_time: 3_000, size: -1, status: 'open' }]),
        );
        expect(run.trades?.map((t) => t.id)).toEqual(['trade_1', 'trade_2']);
        expect(run.trades![0]).toMatchObject({ entry_price: 100.5, exit_price: 110.25, size: 2, status: 'closed' });
        expect(run.trades![1]).toMatchObject({ size: -1, status: 'open' });
    });

    it('a strategy with no fills still reports an empty ledger (not undefined)', () => {
        expect(normalizeContext(strategyCtx()).trades).toEqual([]);
    });
});

describe('strategy runs — toScene executions', () => {
    it('a closed long becomes a buy entry + a sell exit sharing the tradeId', () => {
        const { model } = toScene(normalizeContext(strategyCtx({}, [closedLong])), 'i1');
        expect(model.trades).toEqual([
            { time: 1_000, price: 100.5, side: 'buy', kind: 'entry', label: 'Long', qty: 2, tradeId: 'trade_1' },
            { time: 2_000, price: 110.25, side: 'sell', kind: 'exit', label: 'close_Long', qty: 2, tradeId: 'trade_1' },
        ]);
        expect(model.title).toBe('My strat');
        expect(model.overlay).toBe(true);
        expect(model.paneHint).toBe('price');
    });

    it('a short flips the sides; an open trade paints its entry only; comments replace ids', () => {
        const shortOpen = { id: 'trade_2', entry_id: 'S', entry_comment: 'Sell now', entry_price: 120, entry_time: 5_000, size: -3, status: 'open' };
        const { model } = toScene(normalizeContext(strategyCtx({}, [], [shortOpen])), 'i1');
        expect(model.trades).toEqual([
            { time: 5_000, price: 120, side: 'sell', kind: 'entry', label: 'Sell now', qty: 3, tradeId: 'trade_2' },
        ]);
    });

    it('executions come out chronological, entry before exit on a same-bar round trip', () => {
        const sameBar = { ...closedLong, id: 'trade_3', exit_time: 1_000, exit_price: 101 };
        const later = { ...closedLong, id: 'trade_4', entry_time: 500, exit_time: 800 };
        const { model } = toScene(normalizeContext(strategyCtx({}, [sameBar, later])), 'i1');
        expect(model.trades!.map((t) => [t.time, t.tradeId, t.kind])).toEqual([
            [500, 'trade_4', 'entry'],
            [800, 'trade_4', 'exit'],
            [1_000, 'trade_3', 'entry'],
            [1_000, 'trade_3', 'exit'],
        ]);
    });

    it('a tradeless strategy emits no trades channel', () => {
        const { model } = toScene(normalizeContext(strategyCtx()), 'i1');
        expect(model.trades).toBeUndefined();
    });

    it('a reversal merges the closing and opening ledger slices into ONE entry fill', () => {
        // One sell order flipped +2 → −2: the ledger records it as the long's exit AND
        // the short's entry, same bar, same price, same order id.
        const closedByReversal = { ...closedLong, exit_id: 'Short', exit_time: 5_000, exit_price: 120 };
        const newShort = { id: 'trade_2', entry_id: 'Short', entry_price: 120, entry_time: 5_000, size: -2, status: 'open' };
        const { model } = toScene(normalizeContext(strategyCtx({}, [closedByReversal], [newShort])), 'i1');
        expect(model.trades).toEqual([
            { time: 1_000, price: 100.5, side: 'buy', kind: 'entry', label: 'Long', qty: 2, tradeId: 'trade_1' },
            { time: 5_000, price: 120, side: 'sell', kind: 'entry', label: 'Short', qty: 4, tradeId: 'trade_2' },
        ]);
    });

    it('one exit order closing several lots FIFO paints a single exit fill', () => {
        const lot = (id: string, entryTime: number, size: number) => ({
            id, entry_id: 'Long', entry_price: 100, entry_time: entryTime, size, status: 'closed',
            exit_id: 'TakeProfit', exit_time: 9_000, exit_price: 130,
        });
        const { model } = toScene(normalizeContext(strategyCtx({}, [lot('t1', 1_000, 2), lot('t2', 2_000, 3)])), 'i1');
        const exits = model.trades!.filter((t) => t.kind === 'exit');
        expect(exits).toEqual([{ time: 9_000, price: 130, side: 'sell', kind: 'exit', label: 'TakeProfit', qty: 5, tradeId: 't1' }]);
        // The two entries stay separate — they were two distinct orders on two bars.
        expect(model.trades!.filter((t) => t.kind === 'entry')).toHaveLength(2);
    });
});

describe('strategy runs — preparePine metadata', () => {
    it('reads the title from a strategy() declaration', () => {
        const p = preparePine('//@version=5\nstrategy("Cross strat", overlay=true)\nplot(close)', 'i1');
        expect(p.meta.title).toBe('Cross strat');
        expect(p.meta.overlay).toBe(true);
    });
});

// ── end-to-end: the REAL broker emulator through the built Vela ──

const MIN = 60_000;
const BASE = 1_700_000_000_000;

/** A clean sine market: crossovers (and so trades) at deterministic bars. */
function sineBars(count: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < count; i += 1) {
        const close = 100 + Math.sin(i / 8) * 10;
        const open = i === 0 ? close : out[i - 1]!.close;
        out.push({
            time: BASE + i * 60 * MIN,
            open,
            high: Math.max(open, close) + 1,
            low: Math.min(open, close) - 1,
            close,
            volume: 10,
        });
    }
    return out;
}

const BARS = sineBars(160);

class FixedFeed implements MarketDataFeed {
    load(): Promise<OHLCV[]> {
        return Promise.resolve(BARS.map((b) => ({ ...b })));
    }
    subscribe(): Unsubscribe {
        return () => {};
    }
}

/** Minimal renderer fake: records mounted models AND value patches. */
class RecordingRenderer {
    readonly name = 'fake';
    readonly features: readonly string[] = [];
    readonly capabilities = {
        panes: true, paneManagement: false, fills: 'native', bgcolor: 'native', hline: 'native', markers: true,
        barcolor: 'native', perPointColor: true, drawings: true, userDrawings: false, tables: true, trades: true, inputsUI: true,
    } as const;
    mountedModels: IndicatorModel[] = [];
    patches: ScenePatch[] = [];
    bars: OHLCV[] = [];
    mount(_c: HTMLElement, _t: VelaTheme): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    applyFeature(): void {}
    readFeature(): unknown {
        return undefined;
    }
    setBars(bars: OHLCV[]): void {
        this.bars = bars;
    }
    updateBar(): void {}
    ensurePane(_p: Pane): void {}
    removePane(): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle {
        this.mountedModels.push(model);
        return { id: model.id };
    }
    updateIndicator(_h: IndicatorRenderHandle, p: ScenePatch): void {
        this.patches.push(p);
    }
    removeIndicator(): void {}
    setIndicatorInputs(_h: IndicatorRenderHandle, _v: Record<string, InputValue>): void {}
    onInputChange(_cb: (e: InputChangeEvent) => void): Unsubscribe {
        return () => {};
    }
    onRemoveIndicator(_cb: (id: string) => void): Unsubscribe {
        return () => {};
    }
    onCrosshairMove(_cb: (e: CrosshairEvent) => void): Unsubscribe {
        return () => {};
    }
    onClick(_cb: (e: ClickEvent) => void): Unsubscribe {
        return () => {};
    }
    getVisibleRange(): VisibleRange | null {
        return null;
    }
    setVisibleRange(): void {}
    onViewportChange(_cb: (r: VisibleRange) => void): Unsubscribe {
        return () => {};
    }
    /** The trades of the LATEST emission that carried the channel (mount or patch). */
    lastTrades(id: string): TradeExecution[] | undefined {
        for (let i = this.patches.length - 1; i >= 0; i -= 1) {
            const p = this.patches[i]!;
            if (p.kind === 'value' && p.indicatorId === id && p.trades) return p.trades;
        }
        for (let i = this.mountedModels.length - 1; i >= 0; i -= 1) {
            const m = this.mountedModels[i]!;
            if (m.id === id && m.trades) return m.trades;
        }
        return undefined;
    }
}

const STRATEGY = `//@version=5
strategy("Cross strat", overlay=true)
fast = ta.sma(close, 5)
slow = ta.sma(close, 10)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long, 2)
if ta.crossunder(fast, slow)
    strategy.close("Long", comment="Bye")
`;

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe('a strategy through the addon engine driving the built Vela', () => {
    it('routes to the price pane with its declared title and paints its executions', async () => {
        const renderer = new RecordingRenderer();
        const chart = new Vela(
            {} as unknown as HTMLElement,
            { symbol: 'TEST', timeframe: '60', live: false, volume: false },
            { renderer, engines: [new PineEngine()], dataFeed: new FixedFeed() },
        );
        const errors: string[] = [];
        chart.on('indicator:error', (e) => errors.push(e.error.message));
        const h = chart.addIndicator(STRATEGY);
        await chart.ready();
        await waitFor(() => (renderer.lastTrades(h.id)?.length ?? 0) > 0 || errors.length > 0);
        expect(errors).toEqual([]);

        // The declaration reached the model: real title, overlay → the PRICE pane.
        const model = renderer.mountedModels.find((m) => m.id === h.id)!;
        expect(model.title).toBe('Cross strat');
        expect(model.overlay).toBe(true);
        expect(model.paneId).toBe('price');

        const trades = renderer.lastTrades(h.id)!;
        const entries = trades.filter((t) => t.kind === 'entry');
        const exits = trades.filter((t) => t.kind === 'exit');
        expect(entries.length).toBeGreaterThanOrEqual(2); // the sine crosses several times
        expect(exits.length).toBeGreaterThanOrEqual(1);

        // Entries: long buys of the ordered size, labeled with the order id.
        for (const e of entries) expect(e).toMatchObject({ side: 'buy', label: 'Long', qty: 2 });
        // Exits: the close's comment replaces the auto id; direction flips.
        for (const x of exits) expect(x).toMatchObject({ side: 'sell', kind: 'exit', label: 'Bye', qty: 2 });
        // Every exit pairs with an entry of the same round-trip.
        const entryIds = new Set(entries.map((t) => t.tradeId));
        for (const x of exits) expect(entryIds.has(x.tradeId)).toBe(true);

        // Broker semantics: a market order fills at the NEXT bar's open — every
        // execution sits exactly on a chart bar, at that bar's open price.
        const barAt = new Map(BARS.map((b) => [b.time, b]));
        for (const t of trades) {
            const bar = barAt.get(t.time)!;
            expect(bar).toBeDefined();
            expect(t.price).toBeCloseTo(bar.open, 6);
        }

        // The oracle's deterministic signal counts them too.
        expect(chart.inspect().indicators.find((s) => s.id === h.id)?.trades).toBe(trades.length);
        expect(chart.inspect().totals.trades).toBe(trades.length);
    }, 30_000);

    it('a reversal strategy paints ONE merged entry per flip, never a separate exit', async () => {
        const renderer = new RecordingRenderer();
        const chart = new Vela(
            {} as unknown as HTMLElement,
            { symbol: 'TEST', timeframe: '60', live: false, volume: false },
            { renderer, engines: [new PineEngine()], dataFeed: new FixedFeed() },
        );
        const errors: string[] = [];
        chart.on('indicator:error', (e) => errors.push(e.error.message));
        const h = chart.addIndicator(`//@version=5
strategy("Flip strat", overlay=true)
fast = ta.sma(close, 5)
slow = ta.sma(close, 10)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long, 2)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short, 2)
`);
        await chart.ready();
        await waitFor(() => (renderer.lastTrades(h.id)?.length ?? 0) > 2 || errors.length > 0);
        expect(errors).toEqual([]);

        const trades = renderer.lastTrades(h.id)!;
        // Every fill is an ENTRY: the reversing order's exit slice merged into it.
        expect(trades.every((t) => t.kind === 'entry')).toBe(true);
        // The first fill opens from flat (the ordered size); every later flip closes the
        // prior position AND opens the next one in one order — double the quantity.
        expect(trades[0]!.qty).toBe(2);
        for (const t of trades.slice(1, -1)) expect(t.qty).toBe(4);
        // Directions alternate, labeled by the entry order that filled.
        for (let i = 1; i < trades.length; i += 1) expect(trades[i]!.side).not.toBe(trades[i - 1]!.side);
        for (const t of trades) expect(t.side === 'buy' ? 'Long' : 'Short').toBe(t.label);
    }, 30_000);
});
