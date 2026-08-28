import { describe, it, expect } from 'vitest';
import { Vela } from '@luxalgo/vela';
import type { MarketDataFeed, VelaTheme, IndicatorRenderHandle, VisibleRange, InputChangeEvent, CrosshairEvent, ClickEvent } from '@luxalgo/vela';
import type { OHLCV, Pane, IndicatorModel, ScenePatch, InputValue } from '@luxalgo/vela/plugin';
import { PineEngine } from '../src/pinets/PineEngine';
import { normalizeContext } from '../src/pinets/normalizeContext';
import { preparePine, indicatorFor, runPineStatic } from '../src/pinets/runtime';

type Unsubscribe = () => void;

/**
 * The product invariant under test: an indicator lands on the price pane IFF its
 * DECLARATION says `overlay=true` — in every declaration shape (named, positional),
 * for indicator() and strategy() alike, and from the very first (placeholder) mount,
 * never "mounts in a sub pane, then jumps to price" (or the reverse).
 *
 * Overlay used to be read from two lossy sources evaluated at two different times:
 * a raw-source regex at prepare (blind to positional args, fooled by comments and
 * `force_overlay`) and the runtime context after the first run (the strategy runtime
 * drops positional declaration args; a variable arg arrives as a Series, not a
 * boolean). Whichever disagreed with the other moved the pane mid-load.
 */

// ── prepare layer: the declared overlay is scanned from the AST, not the raw text ──

const prepOverlay = (source: string): boolean => preparePine(source, 'ov-probe').meta.overlay;

describe('preparePine declared overlay', () => {
    it('named form, both values', () => {
        expect(prepOverlay('//@version=5\nindicator("I", overlay=true)\nplot(close)\n')).toBe(true);
        expect(prepOverlay('//@version=5\nindicator("I", overlay=false)\nplot(close)\n')).toBe(false);
    });

    it('positional form — indicator("I", "i", true)', () => {
        expect(prepOverlay('//@version=5\nindicator("I", "i", true)\nplot(close)\n')).toBe(true);
    });

    it('positional form — strategy("S", "s", true)', () => {
        expect(prepOverlay('//@version=5\nstrategy("S", "s", true)\nplot(close)\n')).toBe(true);
    });

    it('defaults to false when the declaration omits overlay', () => {
        expect(prepOverlay('//@version=5\nindicator("I")\nplot(close)\n')).toBe(false);
    });

    it('a plot\'s force_overlay=true never counts as the declaration overlay', () => {
        expect(prepOverlay('//@version=5\nindicator("I", overlay=false)\nplot(close, force_overlay=true)\n')).toBe(false);
    });

    it('overlay=true inside a comment or a string literal never counts', () => {
        expect(prepOverlay('//@version=5\n// overlay=true\nindicator("I")\nplot(close)\n')).toBe(false);
        expect(prepOverlay('//@version=5\nindicator("I overlay=true")\nplot(close)\n')).toBe(false);
    });

    it('an assignment to a variable merely ENDING in "overlay" never counts', () => {
        expect(prepOverlay('//@version=5\nmy_overlay = true\nindicator("I")\nplot(close)\n')).toBe(false);
    });
});

// ── normalizeContext: the declaration is read type-aware and shape-tolerant ──

describe('normalizeContext declared overlay', () => {
    it('strategy.config wins over a default-initialized ctx.indicator', () => {
        const run = normalizeContext({
            plots: {},
            // Some PineTS versions default-initialize `indicator` even for strategy
            // scripts (the type declares it non-optional) — the spec defaults, not
            // the declaration.
            indicator: { title: 'Indicator', overlay: false },
            strategy: { config: { title: 'S', overlay: true }, closedtrades: [], opentrades: [] },
        });
        expect(run.meta.title).toBe('S');
        expect(run.meta.overlay).toBe(true);
    });

    it('a Series-shaped overlay (variable declaration arg) unwraps to its value', () => {
        const run = normalizeContext({ plots: {}, indicator: { title: 'I', overlay: { data: [true, true], offset: 0 } } });
        expect(run.meta.overlay).toBe(true);
    });
});

// ── model layer: real PineTS runs — the computed model carries the declared overlay ──

function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1 });
    }
    return out;
}

async function runModel(source: string, props: Record<string, InputValue> = {}): Promise<IndicatorModel> {
    const prepared = preparePine(source, 'ov-1');
    const res = await runPineStatic({
        ind: indicatorFor({}, source, {}, props),
        bars: makeBars(30),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'ov-1',
        inputs: {},
        props,
        fetchSeries: undefined,
    });
    return res.model;
}

