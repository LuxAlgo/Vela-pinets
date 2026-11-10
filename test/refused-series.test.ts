import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PineEngine } from '../src/pinets/PineEngine';
import { PineWorkerEngine } from '../src/pinets-worker/PineWorkerEngine';
import { isSeriesRefusal, rememberRefusals } from '../src/pinets/refusals';
import { loadLoopbackWorker } from './fixtures/loopbackWorker';
import type { ExecutionMarket, ExecutionSession, FetchSeries, OHLCV, IndicatorModel, LineLikeSeries, EngineWarning } from '@luxalgo/vela/plugin';

/**
 * A script asks a series its source never serves: an economic monthly series at an hourly
 * timeframe. Vela's gateway then rejects with a `DataUnavailableError` (a transient failure
 * would read as an empty series instead). The script stops on it with its self-explaining
 * message, or reads na with a warning under `ignore_invalid_symbol`, and the session never
 * asks the source for that series again. Both engines behave the same, the worker one
 * through the real worker module and protocol.
 */

/** Vela's `DataUnavailableError` as Vela builds it: its name, plain fields and the message built from them. */
class DataUnavailableError extends Error {
    override readonly name = 'DataUnavailableError';
    readonly reason = 'timeframe';
    constructor(
        readonly symbol: string,
        readonly timeframe: string,
        readonly finest: string,
    ) {
        super(`${symbol} is not served at ${timeframe}; its finest timeframe is ${finest}`);
    }
}

const REFUSAL = 'CPIAUCSL is not served at 60; its finest timeframe is 1M';
const MARKET: ExecutionMarket = { symbol: 'BTCUSDT', timeframe: '60', symbolInfo: { ticker: 'BTCUSDT', mintick: 0.01 } };
const H = 3_600_000;
const T0 = 1_700_002_800_000; // on the hour

