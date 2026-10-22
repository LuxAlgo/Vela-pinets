import { describe, it, expect } from 'vitest';
import { PineEngine } from '../src/pinets/PineEngine';
import { PineWorkerEngine } from '../src/pinets-worker/PineWorkerEngine';
import type { PineLibraryImport, PineToken } from '../src/pinets/runtime';
import type { MainToWorker, WorkerToMain, WorkerLike } from '../src/pinets-worker/protocol';
import type { ExecutionRequest, IndicatorModel, LineLikeSeries, OHLCV } from '@luxalgo/vela/plugin';

const HELPERS = `//@version=6
library("Helpers")

export enum Mode
    fast = "Fast"
    slow = "Slow"

export double(float x) => x * 2
`;

const SCRIPT = `//@version=6
indicator("Uses helpers", overlay = true)
import acme/Helpers/1 as h

h.Mode mode = input.enum(h.Mode.fast, "Mode")
plot(h.double(close), "doubled")
`;

const resolver = (path: string): string | null => (path === 'acme/Helpers/1' ? HELPERS : null);

function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 });
    }
    return out;
}

function runOnce(engine: PineEngine, prepared: ExecutionRequest['prepared']): Promise<IndicatorModel> {
    const bars = makeBars(20);
    return new Promise((resolve, reject) => {
        engine.execute(
            { prepared, market: { symbol: 'TEST', timeframe: '1' }, bars, getBars: () => bars, inputs: {}, mode: 'static' },
            { onModel: resolve, onError: reject },
        );
    });
}

const lastValue = (model: IndicatorModel, title: string): unknown => {
    const series = model.series.find((s) => s.title === title) as LineLikeSeries | undefined;
    return series?.points.at(-1)?.value;
};

describe('Pine scripts that import libraries', () => {
    it('run with the library the engine resolver serves', async () => {
        const engine = new PineEngine({ importResolver: resolver });
        const model = await runOnce(engine, await engine.prepare(SCRIPT, 'lib-1'));
        expect(lastValue(model, 'doubled')).toBe(238);
    });

    it('offer an imported enum input with its options in the settings dialog', async () => {
        const prepared = await new PineEngine({ importResolver: resolver }).prepare(SCRIPT, 'lib-1');
        const mode = prepared.inputs.find((i) => i.title === 'Mode');
        expect(mode).toMatchObject({ defval: 'Fast', options: ['Fast', 'Slow'] });
    });

    it('keep running where only the prepared script travels, as in the worker', async () => {
        const prepared = await new PineEngine({ importResolver: resolver }).prepare(SCRIPT, 'lib-1');
        expect((prepared.token as PineToken).libraries).toEqual({ 'acme/Helpers/1': HELPERS });
        const model = await runOnce(new PineEngine(), structuredClone(prepared));
        expect(lastValue(model, 'doubled')).toBe(238);
    });

    it('fail to prepare, naming the import, when the resolver does not know the library', async () => {
        const engine = new PineEngine({ importResolver: () => null });
        await expect(engine.prepare(SCRIPT, 'lib-1')).rejects.toThrow('acme/Helpers/1');
    });

    it('ask nothing of the resolver when the script imports no library', async () => {
        const asked: string[] = [];
        const engine = new PineEngine({ importResolver: (path) => (asked.push(path), null) });
        await engine.prepare('//@version=6\nindicator("Plain")\nplot(close)\n', 'plain-1');
        expect(asked).toEqual([]);
    });
});

class FakeWorker implements WorkerLike {
    posted: MainToWorker[] = [];
    private listener: ((e: { data: unknown }) => void) | null = null;
    postMessage(msg: unknown): void {
        this.posted.push(msg as MainToWorker);
    }
    addEventListener(_t: 'message', cb: (e: { data: unknown }) => void): void {
        this.listener = cb;
    }
    terminate(): void {}
    reply(msg: WorkerToMain): void {
        this.listener?.({ data: msg });
    }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const INFO: PineLibraryImport = { path: 'acme/Helpers/1', user: 'acme', name: 'Helpers', version: 1 };

describe('The worker engine serves library requests from the main thread', () => {
    it('answers each library the worker asks for with the resolver source', async () => {
        const fake = new FakeWorker();
        const engine = new PineWorkerEngine({ createWorker: () => fake, importResolver: resolver });
        void engine.prepare(SCRIPT, 'lib-1');
        expect(fake.posted.at(-1)).toMatchObject({ kind: 'prepare', importResolver: true });

        fake.reply({ kind: 'resolveImport', reqId: 7, path: INFO.path, info: INFO });
        fake.reply({ kind: 'resolveImport', reqId: 8, path: 'acme/Missing/1', info: { ...INFO, path: 'acme/Missing/1', name: 'Missing' } });
        await flush();
        expect(fake.posted).toContainEqual({ kind: 'resolveImportResult', reqId: 7, source: HELPERS });
        expect(fake.posted).toContainEqual({ kind: 'resolveImportResult', reqId: 8, source: null });
    });

    it('reports a failing resolver to the worker instead of leaving the script waiting', async () => {
        const fake = new FakeWorker();
        const engine = new PineWorkerEngine({
            createWorker: () => fake,
            importResolver: () => Promise.reject(new Error('library server down')),
        });
        void engine.prepare(SCRIPT, 'lib-1');
        fake.reply({ kind: 'resolveImport', reqId: 3, path: INFO.path, info: INFO });
        await flush();
        expect(fake.posted).toContainEqual({ kind: 'resolveImportResult', reqId: 3, error: 'library server down' });
    });

    it('does not offer a resolver to the worker when the engine has none', () => {
        const fake = new FakeWorker();
        void new PineWorkerEngine({ createWorker: () => fake }).prepare(SCRIPT, 'lib-1');
        expect(fake.posted.at(-1)).not.toHaveProperty('importResolver');
    });
});
