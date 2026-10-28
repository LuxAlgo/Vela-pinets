import { describe, it, expect } from 'vitest';
import type { OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';
import { preparePine, indicatorFor, runPineStatic } from '../src/pinets/runtime';

/**
 * The declaration's names reach the model the host labels the indicator with: a
 * declared `shorttitle` rides the model (the host shows it on the legend chip and the
 * settings-dialog header), and a blank title becomes "Study" — never an empty name,
 * which leaves a legend row with nothing to show or hover.
 */

function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1 });
    }
    return out;
}

async function runModel(source: string): Promise<IndicatorModel> {
    const prepared = preparePine(source, 'title-1');
    const res = await runPineStatic({
        ind: indicatorFor({}, source, {}, {}),
        bars: makeBars(30),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'title-1',
        inputs: {},
        props: {},
        fetchSeries: undefined,
    });
    return res.model!;
}

describe('declared shorttitle on the computed model', () => {
    it('named shorttitle, indicator and strategy', async () => {
        const ind = await runModel('//@version=6\nindicator("My Long Title", shorttitle = "MLT")\nplot(close)\n');
        expect(ind.title).toBe('My Long Title');
        expect(ind.shorttitle).toBe('MLT');

        const strat = await runModel('//@version=6\nstrategy("Breakout Backtest", shorttitle = "BB", overlay = true)\nplot(close)\n');
        expect(strat.title).toBe('Breakout Backtest');
        expect(strat.shorttitle).toBe('BB');
    });

    it('positional shorttitle', async () => {
        expect((await runModel('//@version=6\nindicator("My Long Title", "MLT")\nplot(close)\n')).shorttitle).toBe('MLT');
    });

    it('no shorttitle — or a blank one — leaves the key off, so the host falls back to the title', async () => {
        expect('shorttitle' in (await runModel('//@version=6\nindicator("Plain")\nplot(close)\n'))).toBe(false);
        expect('shorttitle' in (await runModel('//@version=6\nindicator("Plain", shorttitle = "")\nplot(close)\n'))).toBe(false);
    });
});

describe('a blank declaration title', () => {
    it('reads "Study" on the computed model, indicator and strategy', async () => {
        expect((await runModel('//@version=6\nindicator("")\nplot(close)\n')).title).toBe('Study');
        expect((await runModel('//@version=6\nindicator("   ")\nplot(close)\n')).title).toBe('Study');
        expect((await runModel('//@version=6\nstrategy("", overlay = true)\nplot(close)\n')).title).toBe('Study');
    });

    it('reads "Study" on the loading placeholder too, so the legend never flips names', () => {
        expect(preparePine('//@version=6\nindicator("")\nplot(close)\n', 'p').meta.title).toBe('Study');
        expect(preparePine("//@version=6\nstrategy('', overlay = true)\nplot(close)\n", 'p').meta.title).toBe('Study');
    });
});
