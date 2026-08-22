// Strategy declaration properties as settings inputs: the synthesized "Properties" tab
// rows (prepare), the namespaced-key split and `.prop` routing (indicatorFor), and the
// end-to-end proof that an edit reaches the broker emulator through the built Vela.
import { describe, it, expect } from 'vitest';
import { Vela } from '@luxalgo/vela';
import type { MarketDataFeed, VelaTheme, IndicatorRenderHandle, VisibleRange, InputChangeEvent, CrosshairEvent, ClickEvent } from '@luxalgo/vela';
import type { OHLCV, Pane, IndicatorModel, ScenePatch, InputValue, InputSchema } from '@luxalgo/vela/plugin';
import { PineEngine } from '../src/pinets/PineEngine';
import { preparePine, indicatorFor, type IndicatorCache } from '../src/pinets/runtime';
import { splitStrategyProps, STRATEGY_PROP_PREFIX, STRATEGY_PROPS_TAB } from '../src/pinets/strategyProps';

type Unsubscribe = () => void;

const STRATEGY = `//@version=5
strategy("Props strat", overlay=true, initial_capital=5000, pyramiding=2)
len = input.int(5, "Fast length")
fast = ta.sma(close, len)
slow = ta.sma(close, 10)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long, 2)
if ta.crossunder(fast, slow)
    strategy.close("Long")
`;

const INDICATOR = `//@version=5
indicator("Plain", overlay=true)
plot(ta.sma(close, 5))
`;

function propRows(inputs: InputSchema[]): InputSchema[] {
    return inputs.filter((i) => i.key.startsWith(STRATEGY_PROP_PREFIX));
}

describe('strategy properties — the synthesized schema', () => {
    it('a strategy() gains the Properties rows, seeded from its declared args', () => {
        const p = preparePine(STRATEGY, 'i1');
        const rows = propRows(p.inputs);
        expect(rows.map((r) => r.key)).toEqual([
            'strategy.initial_capital',
            'strategy.currency',
            'strategy.default_qty_value',
            'strategy.default_qty_type',
            'strategy.pyramiding',
            'strategy.commission_value',
            'strategy.commission_type',
            'strategy.slippage',
            'strategy.margin_long',
            'strategy.margin_short',
        ]);
        for (const r of rows) expect(r.tab).toBe(STRATEGY_PROPS_TAB);

        // Defaults = spec defval overlaid with the source-declared args, so "Reset
        // defaults" restores what the SCRIPT says, not PineTS's generic spec.
        const byKey = new Map(rows.map((r) => [r.key, r]));
        expect(byKey.get('strategy.initial_capital')).toMatchObject({ type: 'float', defval: 5000 });
        expect(byKey.get('strategy.pyramiding')).toMatchObject({ type: 'int', defval: 2 });

        // The leading rows sit under the tab strip with no group header.
        expect(byKey.get('strategy.initial_capital')!.group).toBeUndefined();
        expect(byKey.get('strategy.pyramiding')!.group).toBeUndefined();
        expect(byKey.get('strategy.commission_value')!.group).toBe('Cost simulation');

        // Enum dropdowns show capitalized display labels (translated back at the write seam).
        expect(byKey.get('strategy.default_qty_type')!.options).toEqual(['Fixed', 'Cash', '% Of Equity']);
        expect(byKey.get('strategy.default_qty_type')!.defval).toBe('Fixed');
        expect(byKey.get('strategy.commission_type')!.options).toEqual(['Percent', 'Cash Per Contract', 'Cash Per Order']);
        expect(byKey.get('strategy.commission_type')!.defval).toBe('Percent');
        expect(byKey.get('strategy.currency')!.options).toContain('USD');

        // The value+type pairs share an inline row (the type dropdown is unlabeled).
        expect(byKey.get('strategy.default_qty_value')!.inline).toBe(byKey.get('strategy.default_qty_type')!.inline);
        expect(byKey.get('strategy.commission_value')!.inline).toBe(byKey.get('strategy.commission_type')!.inline);

        // Script inputs stay first, untouched, on the default tab.
        expect(p.inputs[0]).toMatchObject({ key: 'len', title: 'Fast length' });
        expect(p.inputs[0]!.tab).toBeUndefined();
    });

    it('a strategy with no input.*() still gets a non-empty schema (the dialog can open)', () => {
        const p = preparePine('//@version=5\nstrategy("Bare", overlay=true)\nplot(close)', 'i1');
        expect(p.inputs.length).toBeGreaterThan(0);
        expect(p.inputs.every((i) => i.key.startsWith(STRATEGY_PROP_PREFIX))).toBe(true);
    });

    it('an undeclared initial capital defaults to the spec value 1,000,000', () => {
        const p = preparePine('//@version=5\nstrategy("Bare", overlay=true)\nplot(close)', 'i1');
        expect(p.inputs.find((i) => i.key === 'strategy.initial_capital')!.defval).toBe(1_000_000);
    });

    it('an indicator() gets none', () => {
        const p = preparePine(INDICATOR, 'i1');
        expect(propRows(p.inputs)).toEqual([]);
    });
});

