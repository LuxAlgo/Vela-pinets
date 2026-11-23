// Session-aware closeTime on the klines the runtime hands PineTS: the engine's kline
// contract asks providers for the SESSION close (its own net is open + tf), and the
// runtime now computes it template-locally from the chart syminfo — the last intraday
// bucket runs short, a daily bar closes at the session end, a trading-day roll span
// (futures 1700-1600) closes next-day, and continuous markets emit nothing at all.
import { describe, it, expect } from 'vitest';
import type { OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';
import { toKlines, indicatorFor, runPineStatic, openLiveStream, preparePine } from '../src/pinets/runtime';

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
        const model: IndicatorModel = res.model!; // runs over real bars — never the null (zero-bar) outcome
        const tc = model.series.find((s) => s.title === 'tc');
        expect(tc).toBeDefined();
        const pts = (tc as unknown as { points: Array<{ time: number; value: number | null }> }).points;
        const last = pts[pts.length - 1]!;
        expect(last.value).toBe(cmeT(14, 15, 15)); // 15:00 bucket → 15:15 session close
        const first = pts[0]!;
        expect(first.value).toBe(cmeT(12, 9, 30)); // full bucket → open + 1h
    });
});

describe('toKlines closeTime (tick timeframes)', () => {
    it('closes every bar before the last at the next bar open and leaves the forming bar open', () => {
        const t = Date.UTC(2026, 0, 12, 10, 0, 0);
        const bars = [bar(t), bar(t + 1_200), bar(t + 1_201), bar(t + 5_000)];
        for (const tf of ['1T', '10T', 'T', '100t']) {
            const ks = toKlines(bars, tf, NY);
            expect(ks.map((k) => k.closeTime)).toEqual([t + 1_200, t + 1_201, t + 5_000, undefined]);
        }
        // Single bar has no successor yet — still forming.
        expect(toKlines([bar(t)], '10T')[0]!.closeTime).toBeUndefined();
        // Zero ticks is not a valid tick timeframe.
        expect(toKlines(bars, '0T')[0]!.closeTime).toBeUndefined();
    });

    it('caps closed tick bars at `now` so clock skew or same-ms bursts never miss barstate.isconfirmed', () => {
        const now = Date.UTC(2026, 0, 12, 10, 0, 10);
        const bars = [bar(now - 500), bar(now + 10), bar(now + 11)];
        const ks = toKlines(bars, '1T', undefined, now);
        expect(ks[0]!.closeTime).toBe(now);
        expect(ks[1]!.closeTime).toBe(now);
        expect(ks[2]!.closeTime).toBeUndefined();
    });
});

describe('tick bars through PineTS (barstate.isconfirmed, time_close, strategies, live close)', () => {
    const recentTickBars = (count: number): OHLCV[] => {
        const base = Date.now() - count * 2_000;
        return Array.from({ length: count }, (_, i) => ({
            time: base + i * 1_500,
            open: 100 + i,
            high: 101 + i,
            low: 99 + i,
            close: 100.5 + i,
            volume: 10,
        }));
    };

    it('marks every closed tick bar confirmed with next-bar time_close and keeps the forming bar unconfirmed', async () => {
        const src = `//@version=6
indicator("Tick barstate", overlay=false)
plot(barstate.isconfirmed ? 1 : 0, "conf")
plot(time_close, "tc")
`;
        const bars = recentTickBars(6);
        const prepared = preparePine(src, 'tick-bs');
        const res = await runPineStatic({
            ind: indicatorFor({}, src, {}),
            bars,
            market: { symbol: 'BTCUSDT', timeframe: '10T' },
            visibleRange: undefined,
            prepared,
            instanceId: 'tick-bs',
            inputs: {},
            fetchSeries: undefined,
        });
        const model = res.model!;
        const conf = (model.series.find((s) => s.title === 'conf') as unknown as { points: Array<{ value: number | null }> }).points.map((p) => p.value);
        const tc = (model.series.find((s) => s.title === 'tc') as unknown as { points: Array<{ value: number | null }> }).points.map((p) => p.value);
        expect(conf).toEqual([1, 1, 1, 1, 1, 0]);
        for (let i = 0; i < bars.length - 1; i++) {
            expect(tc[i]).toBe(bars[i + 1]!.time);
        }
    });

    it('fills strategy orders on closed recent tick bars (without calc_on_every_tick)', async () => {
        const src = `//@version=6
strategy("Tick strat", overlay=true)
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 4
    strategy.close("L")
`;
        const bars = recentTickBars(8);
        const prepared = preparePine(src, 'tick-strat');
        const res = await runPineStatic({
            ind: indicatorFor({}, src, {}),
            bars,
            market: { symbol: 'BTCUSDT', timeframe: '10T' },
            visibleRange: undefined,
            prepared,
            instanceId: 'tick-strat',
            inputs: {},
            fetchSeries: undefined,
        });
        expect(res.model?.trades?.length ?? 0).toBeGreaterThanOrEqual(1);
    });

    it('confirms the previously forming tick bar as soon as the next tick bar opens in a live stream', async () => {
        const src = `//@version=6
indicator("Tick live", overlay=false)
var int confirmed = 0
if barstate.isconfirmed
    confirmed += 1
plot(confirmed, "confirmed")
plot(barstate.isconfirmed ? 1 : 0, "isconf")
`;
        const bars = recentTickBars(5);
        const prepared = preparePine(src, 'tick-live');
        const emissions: Array<{ confirmed: number | null; isconf: number | null; len: number }> = [];
        const stream = openLiveStream({
            token: prepared.token as never,
            cache: {},
            prepared,
            inputs: {},
            bars: () => bars,
            market: () => ({ symbol: 'BTCUSDT', timeframe: '10T' }),
            onModel: (model) => {
                const cPts = (model.series.find((s) => s.title === 'confirmed') as unknown as { points: Array<{ value: number | null }> })?.points ?? [];
                const iPts = (model.series.find((s) => s.title === 'isconf') as unknown as { points: Array<{ value: number | null }> })?.points ?? [];
                emissions.push({
                    confirmed: cPts[cPts.length - 1]?.value ?? null,
                    isconf: iPts[iPts.length - 1]?.value ?? null,
                    len: cPts.length,
                });
            },
        });
        try {
            // Wait for initial historical + forming bar emission.
            const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<void> => {
                const end = Date.now() + timeoutMs;
                while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
            };
            await waitFor(() => emissions.length >= 1);
            expect(emissions[emissions.length - 1]).toEqual({ confirmed: 4, isconf: 0, len: 5 });

            // Open bar #5 (bar #4 closes now).
            const last = bars[bars.length - 1]!;
            bars.push({ time: last.time + 500, open: last.close, high: last.close + 1, low: last.close, close: last.close + 1, volume: 5 });
            stream.markDirty();
            await waitFor(() => emissions.some((e) => e.len === 6));
            expect(emissions[emissions.length - 1]).toEqual({ confirmed: 5, isconf: 0, len: 6 });
        } finally {
            stream.stop();
        }
    });
});