function makeBars(): OHLCV[] {
    return Array.from({ length: 48 }, (_, i) => ({ time: T0 + i * H, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
}

/** A gateway whose source serves the economic series at 1M only, and logs every request it receives. */
function economicGateway(log: string[]): FetchSeries {
    return async (symbol, timeframe) => {
        log.push(`${symbol}@${timeframe}`);
        if (symbol === 'CPIAUCSL' && timeframe !== '1M') throw new DataUnavailableError(symbol, timeframe, '1M');
        return [];
    };
}

const SECURITY = `//@version=6
indicator("Refused series")
plot(request.security("FRED:CPIAUCSL", "60", close), "cpi")
plot(close, "close")
`;
const SECURITY_IGNORED = SECURITY.replace('close), "cpi"', 'close, ignore_invalid_symbol = true), "cpi"');
const LOWER_TF = `//@version=6
indicator("Refused lower timeframe")
a = request.security_lower_tf("FRED:CPIAUCSL", "15", close)
plot(array.size(a), "n")
`;

interface Run {
    session: ExecutionSession;
    models: IndicatorModel[];
    errors: Error[];
    warnings: EngineWarning[];
    until(done: () => boolean): Promise<void>;
}

async function start(engine: PineEngine | PineWorkerEngine, source: string, mode: 'static' | 'live', fetchSeries: FetchSeries): Promise<Run> {
    const prepared = await engine.prepare(source, `refused-${mode}`);
    const bars = makeBars();
    const run: Omit<Run, 'session'> = {
        models: [],
        errors: [],
        warnings: [],
        until: async (done) => {
            const deadline = Date.now() + 10_000;
            while (!done()) {
                if (Date.now() > deadline) throw new Error('timed out');
                await new Promise((r) => setTimeout(r, 20));
            }
        },
    };
    const session = engine.execute(
        { prepared, market: MARKET, bars, getBars: () => bars, inputs: {}, mode, fetchSeries },
        { onModel: (m) => run.models.push(m), onError: (e) => run.errors.push(e), onWarning: (w) => run.warnings.push(w) },
    );
    return { ...run, session };
}

const values = (m: IndicatorModel, title: string): Array<number | null> => (m.series.find((s) => s.title === title) as LineLikeSeries).points.map((p) => p.value);

let loopback: Awaited<ReturnType<typeof loadLoopbackWorker>>;
beforeAll(async () => {
    loopback = await loadLoopbackWorker();
});
afterAll(() => loopback.restore());

const ENGINES = {
    PineEngine: () => new PineEngine(),
    PineWorkerEngine: () => new PineWorkerEngine({ createWorker: () => loopback.worker }),
};

describe.each(Object.entries(ENGINES))('a series the source refuses, through %s', (_name, create) => {
    const engine = create();

    it('stops the script with the refusal, named by its series and finest timeframe', async () => {
        const run = await start(engine, SECURITY, 'static', economicGateway([]));
        await run.until(() => run.errors.length > 0);
        run.session.stop();
        const [error] = run.errors;
        expect(error?.message).toBe(REFUSAL);
        expect(isSeriesRefusal(error)).toBe(true);
        expect(error).toMatchObject({ reason: 'timeframe', symbol: 'CPIAUCSL', timeframe: '60', finest: '1M' });
        expect(run.models).toHaveLength(0);
    });

    it('reads na with a warning when the script ignores invalid symbols', async () => {
        const run = await start(engine, SECURITY_IGNORED, 'static', economicGateway([]));
        await run.until(() => run.models.length > 0);
        run.session.stop();
        const model = run.models[0]!;
        expect(values(model, 'cpi').every((v) => v === null)).toBe(true);
        expect(values(model, 'close')).toEqual(makeBars().map((b) => b.close));
        expect(run.warnings.map((w) => w.message)).toContain(`request.security(CPIAUCSL, 60) returns na: ${REFUSAL}`);
        expect(run.errors).toHaveLength(0);
    });

    it('stops a lower-timeframe request the same way', async () => {
        const run = await start(engine, LOWER_TF, 'static', economicGateway([]));
        await run.until(() => run.errors.length > 0);
        run.session.stop();
        expect(run.errors[0]?.message).toBe('CPIAUCSL is not served at 15; its finest timeframe is 1M');
        expect(isSeriesRefusal(run.errors[0])).toBe(true);
    });

    it('asks the source once per session, not on every run', async () => {
        const log: string[] = [];
        const run = await start(engine, SECURITY_IGNORED, 'static', economicGateway(log));
        await run.until(() => run.models.length === 1);
        run.session.notifyBars();
        await run.until(() => run.models.length === 2);
        run.session.notifyBars();
        await run.until(() => run.models.length === 3);
        run.session.stop();
        expect(log).toEqual(['CPIAUCSL@60']);
    });

    it('stops a live script with the refusal too', async () => {
        const log: string[] = [];
        const run = await start(engine, SECURITY, 'live', economicGateway(log));
        await run.until(() => run.errors.length > 0);
        run.session.stop();
        expect(run.errors[0]?.message).toBe(REFUSAL);
        expect(isSeriesRefusal(run.errors[0])).toBe(true);
        expect(log).toEqual(['CPIAUCSL@60']);
    });
});

describe('rememberRefusals', () => {
    const range = { limit: 10 };

    it('replays a refusal for the same series without asking the source again', async () => {
        const log: string[] = [];
        const gateway = rememberRefusals(economicGateway(log));
        const first = await gateway('CPIAUCSL', '60', range).catch((e: unknown) => e);
        const second = await gateway('CPIAUCSL', '60', range).catch((e: unknown) => e);
        expect(second).toBe(first);
        expect(log).toEqual(['CPIAUCSL@60']);
    });

    it('still asks for the same symbol at another timeframe', async () => {
        const log: string[] = [];
        const gateway = rememberRefusals(economicGateway(log));
        await gateway('CPIAUCSL', '60', range).catch(() => undefined);
        await expect(gateway('CPIAUCSL', '1M', range)).resolves.toEqual([]);
        expect(log).toEqual(['CPIAUCSL@60', 'CPIAUCSL@1M']);
    });

    it('asks again after a transient failure or an empty answer', async () => {
        let calls = 0;
        const gateway = rememberRefusals(async () => {
            calls += 1;
            if (calls === 1) throw new Error('network down');
            return [];
        });
        await expect(gateway('ETHUSDT', '60', range)).rejects.toThrow('network down');
        await expect(gateway('ETHUSDT', '60', range)).resolves.toEqual([]);
        await expect(gateway('ETHUSDT', '60', range)).resolves.toEqual([]);
        expect(calls).toBe(3);
    });

    it('passes an absent gateway through', () => {
        expect(rememberRefusals(undefined)).toBeUndefined();
    });
});
