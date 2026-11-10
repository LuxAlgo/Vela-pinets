import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PineEngine } from '../src/pinets/PineEngine';
import { PineWorkerEngine } from '../src/pinets-worker/PineWorkerEngine';
import { syminfoForSymbol, makeLiveProvider } from '../src/pinets/runtime';
import { loadLoopbackWorker } from './fixtures/loopbackWorker';
import type { ExecutionMarket, OHLCV, IndicatorModel, LineLikeSeries, SymbolInfo } from '@luxalgo/vela/plugin';

/**
 * Economic data (FRED-style series): flat bars at the series' own frequency, no volume,
 * and the feed's neutral fact `volume: false`. Pine names that fact
 * `syminfo.volumetype == "n/a"`; the runtime maps it for BOTH engines. Volume itself still
 * reads 0 on such a market (whether it should read na is not decided yet).
 */

const ECONOMIC: SymbolInfo = {
    ticker: 'CPIAUCSL',
    tickerid: 'FRED:CPIAUCSL',
    description: 'Consumer Price Index for All Urban Consumers',
    type: 'economic',
    timezone: 'Etc/UTC',
    session: '24x7',
    mintick: 0.001,
    minmove: 1,
    pricescale: 1000,
    pointvalue: 1,
    volume: false,
    timeframes: { finest: '1M', default: '1M' },
    attribution: [{ name: 'FRED', notice: 'Source: FRED' }],
};

const market = (symbolInfo: SymbolInfo): ExecutionMarket => ({ symbol: 'FRED:CPIAUCSL', timeframe: '1M', symbolInfo });

/** Flat monthly bars (open = high = low = close) stamped 00:00 UTC on each month's first day, without volume. */
const BARS: OHLCV[] = Array.from({ length: 24 }, (_, i) => {
    const v = 300 + i * 0.7;
    return { time: Date.UTC(2024, i, 1), open: v, high: v, low: v, close: v };
});

const SOURCE = `//@version=6
indicator("Economic syminfo")
plot(syminfo.volumetype == "n/a" ? 1 : 0, "volumetype n/a")
plot(syminfo.type == "economic" ? 1 : 0, "economic")
plot(timeframe.ismonthly ? 1 : 0, "monthly")
plot(volume, "volume")
`;

let loopback: Awaited<ReturnType<typeof loadLoopbackWorker>>;
beforeAll(async () => {
    loopback = await loadLoopbackWorker();
});
afterAll(() => loopback.restore());

const ENGINES = {
    PineEngine: () => new PineEngine(),
    PineWorkerEngine: () => new PineWorkerEngine({ createWorker: () => loopback.worker }),
};

async function run(engine: PineEngine | PineWorkerEngine, symbolInfo: SymbolInfo): Promise<IndicatorModel> {
    const prepared = await engine.prepare(SOURCE, 'economic-syminfo');
    const models: IndicatorModel[] = [];
    const errors: Error[] = [];
    engine.execute(
        { prepared, market: market(symbolInfo), bars: BARS, getBars: () => BARS, inputs: {}, mode: 'static' },
        { onModel: (m) => models.push(m), onError: (e) => errors.push(e) },
    );
    const deadline = Date.now() + 10_000;
    while (models.length === 0 && errors.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (errors[0]) throw errors[0];
    if (!models[0]) throw new Error('no model within 10 s');
    return models[0];
}

const values = (m: IndicatorModel, title: string): Array<number | null> => (m.series.find((s) => s.title === title) as LineLikeSeries).points.map((p) => p.value);
const every = (v: number): number[] => BARS.map(() => v);

describe('syminfo of a market without volume data', () => {
    it('reads volumetype "n/a" when the feed states volume: false', () => {
        const info = syminfoForSymbol(market(ECONOMIC), undefined);
        expect(info.volumetype).toBe('n/a');
        expect(info).toMatchObject({ type: 'economic', timezone: 'Etc/UTC', volume: false });
    });

    it('leaves the feed object untouched', () => {
        const symbolInfo = { ...ECONOMIC };
        syminfoForSymbol(market(symbolInfo), undefined);
        expect(symbolInfo).not.toHaveProperty('volumetype');
    });

    it('keeps a volumetype the feed declares itself', () => {
        expect(syminfoForSymbol(market({ ...ECONOMIC, volumetype: 'tick' }), undefined).volumetype).toBe('tick');
    });

    it('adds nothing when the feed states no volume fact or volume: true', () => {
        const unstated: SymbolInfo = { ...ECONOMIC };
        delete unstated.volume;
        expect(syminfoForSymbol(market(unstated), undefined)).not.toHaveProperty('volumetype');
        expect(syminfoForSymbol(market({ ...ECONOMIC, volume: true }), undefined)).not.toHaveProperty('volumetype');
    });

    it('reaches a live session through the streaming provider', async () => {
        const provider = makeLiveProvider(() => BARS, () => market(ECONOMIC), undefined);
        expect((await provider.getSymbolInfo('FRED:CPIAUCSL')).volumetype).toBe('n/a');
    });
});

describe.each(Object.entries(ENGINES))('an economic chart symbol through %s', (_name, create) => {
    const engine = create();

    it('runs on flat monthly bars and exposes the economic syminfo to the script', async () => {
        const model = await run(engine, ECONOMIC);
        expect(values(model, 'volumetype n/a')).toEqual(every(1));
        expect(values(model, 'economic')).toEqual(every(1));
        expect(values(model, 'monthly')).toEqual(every(1));
        expect(values(model, 'volume')).toEqual(every(0)); // volume still reads 0, not na (undecided)
    });

    it('reads no "n/a" volumetype when the market has volume', async () => {
        const model = await run(engine, { ...ECONOMIC, volume: true });
        expect(values(model, 'volumetype n/a')).toEqual(every(0));
    });
});
