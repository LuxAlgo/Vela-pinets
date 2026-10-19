import { describe, it, expect } from 'vitest';
import { PineEngine } from '../src/pinets/PineEngine';
import type { ExecutionMarket, OHLCV, IndicatorModel, LineLikeSeries, DrawingLabel } from '@luxalgo/vela/plugin';

/**
 * Pine `offset` shifts a plot N bars. Vela draws series points by index, so the shift must
 * move the values N slots (re-timed to the slot they land on), not just re-time them — a
 * re-timed point on the same index draws on the same bar, and every offset overlaps.
 */

const MARKET: ExecutionMarket = { symbol: 'BTCUSDT', timeframe: '60', symbolInfo: { ticker: 'BTCUSDT', mintick: 0.01 } };
const H = 3_600_000;
const T0 = 1_700_002_800_000; // on the hour

function makeBars(times: number[]): OHLCV[] {
    return times.map((time, i) => {
        const close = 100 + i;
        return { time, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1 };
    });
}

async function run(source: string, bars: OHLCV[]): Promise<IndicatorModel> {
    const engine = new PineEngine();
    const prepared = await engine.prepare(source, 'offset-test');
    const models: IndicatorModel[] = [];
    const errors: Error[] = [];
    engine.execute({ prepared, market: MARKET, bars, getBars: () => bars, inputs: {}, mode: 'static' }, { onModel: (m) => models.push(m), onError: (e) => errors.push(e) });
    const deadline = Date.now() + 10_000;
    while (models.length === 0 && errors.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (errors[0]) throw errors[0];
    return models[0]!;
}

const series = (m: IndicatorModel, title: string): LineLikeSeries => m.series.find((s) => s.title === title) as LineLikeSeries;
const values = (s: LineLikeSeries): Array<number | null> => s.points.map((p) => p.value);

describe('plot(offset=…) shifts by bar slot', () => {
    const SOURCE = `//@version=6
indicator("Offset Test", overlay=true)
plot(close, title="No Offset", color=color.white, offset=0)
plot(close, title="Offset -10", color=color.aqua, offset=-10)
plot(close, title="Offset +10", color=color.orange, offset=10)
`;
    const bars = makeBars(Array.from({ length: 40 }, (_, i) => T0 + i * H));
    const closes = bars.map((b) => b.close);

    it('leaves an unshifted plot index-aligned to the bars', async () => {
        const s = series(await run(SOURCE, bars), 'No Offset');
        expect(values(s)).toEqual(closes);
        expect(s.points.map((p) => p.time)).toEqual(bars.map((b) => b.time));
    });

    it('a negative offset moves the values left and leaves trailing gaps', async () => {
        const s = series(await run(SOURCE, bars), 'Offset -10');
        expect(values(s)).toEqual([...closes.slice(10), ...Array<null>(10).fill(null)]);
        expect(s.points.map((p) => p.time)).toEqual(bars.map((b) => b.time));
    });

    it('a positive offset moves the values right and continues past the last bar', async () => {
        const s = series(await run(SOURCE, bars), 'Offset +10');
        expect(values(s)).toEqual([...Array<null>(10).fill(null), ...closes]);
        // The ten points past the last bar sit on the following hourly slots.
        expect(s.points.map((p) => p.time)).toEqual(Array.from({ length: 50 }, (_, i) => T0 + i * H));
    });

    it('follows the real bar times across a session gap', async () => {
        // A three-hour gap between bars 4 and 5: two bars on is the bar two bars on, not two hours on.
        const gapped = makeBars(Array.from({ length: 12 }, (_, i) => T0 + (i < 5 ? i : i + 3) * H));
        const m = await run(`//@version=6
indicator("Gap", overlay=true)
plot(close, title="P", offset=2)
`, gapped);
        const s = series(m, 'P');
        expect(s.points[6]).toMatchObject({ time: gapped[6]!.time, value: gapped[4]!.close });
        expect(s.points[7]).toMatchObject({ time: gapped[7]!.time, value: gapped[5]!.close });
    });
});

describe('plotshape(offset=…) shifts its markers by bar slot', () => {
    it('anchors each marker on the bar N slots away, past the last bar included', async () => {
        const gapped = makeBars(Array.from({ length: 12 }, (_, i) => T0 + (i < 5 ? i : i + 3) * H));
        const m = await run(`//@version=6
indicator("Shapes", overlay=true)
plotshape(bar_index == 3 or bar_index == 11, title="S", offset=2)
`, gapped);
        const xs = (m.labels ?? []).map((l: DrawingLabel) => l.x);
        expect(xs).toEqual([gapped[5]!.time, gapped[11]!.time + 2 * H]);
    });
});
