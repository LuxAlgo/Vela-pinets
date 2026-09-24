import { describe, it, expect } from 'vitest';
import { Context } from 'pinets';
import { footprintSurface, type FootprintBar, type FootprintSource } from '../src/pinets/footprints';
import { makeLiveProvider } from '../src/pinets/runtime';
import { PineEngine } from '../src/pinets/PineEngine';
import type { ExecutionMarket, ExecutionRequest, FetchSeries, OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';

/**
 * The host-facing order-flow seam behind `request.footprint()`: the engines'
 * `footprints` option becomes the optional `getFootprintData` surface of the
 * virtual PineTS provider — present only when the host supplied a source, so
 * PineTS's own capability check stays the single switch (no source → `na`).
 */

const MARKET: ExecutionMarket = { symbol: 'BTCUSDT', timeframe: '15', symbolInfo: { ticker: 'BTCUSDT', mintick: 0.5 } };
const T0 = 1_700_000_000_000;
const TF_MS = 15 * 60_000;

function bar(i: number): OHLCV {
    const close = 102 + i * 0.5;
    return { time: T0 + i * TF_MS, open: close - 0.5, high: close + 2, low: close - 2, close, volume: 100 };
}

/** Hand-computed reference footprint (see PineTS's request-footprint suite): rows of 1.0 with ticks_per_row = 2. */
const REFERENCE_LEVELS = [
    { price: 100.0, buyVolume: 10, sellVolume: 5 },
    { price: 100.5, buyVolume: 20, sellVolume: 5 },
    { price: 101.0, buyVolume: 5, sellVolume: 40 },
    { price: 101.5, buyVolume: 0, sellVolume: 10 },
    { price: 102.0, buyVolume: 60, sellVolume: 6 },
    { price: 104.5, buyVolume: 20, sellVolume: 1 },
];

function recordingSource(bars: FootprintBar[], calls: Array<{ symbol: string; timeframe: string; range: unknown }> = []): FootprintSource {
    return async (symbol, timeframe, range) => {
        calls.push({ symbol, timeframe, range });
        return bars.filter((b) => (range.from === undefined || b.openTime >= range.from) && (range.to === undefined || b.openTime < range.to));
    };
}

describe('footprintSurface (provider member)', () => {
    it('contributes nothing without a source, so PineTS sees no getFootprintData', () => {
        expect(footprintSurface(undefined, () => 'BTCUSDT', () => '15')).toEqual({});
    });

    it('maps PineTS provider slots (limit, sDate, eDate) to the host range and strips chart-type modifiers', async () => {
        const calls: Array<{ symbol: string; timeframe: string; range: unknown }> = [];
        const surface = footprintSurface(recordingSource([], calls), () => 'BTCUSDT', () => '15');
        await surface.getFootprintData!('BTCUSDT;heikinashi', '15', 96, T0, T0 + 96 * TF_MS);
        await surface.getFootprintData!(undefined, undefined, undefined, T0 + 5 * TF_MS);
        expect(calls).toEqual([
            { symbol: 'BTCUSDT', timeframe: '15', range: { from: T0, to: T0 + 96 * TF_MS, limit: 96 } },
            // Tail poll: chart symbol/timeframe defaults, open-ended range.
            { symbol: 'BTCUSDT', timeframe: '15', range: { from: T0 + 5 * TF_MS, to: undefined, limit: undefined } },
        ]);
    });
});

describe('makeLiveProvider (footprints)', () => {
    it('exposes getFootprintData only when a source is given', async () => {
        const bars = [bar(0), bar(1)];
        const without = makeLiveProvider(() => bars, () => MARKET, undefined);
        expect('getFootprintData' in without).toBe(false);

        const fp: FootprintBar[] = [{ openTime: bar(1).time, levels: REFERENCE_LEVELS }];
        const withSource = makeLiveProvider(() => bars, () => MARKET, undefined, recordingSource(fp));
        const served = await withSource.getFootprintData!('BTCUSDT', '15', undefined, bar(1).time);
        expect(served).toEqual(fp);
    });
});

// End-to-end through the in-process engine — meaningful only once the installed
// pinets implements `request.footprint()` (the `footprint` namespace exists on its
// Context). Until then the plumbing above is the contract; this block self-skips.
const pinetsHasFootprints = ((): boolean => {
    try {
        return typeof (new Context({ marketData: [], source: [] }) as unknown as { pine: Record<string, unknown> }).pine.footprint === 'object';
    } catch {
        return false;
    }
})();

describe.skipIf(!pinetsHasFootprints)('PineEngine + footprints (end to end, real pinets)', () => {
    const SOURCE = `//@version=6
indicator("Footprint probe", overlay = true)
footprint fp = request.footprint(2, 70, 300)
float d = na
float pocUp = na
int n = na
if not na(fp)
    d := fp.delta()
    pocUp := fp.poc().up_price()
    n := array.size(fp.rows())
plot(d, "d")
plot(pocUp, "pocUp")
plot(n, "n")
`;

    async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
        const deadline = Date.now() + ms;
        while (!cond()) {
            if (Date.now() > deadline) throw new Error('timed out waiting for condition');
            await new Promise((r) => setTimeout(r, 20));
        }
    }

    const value = (model: IndicatorModel, title: string, i: number): number | null => {
        const s = model.series.find((x) => x.title === title && 'points' in x) as { points: Array<{ value: number | null }> } | undefined;
        return s?.points[i]?.value ?? null;
    };

    it('feeds request.footprint() from the host source; bars without a footprint read na', async () => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        const calls: Array<{ symbol: string; timeframe: string; range: unknown }> = [];
        const engine = new PineEngine({ footprints: recordingSource([{ openTime: bar(2).time, levels: REFERENCE_LEVELS }], calls) });
        const prepared = await engine.prepare(SOURCE, 'fp-1');
        const req: ExecutionRequest = { prepared, market: MARKET, bars, getBars: () => bars, inputs: {}, mode: 'static' };
        const models: IndicatorModel[] = [];
        const errors: Error[] = [];
        engine.execute(req, { onModel: (m) => models.push(m), onError: (e) => errors.push(e) });
        await waitFor(() => models.length === 1 || errors.length > 0);
        expect(errors).toEqual([]);

        const model = models[0]!;
        // Bar 2 carries the reference footprint: delta 48, POC row [102,103), 5 rows.
        expect(value(model, 'd', 2)).toBe(48);
        expect(value(model, 'pocUp', 2)).toBe(103);
        expect(value(model, 'n', 2)).toBe(5);
        // Other bars have no footprint → na (null in the neutral model).
        expect(value(model, 'd', 0)).toBeNull();
        expect(value(model, 'd', 3)).toBeNull();
        // One request for the loaded history, in PineTS's vocabulary.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ symbol: 'BTCUSDT', timeframe: '15', range: { from: bar(0).time, limit: 4 } });
    });

    it('answers na everywhere when the engine has no footprint source', async () => {
        const bars = [bar(0), bar(1), bar(2)];
        const engine = new PineEngine();
        const prepared = await engine.prepare(SOURCE, 'fp-2');
        const models: IndicatorModel[] = [];
        engine.execute({ prepared, market: MARKET, bars, getBars: () => bars, inputs: {}, mode: 'static' }, { onModel: (m) => models.push(m) });
        await waitFor(() => models.length === 1);
        expect(value(models[0]!, 'd', 2)).toBeNull();
    });

    it('asks the source for the series of a request.security() context: its own symbol and timeframe', async () => {
        const HOUR = 3_600_000;
        const H0 = Math.ceil(T0 / HOUR) * HOUR;
        const chart = Array.from({ length: 8 }, (_, i) => ({ ...bar(i), time: H0 + i * TF_MS }));
        const hourly: OHLCV[] = [0, 1].map((h) => {
            const q = chart.slice(h * 4, h * 4 + 4);
            return { time: H0 + h * HOUR, open: q[0]!.open, high: Math.max(...q.map((b) => b.high)), low: Math.min(...q.map((b) => b.low)), close: q[3]!.close, volume: 400 };
        });
        const seriesOf = (timeframe: string): OHLCV[] => (timeframe === '60' ? hourly : chart);
        const fetchSeries: FetchSeries = async (_symbol, timeframe) => seriesOf(timeframe);
        const calls: Array<{ symbol: string; timeframe: string; range: unknown }> = [];
        // Each delta encodes the series it came from: 1000s for ETHUSDT, 500s for hourly BTCUSDT.
        const footprints: FootprintSource = async (symbol, timeframe, range) => {
            calls.push({ symbol, timeframe, range });
            const base = symbol === 'ETHUSDT' ? 1000 : timeframe === '60' ? 500 : 0;
            return seriesOf(timeframe).map((b, i) => ({ openTime: b.time, levels: [{ price: b.close, buyVolume: base + i + 1, sellVolume: 0 }] }));
        };
        const engine = new PineEngine({ footprints });
        const prepared = await engine.prepare(
            `//@version=6
indicator("Footprint in security")
g() =>
    fp = request.footprint(2)
    na(fp) ? na : fp.delta()
plot(g(), "chart")
plot(request.security("ETHUSDT", "15", g()), "eth")
plot(request.security("BTCUSDT", "60", g(), lookahead = barmerge.lookahead_on), "htf")
`,
            'fp-sec',
        );
        const models: IndicatorModel[] = [];
        const errors: Error[] = [];
        engine.execute(
            { prepared, market: MARKET, bars: chart, getBars: () => chart, inputs: {}, mode: 'static', fetchSeries },
            { onModel: (m) => models.push(m), onError: (e) => errors.push(e) },
        );
        await waitFor(() => models.length === 1 || errors.length > 0);
        expect(errors).toEqual([]);

        const column = (title: string): Array<number | null> => chart.map((_, i) => value(models[0]!, title, i));
        expect(column('chart')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(column('eth')).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008]);
        expect(column('htf')).toEqual([501, 501, 501, 501, 502, 502, 502, 502]);
        expect(calls.map((c) => `${c.symbol}@${c.timeframe}`).sort()).toEqual(['BTCUSDT@15', 'BTCUSDT@60', 'ETHUSDT@15']);
    });

    it('re-reads the forming bar from the source when a live tick moves it', async () => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        const formingOpen = bar(3).time;
        let grown = false;
        const calls: Array<{ symbol: string; timeframe: string; range: { from?: number } }> = [];
        const footprints: FootprintSource = async (symbol, timeframe, range) => {
            calls.push({ symbol, timeframe, range });
            const levels = [{ price: 103, buyVolume: 10, sellVolume: 4 }];
            if (grown) levels.push({ price: 103.5, buyVolume: 7, sellVolume: 3 });
            return range.from === undefined || formingOpen >= range.from ? [{ openTime: formingOpen, levels }] : [];
        };
        const engine = new PineEngine({ footprints });
        const prepared = await engine.prepare(SOURCE, 'fp-live');
        const models: IndicatorModel[] = [];
        const errors: Error[] = [];
        const session = engine.execute(
            { prepared, market: MARKET, bars, getBars: () => bars, inputs: {}, mode: 'live' },
            { onModel: (m) => models.push(m), onError: (e) => errors.push(e) },
        );
        await waitFor(() => models.length > 0 || errors.length > 0);
        expect(errors).toEqual([]);
        expect(value(models[models.length - 1]!, 'd', 3)).toBe(6);

        grown = true;
        bars[3] = { ...bars[3]!, close: bars[3]!.close + 0.5, volume: 124 };
        session.notifyBars();
        await waitFor(() => value(models[models.length - 1]!, 'd', 3) === 10 || errors.length > 0);
        session.stop();
        expect(errors).toEqual([]);
        // One load for the history, then a tail request from the forming bar's open time.
        expect(calls.map((c) => c.range.from)).toEqual([bar(0).time, formingOpen]);
    }, 30_000);
});
