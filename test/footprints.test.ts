import { describe, it, expect } from 'vitest';
import { Context } from 'pinets';
import { footprintSurface, type FootprintBar, type FootprintSource } from '../src/pinets/footprints';
import { makeLiveProvider } from '../src/pinets/runtime';
import { PineEngine } from '../src/pinets/PineEngine';
import type { ExecutionMarket, ExecutionRequest, OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';

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
});
