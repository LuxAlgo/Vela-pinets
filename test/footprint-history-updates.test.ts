import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Context } from 'pinets';
import { PineEngine } from '../src/pinets/PineEngine';
import { PineWorkerEngine } from '../src/pinets-worker/PineWorkerEngine';
import type { FootprintBar, FootprintSource } from '../src/pinets/footprints';
import { loadLoopbackWorker } from './fixtures/loopbackWorker';
import type { ExecutionMarket, IndicatorModel, OHLCV, ScriptingEngine } from '@luxalgo/vela/plugin';

/**
 * A footprint source whose history arrives progressively: it answers with what it holds
 * and tells its listeners (`onChange`) when it holds more. A script reads its history
 * once per run, so each engine must run the script again over the whole history — the
 * worker engine through the real worker module and the protocol, as in a browser.
 */

const MARKET: ExecutionMarket = { symbol: 'BTCUSDT', timeframe: '15', symbolInfo: { ticker: 'BTCUSDT', mintick: 0.5 } };
const T0 = 1_700_000_000_000;
const TF_MS = 15 * 60_000;

function bar(i: number): OHLCV {
    const close = 102 + i * 0.5;
    return { time: T0 + i * TF_MS, open: close - 0.5, high: close + 2, low: close - 2, close, volume: 100 };
}

/** Delta 48 with rows of 1.0 (`ticks_per_row = 2`): the reference footprint of the footprints suite. */
const LEVELS = [
    { price: 100.0, buyVolume: 10, sellVolume: 5 },
    { price: 100.5, buyVolume: 20, sellVolume: 5 },
    { price: 101.0, buyVolume: 5, sellVolume: 40 },
    { price: 101.5, buyVolume: 0, sellVolume: 10 },
    { price: 102.0, buyVolume: 60, sellVolume: 6 },
    { price: 104.5, buyVolume: 20, sellVolume: 1 },
];
const fpBar = (i: number): FootprintBar => ({ openTime: bar(i).time, levels: LEVELS });

const SOURCE = `//@version=6
indicator("Footprint history probe")
footprint fp = request.footprint(2, 70, 300)
plot(na(fp) ? na : fp.delta(), "d")
`;

/** The source of the test in progress: what it holds, who listens, what was asked, and a gate holding its first history answer back. */
const state = {
    held: [] as FootprintBar[],
    listeners: new Set<() => void>(),
    historyAsks: [] as Array<{ from?: number; to?: number; limit?: number }>,
    gate: null as Promise<void> | null,
};
const footprints: FootprintSource = Object.assign(
    async (_symbol: string, _timeframe: string, range: { from?: number; to?: number; limit?: number }) => {
        const answer = state.held.filter((b) => range.from === undefined || b.openTime >= range.from);
        if (range.limit == null) return answer; // a tail poll
        state.historyAsks.push(range);
        if (state.gate && state.historyAsks.length === 1) await state.gate;
        return answer;
    },
    {
        onChange: (_symbol: string, _timeframe: string, listener: () => void): (() => void) => {
            state.listeners.add(listener);
            return () => void state.listeners.delete(listener);
        },
    },
);
const grow = (...bars: FootprintBar[]): void => {
    state.held.push(...bars);
    for (const listener of [...state.listeners]) listener();
};

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 20));
    }
}

const deltas = (model: IndicatorModel | undefined, bars: OHLCV[]): Array<number | null> => {
    const series = model?.series.find((s) => s.title === 'd' && 'points' in s) as { points: Array<{ value: number | null }> } | undefined;
    return bars.map((_, i) => series?.points[i]?.value ?? null);
};

const pinetsHasFootprints = ((): boolean => {
    try {
        return typeof (new Context({ marketData: [], source: [] }) as unknown as { pine: Record<string, unknown> }).pine.footprint === 'object';
    } catch {
        return false;
    }
})();

let loopback: Awaited<ReturnType<typeof loadLoopbackWorker>>;
const engines: Record<string, ScriptingEngine> = {};
beforeAll(async () => {
    loopback = await loadLoopbackWorker();
    engines.PineEngine = new PineEngine({ footprints });
    // ONE engine on the loopback: every engine bound to it hears every reply.
    engines.PineWorkerEngine = new PineWorkerEngine({ createWorker: () => loopback.worker, footprints });
});
afterAll(() => loopback.restore());

describe.skipIf(!pinetsHasFootprints).each(['PineEngine', 'PineWorkerEngine'])('a footprint source that gains history, through %s', (name) => {
    const reset = (...held: FootprintBar[]): void => {
        state.held = held;
        state.listeners.clear();
        state.historyAsks = [];
        state.gate = null;
    };

    it.each(['static', 'live'] as const)('a %s script is recomputed over its whole history each time more of it lands', async (mode) => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        reset(fpBar(3)); // the newest bar's footprint is held; the older ones land later
        const engine = engines[name]!;
        const prepared = await engine.prepare(SOURCE, `fp-updates-${name}-${mode}`);
        const models: IndicatorModel[] = [];
        const errors: Error[] = [];
        const session = engine.execute(
            { prepared, market: MARKET, bars, getBars: () => bars, inputs: {}, mode },
            { onModel: (m) => models.push(m), onError: (e) => errors.push(e) },
        );
        const latest = (): Array<number | null> => deltas(models[models.length - 1], bars);

        await waitFor(() => latest()[3] === 48 || errors.length > 0);
        expect(errors).toEqual([]);
        expect(latest()).toEqual([null, null, null, 48]);
        // The engine listens for this series, and its history ask ends where the chart does.
        expect(state.listeners.size).toBe(1);
        expect(state.historyAsks[0]).toMatchObject({ from: bar(0).time, to: bar(3).time + TF_MS, limit: 4 });

        grow(fpBar(1));
        await waitFor(() => latest()[1] === 48 || errors.length > 0);
        expect(latest()).toEqual([null, 48, null, 48]);

        grow(fpBar(0), fpBar(2));
        await waitFor(() => latest()[0] === 48 || errors.length > 0);
        expect(errors).toEqual([]);
        expect(latest()).toEqual([48, 48, 48, 48]);

        session.stop();
        expect(state.listeners.size).toBe(0);
    }, 30_000);

    it.each(['static', 'live'] as const)('a %s script still on its run folds the changes into one more run', async (mode) => {
        const bars = [bar(0), bar(1), bar(2), bar(3)];
        reset(fpBar(3));
        let release!: () => void;
        state.gate = new Promise<void>((r) => (release = r));
        const engine = engines[name]!;
        const prepared = await engine.prepare(SOURCE, `fp-fold-${name}-${mode}`);
        const models: IndicatorModel[] = [];
        const errors: Error[] = [];
        const session = engine.execute(
            { prepared, market: MARKET, bars, getBars: () => bars, inputs: {}, mode },
            { onModel: (m) => models.push(m), onError: (e) => errors.push(e) },
        );
        await waitFor(() => state.historyAsks.length === 1);
        // A source signalling faster than a run takes: redoing the run on each signal would
        // never let one finish.
        grow(fpBar(1));
        grow(fpBar(0), fpBar(2));
        await new Promise((r) => setTimeout(r, 50));
        expect(state.historyAsks).toHaveLength(1);

        release();
        await waitFor(() => deltas(models[models.length - 1], bars)[0] === 48 || errors.length > 0);
        await new Promise((r) => setTimeout(r, 100));
        session.stop();
        expect(errors).toEqual([]);
        expect(deltas(models[models.length - 1], bars)).toEqual([48, 48, 48, 48]);
        expect(state.historyAsks).toHaveLength(2); // one more run for both changes
    }, 30_000);
});
