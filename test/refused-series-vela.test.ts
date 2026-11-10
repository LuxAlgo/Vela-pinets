import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Vela, MultiProviderFeed, BarStore, DataUnavailableError, isDataUnavailableError } from '@luxalgo/vela';
import type { VisibleRange, InputChangeEvent, CrosshairEvent, ClickEvent, IndicatorRenderHandle } from '@luxalgo/vela';
import type { DataProvider, OHLCV, Pane, IndicatorModel, ScenePatch, InputValue, LineLikeSeries } from '@luxalgo/vela/plugin';
import { PineEngine } from '../src/pinets/PineEngine';
import { PineWorkerEngine } from '../src/pinets-worker/PineWorkerEngine';
import { isSeriesRefusal, refusalError, refusalFields } from '../src/pinets/refusals';
import { loadLoopbackWorker } from './fixtures/loopbackWorker';

/**
 * END TO END with the published Vela: a data provider that serves an economic series at
 * daily and coarser timeframes only throws Vela's own `DataUnavailableError` for anything
 * finer; Vela's provider feed and gateway carry it to THIS package's engines, and the script
 * reports it. The engines recognize it without importing Vela's guard (see
 * `src/pinets/refusals.ts`), so both guards must agree on the same objects.
 */

type Unsubscribe = () => void;
const DAY = 86_400_000;

/** Serves `GDP` and `CPI` at D/W/M only, refusing anything finer for good; logs every request. */
function macroProvider() {
    const asked: string[] = [];
    const provider: DataProvider = {
        getBars(ticker, tf, range) {
            asked.push(`${ticker}@${tf}`);
            if (!['D', '1D', 'W', 'M'].includes(tf)) return Promise.reject(new DataUnavailableError({ reason: 'timeframe', finest: '1D', default: '1D' }));
            const n = range.limit ?? 50;
            const start = Date.UTC(2026, 0, 1);
            return Promise.resolve(Array.from({ length: n }, (_, i) => ({ time: start + i * DAY, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i })));
        },
        listSymbols: () => Promise.resolve([{ ticker: 'GDP' }, { ticker: 'CPI' }]),
    };
    return { provider, asked };
}

/** Minimal renderer: records the mounted models. */
class FakeRenderer {
    readonly name = 'fake';
    readonly features: readonly string[] = [];
    readonly capabilities = {
        panes: true, paneManagement: false, fills: 'native', bgcolor: 'native', hline: 'native', markers: true,
        barcolor: 'native', perPointColor: true, drawings: true, userDrawings: false, tables: true, inputsUI: true,
    } as const;
    models: IndicatorModel[] = [];
    mount(): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    applyFeature(): void {}
    readFeature(): unknown { return undefined; }
    setBars(_bars: OHLCV[]): void {}
    updateBar(): void {}
    ensurePane(_p: Pane): void {}
    removePane(): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle { this.models.push(model); return { id: model.id }; }
    updateIndicator(_h: IndicatorRenderHandle, _p: ScenePatch): void {}
    removeIndicator(): void {}
    setIndicatorInputs(_h: IndicatorRenderHandle, _v: Record<string, InputValue>): void {}
    onInputChange(_cb: (e: InputChangeEvent) => void): Unsubscribe { return () => {}; }
    onRemoveIndicator(_cb: (id: string) => void): Unsubscribe { return () => {}; }
    onCrosshairMove(_cb: (e: CrosshairEvent) => void): Unsubscribe { return () => {}; }
    onClick(_cb: (e: ClickEvent) => void): Unsubscribe { return () => {}; }
    getVisibleRange(): VisibleRange | null { return null; }
    setVisibleRange(): void {}
    onViewportChange(_cb: (r: VisibleRange) => void): Unsubscribe { return () => {}; }
    onPriceStyleChange(): Unsubscribe { return () => {}; }
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 20));
    }
}

const REFUSED = `//@version=6
indicator("Refused through Vela")
plot(request.security("CPI", "60", close), "cpi")
`;
const IGNORED = `//@version=6
indicator("Ignored through Vela")
plot(request.security("CPI", "60", close, ignore_invalid_symbol = true), "cpi")
plot(close, "close")
`;
const MESSAGE = 'CPI is not served at 60; its finest timeframe is 1D';