describe('strategy properties — routing into the PineTS instance', () => {
    it('splits namespaced keys off and returns the record untouched without them', () => {
        const plain = { len: 7 };
        expect(splitStrategyProps(plain).scriptInputs).toBe(plain);

        const { scriptInputs, propOverrides } = splitStrategyProps({ len: 7, 'strategy.initial_capital': 25_000 });
        expect(scriptInputs).toEqual({ len: 7 });
        expect(propOverrides).toEqual({ initial_capital: 25_000 });
    });

    it('indicatorFor applies prop overrides via .prop and keeps them out of the script inputs', () => {
        const cache: IndicatorCache = {};
        const ind = indicatorFor(cache, STRATEGY, { len: 7, 'strategy.initial_capital': 25_000, 'strategy.commission_value': 0.1 });
        expect(ind.getRuntimePropOverrides()).toEqual({ initial_capital: 25_000, commission_value: 0.1 });
        expect(Object.keys(ind.getRuntimeInputs()).some((k) => k.startsWith(STRATEGY_PROP_PREFIX))).toBe(false);

        // A Properties edit is an input-set change: the cache must rebuild.
        const next = indicatorFor(cache, STRATEGY, { len: 7, 'strategy.initial_capital': 30_000, 'strategy.commission_value': 0.1 });
        expect(next).not.toBe(ind);
        expect(next.getRuntimePropOverrides()).toEqual({ initial_capital: 30_000, commission_value: 0.1 });
    });

    it('stale namespaced keys on an indicator() are dropped, never thrown', () => {
        const ind = indicatorFor({}, INDICATOR, { 'strategy.initial_capital': 25_000 });
        expect(ind.getRuntimePropOverrides()).toEqual({});
    });

    it('enum display labels translate back to the runtime vocabulary on write', () => {
        const ind = indicatorFor({}, STRATEGY, {
            'strategy.default_qty_type': '% Of Equity',
            'strategy.commission_type': 'Cash Per Contract',
            'strategy.currency': 'EUR',
        });
        expect(ind.getRuntimePropOverrides()).toEqual({
            default_qty_type: 'percent_of_equity',
            commission_type: 'cash_per_contract',
            currency: 'EUR',
        });
    });
});

// ── end-to-end: a Properties edit reaches the broker emulator through the built Vela ──

const MIN = 60_000;
const BASE = 1_700_000_000_000;

