import { describe, it, expect } from 'vitest';
import { toScene } from '../src/pinets/toScene';
import { indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';
import type { PineRun, PinePlot } from '../src/pinets/PineRun';
import type { LineLikeSeries, CandleSeries, IndicatorModel, OHLCV } from '@luxalgo/vela/plugin';

const HOUR = 3600000;

/** A value plot (line unless a `style_*` is given), one point per hourly bar. */
function plotOf(key: string, values: Array<number | null>, options: Record<string, unknown> = {}, style?: string): PinePlot {
    return {
        key,
        title: key,
        style,
        options: style ? { style, ...options } : options,
        data: values.map((v, i) => ({ time: i * HOUR, value: v, options: {} })),
    };
}

function runOf(plots: PinePlot[], overlay = false): PineRun {
    return { meta: { title: 'T', overlay }, plots };
}

function onlySeries(plots: PinePlot[], overlay = false): LineLikeSeries {
    const { model } = toScene(runOf(plots, overlay), 'ind');
    return model.series[0] as LineLikeSeries;
}

const ALL = { pane: true, priceScale: true, legend: true, dataWindow: true };
const NONE = { pane: false, priceScale: false, legend: false, dataWindow: false };

describe('toScene · display', () => {
    it('display.status_line → legend only: off the pane (points kept), off the scale and data window', () => {
        const s = onlySeries([plotOf('P', [1, 2, 3], { color: '#888888', display: 'status_line' })]);
        expect(s.display).toEqual({ ...NONE, legend: true });
        expect(s.visible).toBe(false); // the pane-only shorthand older Vela versions read
        expect(s.points).toHaveLength(3);
    });

    it('display.data_window → data window only', () => {
        const s = onlySeries([plotOf('P', [1, 2, 3], { color: '#888888', display: 'data_window' })]);
        expect(s.display).toEqual({ ...NONE, dataWindow: true });
        expect(s.visible).toBe(false);
    });

    it('display.price_scale → on the scale but not painted, also in a study pane (overlay=false)', () => {
        const s = onlySeries([plotOf('P', [1, 2, 3], { color: '#888888', display: 'price_scale' })], false);
        expect(s.display).toEqual({ ...NONE, priceScale: true });
        expect(s.visible).toBe(false);
    });

    it('display.none → nowhere', () => {
        const s = onlySeries([plotOf('P', [1, 2, 3], { color: '#888888', display: 'none' })]);
        expect(s.display).toEqual(NONE);
        expect(s.visible).toBe(false);
    });

    it('display.pane → painted only; display.all / default → everywhere', () => {
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888', display: 'pane' })]).display).toEqual({ ...NONE, pane: true });
        for (const display of ['all', undefined]) {
            const s = onlySeries([plotOf('P', [1, 2], { color: '#888888', display })]);
            expect(s.display).toEqual(ALL);
            expect(s.visible).toBe(true);
        }
    });

    it('`+`-combined display (concatenated enum strings) is the union of its members', () => {
        expect(onlySeries([plotOf('P', [1], { color: '#888888', display: 'panedata_window' })]).display).toEqual({ ...NONE, pane: true, dataWindow: true });
        expect(onlySeries([plotOf('P', [1], { color: '#888888', display: 'status_lineprice_scale' })]).display).toEqual({ ...NONE, legend: true, priceScale: true });
        expect(onlySeries([plotOf('P', [1], { color: '#888888', display: 'data_windowstatus_linepane' })]).display).toEqual({ ...ALL, priceScale: false });
        expect(onlySeries([plotOf('P', [1], { color: '#888888', display: 'allprice_scale' })]).display).toEqual(ALL);
        expect(onlySeries([plotOf('P', [1], { color: '#888888', display: 'nonepane' })]).display).toEqual({ ...NONE, pane: true });
    });

    it('an unreadable display (the NaN a PineTS without set operations yields for `display.a - display.b`) shows everywhere', () => {
        expect(onlySeries([plotOf('Sub', [1], { color: '#888888', display: NaN })]).display).toEqual(ALL);
        expect(onlySeries([plotOf('J', [1], { color: '#888888', display: 'sideways' })]).display).toEqual(ALL);
    });

    it('a `na` color takes the plot off the pane only — its value still reads, display.all stays on the scale', () => {
        const s = onlySeries([plotOf('P', [1, 2], { color: 'rgba(0, 0, 0, 0)' })]);
        expect(s.display).toEqual({ ...ALL, pane: false });
        expect(s.visible).toBe(false);
        expect(s.points).toHaveLength(2);
    });

    it('plotcandle / plotbar carry their display too', () => {
        const candle: PinePlot = {
            key: 'C', title: 'C', style: 'candle', options: { style: 'candle', display: 'data_window' },
            data: [{ time: 0, value: [10, 12, 9, 11], options: {} }],
        };
        const { model } = toScene(runOf([candle], true), 'ind');
        const s = model.series[0] as CandleSeries;
        expect(s.kind).toBe('candle');
        expect(s.display).toEqual({ ...NONE, dataWindow: true });
        expect(s.visible).toBe(false);
    });

    it('hline display.none → no price line; display.all → price line', () => {
        const hline = (display: string): PinePlot => ({
            key: 'L',
            title: 'L',
            style: 'hline',
            options: { style: 'hline', color: '#888888', display },
            data: [{ time: 0, value: 70, options: {} }],
        });
        expect(toScene(runOf([hline('none')]), 'ind').model.priceLines).toHaveLength(0);
        expect(toScene(runOf([hline('all')]), 'ind').model.priceLines).toHaveLength(1);
    });

    it('fill display.none → no fill in the model (and no warning)', () => {
        const anchors = [plotOf('A', [1, 2], { color: '#888888' }), plotOf('B', [0, 0], { color: '#888888' })];
        const fill: PinePlot = {
            key: 'F',
            title: 'F',
            style: 'fill',
            options: { style: 'fill', color: '#11223344', display: 'none' },
            plot1: 'A',
            plot2: 'B',
            data: [{ time: 0, value: true, options: {} }, { time: HOUR, value: true, options: {} }],
        };
        const { model, warnings } = toScene(runOf([...anchors, fill]), 'ind');
        expect(model.fills).toHaveLength(0);
        expect(warnings).toHaveLength(0);
    });

    it('plotshape display.none → no labels; bgcolor display.none → no backgrounds; barcolor display.none → no barColors', () => {
        const shape: PinePlot = {
            key: 'S',
            style: 'shape',
            options: { style: 'shape', color: '#00ff00', display: 'none' },
            data: [{ time: 0, value: true, options: {} }],
        };
        const bg: PinePlot = {
            key: 'BG',
            style: 'background',
            options: { style: 'background', display: 'none' },
            data: [{ time: 0, value: true, options: { color: '#00ff0080' } }],
        };
        const bc: PinePlot = {
            key: 'BC',
            style: 'barcolor',
            options: { style: 'barcolor', display: 'none' },
            data: [{ time: 0, value: true, options: { color: '#00ff00ff' } }],
        };
        const { model } = toScene(runOf([shape, bg, bc]), 'ind');
        expect(model.labels).toHaveLength(0);
        expect(model.backgrounds).toHaveLength(0);
        expect(model.barColors).toBeUndefined();
    });
});

describe('toScene · hline linestyle', () => {
    const hline = (options: Record<string, unknown>): PinePlot => ({
        key: 'L',
        title: 'L',
        style: 'hline',
        options: { style: 'hline', color: '#888888', ...options },
        data: [{ time: 0, value: 70, options: {} }],
    });

    it('defaults to dashed when linestyle is omitted', () => {
        const { model } = toScene(runOf([hline({})]), 'ind');
        expect(model.priceLines[0]!.lineStyle).toBe('dashed');
    });

    it('explicit solid stays solid (not swallowed by the default)', () => {
        const { model } = toScene(runOf([hline({ linestyle: 'solid' })]), 'ind');
        expect(model.priceLines[0]!.lineStyle).toBe('solid');
    });

    it('explicit dotted stays dotted', () => {
        const { model } = toScene(runOf([hline({ linestyle: 'dotted' })]), 'ind');
        expect(model.priceLines[0]!.lineStyle).toBe('dotted');
    });
});

describe('toScene · linewidth', () => {
    it('defaults to 1 for every line-like kind', () => {
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888' })]).style.width).toBe(1);
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888' }, 'style_stepline')]).style.width).toBe(1);
    });

    it('explicit linewidth passes through', () => {
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888', linewidth: 3 })]).style.width).toBe(3);
    });
});

describe('toScene · histbase', () => {
    it('maps to style.base for histogram, columns, and area', () => {
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888', histbase: 15 }, 'style_histogram')]).style.base).toBe(15);
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888', histbase: -5 }, 'style_columns')]).style.base).toBe(-5);
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888', histbase: 10 }, 'style_area')]).style.base).toBe(10);
    });

    it('is ignored for the line family, and absent when not given', () => {
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888', histbase: 15 })]).style.base).toBeUndefined();
        expect(onlySeries([plotOf('P', [1, 2], { color: '#888888' }, 'style_histogram')]).style.base).toBeUndefined();
    });
});

describe('toScene · show_last', () => {
    it('line: keeps the last N bars plus the entering segment anchor', () => {
        const s = onlySeries([plotOf('P', [10, 20, 30, 40, 50], { color: '#888888', show_last: 2 })]);
        expect(s.points.map((p) => p.value)).toEqual([null, null, 30, 40, 50]);
    });

    it('histogram: keeps exactly the last N bars', () => {
        const s = onlySeries([plotOf('P', [10, 20, 30, 40, 50], { color: '#888888', show_last: 2 }, 'style_histogram')]);
        expect(s.points.map((p) => p.value)).toEqual([null, null, null, 40, 50]);
    });

    it('a window at least as large as the data leaves it untouched', () => {
        const s = onlySeries([plotOf('P', [10, 20], { color: '#888888', show_last: 5 })]);
        expect(s.points.map((p) => p.value)).toEqual([10, 20]);
    });

    it('markers: only the last N bars produce labels', () => {
        const shape: PinePlot = {
            key: 'S',
            style: 'shape',
            options: { style: 'shape', color: '#00ff00', show_last: 2 },
            data: [0, 1, 2, 3, 4].map((i) => ({ time: i * HOUR, value: true, options: {} })),
        };
        const { model } = toScene(runOf([shape]), 'ind');
        expect(model.labels).toHaveLength(2);
        expect(model.labels!.map((l) => l.x)).toEqual([3 * HOUR, 4 * HOUR]);
    });

    it('plotcandle: bars before the window vanish but the array stays index-aligned', () => {
        const candle: PinePlot = {
            key: 'C',
            style: 'candle',
            options: { style: 'candle', show_last: 2 },
            data: [0, 1, 2, 3].map((i) => ({ time: i * HOUR, value: [10 + i, 12 + i, 9 + i, 11 + i], options: {} })),
        };
        const { model } = toScene(runOf([candle], true), 'ind');
        const c = model.series[0] as CandleSeries;
        expect(c.bars).toHaveLength(4);
        expect(c.bars[0]).toBeUndefined();
        expect(c.bars[1]).toBeUndefined();
        expect(c.bars[2]!.close).toBe(13);
        expect(c.bars[3]!.close).toBe(14);
    });

    it('bgcolor: only the last N bars tint the background', () => {
        const bg: PinePlot = {
            key: 'BG',
            style: 'background',
            options: { style: 'background', show_last: 2 },
            data: [0, 1, 2, 3].map((i) => ({ time: i * HOUR, value: true, options: { color: '#00ff0080' } })),
        };
        const { model } = toScene(runOf([bg]), 'ind');
        expect(model.backgrounds).toHaveLength(1);
        expect(model.backgrounds[0]!.from).toBe(2 * HOUR);
        expect(model.backgrounds[0]!.to).toBe(4 * HOUR);
    });

    it('barcolor: only the last N bars recolor', () => {
        const bc: PinePlot = {
            key: 'BC',
            style: 'barcolor',
            options: { style: 'barcolor', show_last: 2 },
            data: [0, 1, 2, 3].map((i) => ({ time: i * HOUR, value: true, options: { color: '#00ff00ff' } })),
        };
        const { model } = toScene(runOf([bc]), 'ind');
        expect(model.barColors!.map((b) => b.time)).toEqual([2 * HOUR, 3 * HOUR]);
    });
});

describe('toScene · trackprice', () => {
    it('emits a dotted price line at the last value, styled from the plot', () => {
        const { model } = toScene(runOf([plotOf('P', [10, 20, 30], { color: '#ff0000', linewidth: 2, trackprice: true })]), 'ind');
        expect(model.priceLines).toHaveLength(1);
        const pl = model.priceLines[0]!;
        expect(pl.price).toBe(30);
        expect(pl.lineStyle).toBe('dotted');
        expect(pl.width).toBe(2);
        expect(pl.color).toBe('#ff0000');
    });

    it('tracks the last FINITE value past a na tail', () => {
        const { model } = toScene(runOf([plotOf('P', [10, 20, null], { color: '#ff0000', trackprice: true })]), 'ind');
        expect(model.priceLines[0]!.price).toBe(20);
    });

    it('survives display.none — the level-only Pine idiom', () => {
        const { model } = toScene(runOf([plotOf('P', [10, 20], { color: '#ff0000', trackprice: true, display: 'none' })]), 'ind');
        expect(model.series[0]!.visible).toBe(false);
        expect(model.priceLines).toHaveLength(1);
        expect(model.priceLines[0]!.price).toBe(20);
    });

    it('absent (the default) → no price line', () => {
        const { model } = toScene(runOf([plotOf('P', [10, 20], { color: '#ff0000' })]), 'ind');
        expect(model.priceLines).toHaveLength(0);
    });
});

describe('display through real PineTS (member names; `+` / `-` as set operations where pinets computes them)', () => {
    function bars(n: number): OHLCV[] {
        const out: OHLCV[] = [];
        for (let i = 0; i < n; i += 1) out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1 });
        return out;
    }

    async function run(source: string): Promise<IndicatorModel> {
        const prepared = preparePine(source, 'd-1');
        const ind = indicatorFor({}, source, {});
        const res = await runPineStatic({ ind, bars: bars(4), market: { symbol: 'TEST', timeframe: '60' }, visibleRange: undefined, prepared, instanceId: 'd-1', inputs: {}, fetchSeries: undefined });
        return res.model!;
    }

    const byTitle = (model: IndicatorModel, title: string): LineLikeSeries => model.series.find((s) => s.title === title) as LineLikeSeries;

    it('maps each constant and a `+` union to its surfaces', async () => {
        const model = await run(`//@version=6
indicator("display", overlay = true)
plot(close, "A", display = display.all)
plot(close, "B", display = display.pane + display.data_window)
plot(close, "C", display = display.status_line)
plot(close, "D", display = display.none)
plot(close, "E")
`);
        expect(byTitle(model, 'A').display).toEqual(ALL);
        expect(byTitle(model, 'B').display).toEqual({ ...NONE, pane: true, dataWindow: true });
        expect(byTitle(model, 'C').display).toEqual({ ...NONE, legend: true });
        expect(byTitle(model, 'D').display).toEqual(NONE);
        expect(byTitle(model, 'E').display).toEqual(ALL);
    });

    it('`-` and the `none` / `all` boundaries are set operations (a pinets that only concatenates shows the `-` plots everywhere)', async () => {
        const model = await run(`//@version=6
indicator("display minus", overlay = true)
plot(close, "AllMinusPriceScale", display = display.all - display.price_scale)
plot(close, "AllMinusNone", display = display.all - display.none)
plot(close, "AllPlusNone", display = display.all + display.none)
plot(close, "NonePlusAll", display = display.none + display.all)
plot(close, "NoneMinusAll", display = display.none - display.all)
`);
        expect(byTitle(model, 'AllPlusNone').display).toEqual(ALL);
        expect(byTitle(model, 'NonePlusAll').display).toEqual(ALL);
        expect(byTitle(model, 'AllMinusNone').display).toEqual(ALL);
        // pinets ≤ 0.9.33 hands NaN for `-` (native string subtraction), read as every surface;
        // a pinets with set operations drops exactly the subtracted surfaces.
        const minusPriceScale = byTitle(model, 'AllMinusPriceScale').display;
        const subtracts = minusPriceScale?.priceScale === false;
        expect(minusPriceScale).toEqual(subtracts ? { ...ALL, priceScale: false } : ALL);
        expect(byTitle(model, 'NoneMinusAll').display).toEqual(subtracts ? NONE : ALL);
    });
});