let loopback: Awaited<ReturnType<typeof loadLoopbackWorker>>;
beforeAll(async () => {
    loopback = await loadLoopbackWorker();
});
afterAll(() => loopback.restore());

const charts: Vela[] = [];
afterEach(() => {
    for (const c of charts.splice(0)) c.destroy();
    vi.restoreAllMocks();
});

function chartWith(engine: PineEngine | PineWorkerEngine) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const macro = macroProvider();
    const renderer = new FakeRenderer();
    const chart = new Vela({} as HTMLElement, { symbol: 'GDP', timeframe: 'D', live: false, volume: false }, { renderer, engines: [engine], dataFeed: new MultiProviderFeed(new BarStore()) });
    charts.push(chart);
    void chart.data.registerProvider('macro', macro.provider);
    const errors: Error[] = [];
    const unavailable: unknown[] = [];
    chart.on('indicator:error', (e) => errors.push(e.error));
    chart.on('data:unavailable', (e) => unavailable.push(e));
    return { chart, renderer, macro, errors, unavailable };
}

describe('the engines and Vela agree on what a refusal is', () => {
    it("Vela's own error reads as a refusal here", () => {
        const e = new DataUnavailableError({ reason: 'timeframe', symbol: 'CPI', timeframe: '60', finest: '1D' });
        expect(isSeriesRefusal(e)).toBe(true);
        expect(refusalFields(e)).toEqual({ reason: 'timeframe', symbol: 'CPI', timeframe: '60', finest: '1D' });
    });

    it("the refusal rebuilt across the worker boundary passes Vela's guard", () => {
        const e = new DataUnavailableError({ reason: 'timeframe', symbol: 'CPI', timeframe: '60', finest: '1D', default: 'M' });
        const rebuilt = refusalError(e.message, structuredClone(refusalFields(e)));
        expect(isDataUnavailableError(rebuilt)).toBe(true);
        expect(rebuilt).toMatchObject({ message: e.message, reason: 'timeframe', symbol: 'CPI', timeframe: '60', finest: '1D', default: 'M' });
    });

    it('a plain error is a refusal for neither', () => {
        expect(isSeriesRefusal(new Error('network down'))).toBe(false);
        expect(isDataUnavailableError(new Error('network down'))).toBe(false);
    });
});

const ENGINES = {
    PineEngine: () => new PineEngine(),
    PineWorkerEngine: () => new PineWorkerEngine({ createWorker: () => loopback.worker }),
};

describe.each(Object.entries(ENGINES))('a refused series through the published Vela and %s', (_name, create) => {
    const engine = create();

    it("stops the script with the source's refusal, and leaves the chart alone", async () => {
        const { chart, macro, errors, unavailable } = chartWith(engine);
        await chart.ready();
        chart.addIndicator(REFUSED);
        await waitFor(() => errors.length > 0);
        expect(errors[0]?.message).toBe(MESSAGE);
        expect(isDataUnavailableError(errors[0])).toBe(true);
        expect(errors[0]).toMatchObject({ reason: 'timeframe', symbol: 'CPI', timeframe: '60', finest: '1D' });
        expect(unavailable).toEqual([]); // a script's request never refuses the chart's own market
        expect(chart.market.timeframe).toBe('D');
        expect(macro.asked.filter((a) => a === 'CPI@60')).toHaveLength(1);
    });

    it('reads na under ignore_invalid_symbol while the chart series still computes', async () => {
        const { chart, renderer, errors } = chartWith(engine);
        await chart.ready();
        chart.addIndicator(IGNORED);
        // Vela mounts a placeholder first; the computed model carries the plots.
        const computed = () => renderer.models.find((m) => m.series.length > 0);
        await waitFor(() => computed() !== undefined || errors.length > 0);
        expect(errors).toEqual([]);
        const series = (title: string) => (computed()!.series.find((s) => s.title === title) as LineLikeSeries).points.map((p) => p.value);
        expect(series('cpi').every((v) => v === null)).toBe(true);
        expect(series('close').some((v) => typeof v === 'number')).toBe(true);
    });
});