function sineBars(count: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < count; i += 1) {
        const close = 100 + Math.sin(i / 8) * 10;
        const open = i === 0 ? close : out[i - 1]!.close;
        out.push({ time: BASE + i * 60 * MIN, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume: 10 });
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

/** Minimal renderer fake: counts models so the test can await runs. */
class CountingRenderer {
    readonly name = 'fake';
    readonly features: readonly string[] = [];
    readonly capabilities = {
        panes: true, paneManagement: false, fills: 'native', bgcolor: 'native', hline: 'native', markers: true,
        barcolor: 'native', perPointColor: true, drawings: true, userDrawings: false, tables: true, trades: true, inputsUI: true,
    } as const;
    emissions = 0;
    mount(_c: HTMLElement, _t: VelaTheme): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    applyFeature(): void {}
    readFeature(): unknown {
        return undefined;
    }
    setBars(): void {}
    updateBar(): void {}
    ensurePane(_p: Pane): void {}
    removePane(): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle {
        this.emissions += 1;
        return { id: model.id };
    }
    updateIndicator(_h: IndicatorRenderHandle, _p: ScenePatch): void {
        this.emissions += 1;
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
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await cond())) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe('a Properties edit through the addon engine driving the built Vela', () => {
    it('setInput("strategy.initial_capital") re-runs the broker with the new capital', async () => {
        const renderer = new CountingRenderer();
        const chart = new Vela(
            {} as unknown as HTMLElement,
            { symbol: 'TEST', timeframe: '60', live: false, volume: false },
            { renderer, engines: [new PineEngine()], dataFeed: new FixedFeed() },
        );
        const errors: string[] = [];
        chart.on('indicator:error', (e) => errors.push(e.error.message));
        const h = chart.addIndicator(STRATEGY);
        await chart.ready();

        // First run: the broker starts on the SOURCE-declared capital.
        await waitFor(async () => (await h.context(['strategy']))?.strategy != null || errors.length > 0);
        expect(errors).toEqual([]);
        const before = (await h.context(['strategy']))!.strategy!;
        expect(before.initialCapital).toBe(5000);

        // The handle exposes the Properties rows like any other input.
        expect(h.inputs.some((i) => i.key === 'strategy.initial_capital' && i.tab === STRATEGY_PROPS_TAB)).toBe(true);

        // Edit through the PUBLIC input surface — the same path the settings dialog uses.
        h.setInput('strategy.initial_capital', 25_000);
        await waitFor(async () => (await h.context(['strategy']))?.strategy?.initialCapital === 25_000);
        const after = (await h.context(['strategy']))!.strategy!;
        expect(after.initialCapital).toBe(25_000);
        // Same trades, bigger account: equity moved with the capital, PnL is unchanged.
        expect(after.equity - after.netPnl - after.openPnl).toBeCloseTo(25_000, 6);
        expect(after.netPnl).toBeCloseTo(before.netPnl, 6);
        expect(errors).toEqual([]);
    }, 30_000);

    it('the Default order size drives the fill quantity of qty-less entries', async () => {
        const renderer = new CountingRenderer();
        const chart = new Vela(
            {} as unknown as HTMLElement,
            { symbol: 'TEST', timeframe: '60', live: false, volume: false },
            { renderer, engines: [new PineEngine()], dataFeed: new FixedFeed() },
        );
        const errors: string[] = [];
        chart.on('indicator:error', (e) => errors.push(e.error.message));
        // No qty on the entry — the broker falls back to the default order size.
        const h = chart.addIndicator(`//@version=5
strategy("Qty strat", overlay=true, initial_capital=5000)
fast = ta.sma(close, 5)
slow = ta.sma(close, 10)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
`);
        await chart.ready();

        const qtys = async (): Promise<number[]> => {
            const c = await h.context(['trades']);
            return [...new Set((c?.trades ?? []).map((t) => t.qty))];
        };
        await waitFor(async () => (await qtys()).length > 0 || errors.length > 0);
        expect(errors).toEqual([]);
        expect(await qtys()).toEqual([1]); // the spec default

        h.setInput('strategy.default_qty_value', 3);
        await waitFor(async () => JSON.stringify(await qtys()) === '[3]');
        expect(await qtys()).toEqual([3]); // every fill re-sized — what the markers print
        expect(errors).toEqual([]);
    }, 30_000);
});
