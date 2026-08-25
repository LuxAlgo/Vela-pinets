// Session-aware closeTime on the klines the runtime hands PineTS: the engine's kline
// contract asks providers for the SESSION close (its own net is open + tf), and the
// runtime now computes it template-locally from the chart syminfo — the last intraday
// bucket runs short, a daily bar closes at the session end, a trading-day roll span
// (futures 1700-1600) closes next-day, and continuous markets emit nothing at all.
import { describe, it, expect } from 'vitest';
import type { OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';
import { toKlines, indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';

const NY = { timezone: 'America/New_York', session: '0930-1600', session_extended: '0400-2000' };
const CME = { timezone: 'America/Chicago', session: '0830-1515', session_extended: '1700-1600' };

/** Jan 2026 (no DST transitions): NY = UTC-5, Chicago = UTC-6. */
const nyT = (d: number, h: number, m: number): number => Date.UTC(2026, 0, d, h + 5, m);
const cmeT = (d: number, h: number, m: number): number => Date.UTC(2026, 0, d, h + 6, m);

const bar = (time: number): OHLCV => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });

describe('toKlines closeTime (session markets)', () => {
    it('equities 1h: full buckets close at open+1h, the LAST bucket at the session end', () => {
        const opens = [nyT(12, 9, 30), nyT(12, 10, 30), nyT(12, 15, 30)];
        const ks = toKlines(opens.map(bar), '60', NY);
        expect(ks[0]!.closeTime).toBe(nyT(12, 10, 30));
        expect(ks[1]!.closeTime).toBe(nyT(12, 11, 30));
        expect(ks[2]!.closeTime).toBe(nyT(12, 16, 0)); // 15:30 + 1h caps at 16:00
    });

    it('futures RTH: the short last bucket and the session-daily close', () => {
        const hour = toKlines([bar(cmeT(12, 15, 0))], '60', CME);
        expect(hour[0]!.closeTime).toBe(cmeT(12, 15, 15)); // 15:00 + 1h caps at 15:15
        const daily = toKlines([bar(cmeT(12, 8, 30))], '1D', CME);
        expect(daily[0]!.closeTime).toBe(cmeT(12, 15, 15)); // labeled at the open, closes at the end
    });

    it('futures ETH (a bar sits outside the regular span → the extended tape rules)', () => {
        const opens = [bar(cmeT(12, 15, 0)), bar(cmeT(12, 17, 30))];
        const ks = toKlines(opens, '60', CME);
        expect(ks[0]!.closeTime).toBe(cmeT(12, 16, 0)); // extended close, not 15:15
        expect(ks[1]!.closeTime).toBe(cmeT(12, 18, 30)); // evening bucket, plain +1h
        const daily = toKlines([bar(cmeT(12, 17, 0))], '1D', CME);
        expect(daily[0]!.closeTime).toBe(cmeT(13, 16, 0)); // the 1700-1600 trading day closes NEXT day
    });

    it('an all-regular series stays on regular closes even when an extended span exists', () => {
        const ks = toKlines([bar(cmeT(12, 8, 30)), bar(cmeT(12, 15, 0))], '60', CME);
        expect(ks[1]!.closeTime).toBe(cmeT(12, 15, 15));
    });

    it('continuous markets, W/M, and the synthesized fallback emit NO closeTime', () => {
        const b = [bar(Date.UTC(2026, 0, 12))];
        expect(toKlines(b, '60', { timezone: 'Etc/UTC', session: '24x7' })[0]!.closeTime).toBeUndefined();
        expect(toKlines(b, '60', { timezone: 'UTC', session: 'regular' })[0]!.closeTime).toBeUndefined();
        expect(toKlines(b, '1W', CME)[0]!.closeTime).toBeUndefined();
        expect(toKlines(b, '60')[0]!.closeTime).toBeUndefined();
    });

    it('a bar outside every declared window falls back to the engine net (no closeTime)', () => {
        const ks = toKlines([bar(cmeT(12, 16, 30))], '60', { timezone: 'America/Chicago', session: '0830-1515' });
        expect(ks[0]!.closeTime).toBeUndefined(); // 16:30 with no extended declared
    });
});

// ── full engine: time_close reads the session close through a real PineTS run ──

const SOURCE = `//@version=6
indicator("TC probe", overlay=false)
plot(time_close, "tc")
`;

function rthBars(): OHLCV[] {
    const out: OHLCV[] = [];
    for (let d = 12; d <= 14; d += 1) {
        for (const [h, m] of [[8, 30], [9, 30], [10, 30], [11, 30], [12, 30], [13, 30], [14, 30], [15, 0]] as const) {
            const t = cmeT(d, h, m);
            out.push({ time: t, open: 100, high: 101, low: 99, close: 100.5, volume: 1 });
        }
    }
    return out;
}

describe('time_close through a real PineTS run', () => {
    it('the last RTH hour bucket reports the SESSION close, not open+tf', async () => {
        const prepared = preparePine(SOURCE, 'tc-1');
        const ind = indicatorFor({}, SOURCE, {});
        const res = await runPineStatic({
            ind,
            bars: rthBars(),
            market: { symbol: 'ES1!', timeframe: '60', symbolInfo: CME as never },
            visibleRange: undefined,
            prepared,
            instanceId: 'tc-1',
            inputs: {},
            fetchSeries: undefined,
        });
        const model: IndicatorModel = res.model;
        const tc = model.series.find((s) => s.title === 'tc');
        expect(tc).toBeDefined();
        const pts = (tc as unknown as { points: Array<{ time: number; value: number | null }> }).points;
        const last = pts[pts.length - 1]!;
        expect(last.value).toBe(cmeT(14, 15, 15)); // 15:00 bucket → 15:15 session close
        const first = pts[0]!;
        expect(first.value).toBe(cmeT(12, 9, 30)); // full bucket → open + 1h
    });
});
