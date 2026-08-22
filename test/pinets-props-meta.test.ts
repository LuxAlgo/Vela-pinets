import { describe, it, expect } from 'vitest';
import { Indicator } from 'pinets';
import { mapProps, applyProps } from '../src/pinets/propsMeta';
import { preparePine } from '../src/pinets/runtime';

const STRATEGY_SRC = `//@version=6
strategy("S", initial_capital=25000, pyramiding=2)
plot(close)
`;

const INDICATOR_SRC = `//@version=6
indicator("I", precision=2)
plot(close)
`;

describe('mapProps — PineTS declaration props → InputSchema', () => {
    it('maps the strategy schema with source-declared values as effective defaults', () => {
        const out = mapProps(Indicator.from(STRATEGY_SRC));
        const byKey = new Map(out.map((p) => [p.key, p]));

        expect(byKey.get('initial_capital')!.defval).toBe(25000); // source-declared
        expect(byKey.get('pyramiding')!.defval).toBe(2); // source-declared
        expect(byKey.get('commission_value')!.defval).toBe(0); // Pine spec default
        expect(byKey.get('initial_capital')!.type).toBe('float');
        expect(byKey.get('pyramiding')!.type).toBe('int');
    });

    it('excludes non-mutable identity entries (title, shorttitle)', () => {
        const keys = mapProps(Indicator.from(STRATEGY_SRC)).map((p) => p.key);
        expect(keys).not.toContain('title');
        expect(keys).not.toContain('shorttitle');
    });

    it('applies engine defaults beneath source-declared values', () => {
        const out = mapProps(Indicator.from(STRATEGY_SRC), { initial_capital: 111111, commission_value: 0.1 });
        const byKey = new Map(out.map((p) => [p.key, p]));

        // The script declares initial_capital — the source wins over the host default.
        expect(byKey.get('initial_capital')!.defval).toBe(25000);
        // The script omits commission_value — the host default replaces the spec one.
        expect(byKey.get('commission_value')!.defval).toBe(0.1);
    });

    it('maps enum props to string + options (select controls)', () => {
        const out = mapProps(Indicator.from(STRATEGY_SRC));
        const qtyType = out.find((p) => p.key === 'default_qty_type')!;
        expect(qtyType.type).toBe('string');
        expect(qtyType.options).toContain('percent_of_equity');
    });

    it('serves the indicator schema for indicator() scripts (no backtest props)', () => {
        const keys = mapProps(Indicator.from(INDICATOR_SRC)).map((p) => p.key);
        expect(keys).toContain('precision');
        expect(keys).toContain('timeframe');
        expect(keys).not.toContain('initial_capital');
        const precision = mapProps(Indicator.from(INDICATOR_SRC)).find((p) => p.key === 'precision')!;
        expect(precision.defval).toBe(2); // source-declared
    });
});

describe('preparePine — props schema in the prepared script', () => {
    it('exposes the props schema (with engine defaults folded in)', () => {
        const prepared = preparePine(STRATEGY_SRC, 'ind-1', { slippage: 5 });
        expect(prepared.props).toBeDefined();
        const byKey = new Map(prepared.props!.map((p) => [p.key, p]));
        expect(byKey.get('initial_capital')!.defval).toBe(25000);
        expect(byKey.get('slippage')!.defval).toBe(5);
    });
});

describe('preparePine — props visibility gate', () => {
    it("'strategy' publishes props for strategy() scripts only", () => {
        expect(preparePine(STRATEGY_SRC, 'i1', undefined, 'strategy').props).toBeDefined();
        expect(preparePine(INDICATOR_SRC, 'i2', undefined, 'strategy').props).toBeUndefined();
    });

    it("'none' publishes no props; 'all' (default) publishes for every script", () => {
        expect(preparePine(STRATEGY_SRC, 'i1', undefined, 'none').props).toBeUndefined();
        expect(preparePine(INDICATOR_SRC, 'i2').props).toBeDefined();
    });
});

describe('applyProps — overrides onto an Indicator instance', () => {
    it('writes overrides through .prop and survives a rejected key', () => {
        const ind = new Indicator(STRATEGY_SRC);
        applyProps(ind, { initial_capital: 42000, __not_a_prop__: 1 });
        expect(ind.prop['initial_capital']).toBe(42000);
        expect(ind.getRuntimePropOverrides()).toMatchObject({ initial_capital: 42000 });
    });
});