describe('computed model overlay (real PineTS run)', () => {
    it('a positional strategy overlay survives the run (the runtime drops the arg)', async () => {
        const model = await runModel('//@version=5\nstrategy("S", "s", true)\nplot(close)\n');
        expect(model.overlay).toBe(true);
        expect(model.paneHint).toBe('price');
    });

    it('a positional indicator overlay survives the run', async () => {
        const model = await runModel('//@version=5\nindicator("I", "i", true)\nplot(close)\n');
        expect(model.overlay).toBe(true);
        expect(model.paneHint).toBe('price');
    });

    it('overlay=false stays false even with a force_overlay plot', async () => {
        const model = await runModel('//@version=5\nindicator("I", overlay=false)\nplot(close, force_overlay=true)\n');
        expect(model.overlay).toBe(false);
        expect(model.paneHint).toBe('new');
    });

    it('a variable declaration arg falls back to the runtime value (Series unwrap)', async () => {
        const model = await runModel('//@version=5\nov = true\nindicator("I", overlay=ov)\nplot(close)\n');
        expect(model.overlay).toBe(true);
        expect(model.paneHint).toBe('price');
    });

    it('a host prop override of overlay beats the declaration (mutable per the spec)', async () => {
        const forcedOff = await runModel('//@version=5\nindicator("I", overlay=true)\nplot(close)\n', { overlay: false });
        expect(forcedOff.overlay).toBe(false);
        expect(forcedOff.paneHint).toBe('new');

        const forcedOn = await runModel('//@version=5\nindicator("I", overlay=false)\nplot(close)\n', { overlay: true });
        expect(forcedOn.overlay).toBe(true);
        expect(forcedOn.paneHint).toBe('price');
    });
});

// ── end-to-end: pane routing through the built Vela, placeholder included ──

const BARS = makeBars(60);

class FixedFeed implements MarketDataFeed {
    load(): Promise<OHLCV[]> {
        return Promise.resolve(BARS.map((b) => ({ ...b })));
    }
    subscribe(): Unsubscribe {
        return () => {};
    }
}

/** Minimal renderer fake: records every mounted model (placeholder AND computed remount). */
class RecordingRenderer {
    readonly name = 'fake';
    readonly features: readonly string[] = [];
    readonly capabilities = {
        panes: true, paneManagement: false, fills: 'native', bgcolor: 'native', hline: 'native', markers: true,
        barcolor: 'native', perPointColor: true, drawings: true, userDrawings: false, tables: true, trades: true, inputsUI: true,
    } as const;
    mountedModels: IndicatorModel[] = [];
    bars: OHLCV[] = [];
    mount(_c: HTMLElement, _t: VelaTheme): void {}
    setTheme(): void {}
    resize(): void {}
    destroy(): void {}
    applyFeature(): void {}
    readFeature(): unknown {
        return undefined;
    }
    setBars(bars: OHLCV[]): void {
        this.bars = bars;
    }
    updateBar(): void {}
    ensurePane(_p: Pane): void {}
    removePane(): void {}
    mountIndicator(model: IndicatorModel): IndicatorRenderHandle {
        this.mountedModels.push(model);
        return { id: model.id };
    }
    updateIndicator(_h: IndicatorRenderHandle, _p: ScenePatch): void {}
    removeIndicator(): void {}
    setIndicatorInputs(_h: IndicatorRenderHandle, _v: Record<string, InputValue>): void {}
    onInputChange(_cb: (e: InputChangeEvent) => void): Unsubscribe {
        return () => {};
    }
    onRemoveIndicator(_cb: (id: string) => void): Unsubscribe {
        return () => {};
    }
    onCrosshairMove(_cb: (e: CrosshairEvent) => void): Unsubscribe {
        return () => {};
    }
    onClick(_cb: (e: ClickEvent) => void): Unsubscribe {
        return () => {};
    }
    getVisibleRange(): VisibleRange | null {
        return null;
    }
    setVisibleRange(): void {}
    onViewportChange(_cb: (r: VisibleRange) => void): Unsubscribe {
        return () => {};
    }
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 50));
    }
}

/** Add `source` with no options and return every paneId it was ever mounted on. */
async function mountedPanes(source: string): Promise<string[]> {
    const renderer = new RecordingRenderer();
    const chart = new Vela(
        {} as unknown as HTMLElement,
        { symbol: 'TEST', timeframe: '60', live: false, volume: false },
        { renderer, engines: [new PineEngine()], dataFeed: new FixedFeed() },
    );
    const errors: string[] = [];
    chart.on('indicator:error', (e) => errors.push(e.error.message));
    let ready = false;
    chart.on('indicator:added', () => {
        ready = true;
    });
    const h = chart.addIndicator(source);
    await chart.ready();
    await waitFor(() => ready || errors.length > 0);
    expect(errors).toEqual([]);
    const panes = renderer.mountedModels.filter((m) => m.id === h.id).map((m) => m.paneId ?? 'unrouted');
    chart.destroy();
    return panes;
}

describe('pane routing through the built Vela (no options passed)', () => {
    it('a positional-overlay indicator sits on the price pane from the placeholder on — never a sub pane', async () => {
        const panes = await mountedPanes('//@version=5\nindicator("IPos", "ip", true)\nplot(close)\n');
        expect(panes.length).toBeGreaterThanOrEqual(1);
        expect(panes.every((p) => p === 'price')).toBe(true);
    }, 30_000);

    it('a positional-overlay strategy sits on the price pane from the placeholder on', async () => {
        const panes = await mountedPanes('//@version=5\nstrategy("SPos", "sp", true)\nplot(close)\n');
        expect(panes.length).toBeGreaterThanOrEqual(1);
        expect(panes.every((p) => p === 'price')).toBe(true);
    }, 30_000);

    it('an overlay=false indicator with a force_overlay plot never touches the price pane', async () => {
        const panes = await mountedPanes('//@version=5\nindicator("Sub", overlay=false)\nplot(close, force_overlay=true)\n');
        expect(panes.length).toBeGreaterThanOrEqual(1);
        expect(panes.every((p) => p !== 'price')).toBe(true);
    }, 30_000);
});
