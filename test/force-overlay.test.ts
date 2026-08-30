import { describe, it, expect } from 'vitest';
import { indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';
import type { OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';

/**
 * `force_overlay=true` mapping, end to end through real PineTS: every function that
 * records the flag must produce a model item with `overlay: true`, so Vela routes it
 * to the price pane. A fill() has no flag of its own in Pine (mixed-flag plots are a
 * compile error, CE10030) — it follows its anchor plots.
 */

const DRAWINGS_SOURCE = `//@version=6
indicator("FO drawings", overlay=false)
plot(ta.rsi(close, 14), "osc")
if barstate.islast
    line.new(bar_index - 8, close, bar_index, close, force_overlay=true)
    line.new(bar_index - 8, close - 1, bar_index, close - 1)
    label.new(bar_index, high, "F", force_overlay=true)
    label.new(bar_index, low, "P")
    box.new(bar_index - 6, high, bar_index - 2, low, force_overlay=true)
    box.new(bar_index - 12, high, bar_index - 9, low)
    polyline.new(array.from(chart.point.from_index(bar_index - 8, low), chart.point.from_index(bar_index - 4, high), chart.point.from_index(bar_index, low)), line_color=color.aqua, force_overlay=true)
    polyline.new(array.from(chart.point.from_index(bar_index - 8, low - 2), chart.point.from_index(bar_index - 4, high - 2), chart.point.from_index(bar_index, low - 2)), line_color=color.orange)
    f1 = line.new(bar_index - 8, high + 2, bar_index, high + 2, force_overlay=true)
    f2 = line.new(bar_index - 8, high + 4, bar_index, high + 4, force_overlay=true)
    linefill.new(f1, f2, color.new(color.blue, 80))
    p1 = line.new(bar_index - 8, high + 6, bar_index, high + 6)
    p2 = line.new(bar_index - 8, high + 8, bar_index, high + 8)
    linefill.new(p1, p2, color.new(color.red, 80))
    ft = table.new(position.top_right, 1, 1, bgcolor=color.new(color.blue, 80), frame_color=color.gray, frame_width=1, border_color=color.gray, border_width=1, force_overlay=true)
    table.cell(ft, 0, 0, "F")
    pt = table.new(position.bottom_left, 1, 1)
    table.cell(pt, 0, 0, "P")
`;

const SOURCE = `//@version=6
indicator("FO probe", overlay=false)
plot(close, "own")
plot(close, "p_fo", force_overlay=true)
plotshape(close > open, "ps_fo", style=shape.triangleup, force_overlay=true)
plotcandle(open, high, low, close, title="pc_fo", force_overlay=true)
bgcolor(close > open ? color.new(color.green, 80) : na, title="bg_fo", force_overlay=true)
f1 = plot(high, "f1", force_overlay=true)
f2 = plot(low, "f2", force_overlay=true)
fill(f1, f2, color=color.new(color.blue, 80), title="fill_fo")
g1 = plot(high + 1, "g1")
g2 = plot(low - 1, "g2")
fill(g1, g2, color=color.new(color.red, 80), title="fill_own")
if barstate.islast
    line.new(bar_index - 5, close, bar_index, close, force_overlay=true)
    label.new(bar_index, high, "L", force_overlay=true)
`;

function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1 });
    }
    return out;
}

async function runModel(source: string): Promise<IndicatorModel> {
    const prepared = preparePine(source, 'fo-1');
    const ind = indicatorFor({}, source, {});
    const res = await runPineStatic({
        ind,
        bars: makeBars(30),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'fo-1',
        inputs: {},
        fetchSeries: undefined,
    });
    return res.model!; // runs over real bars — never the null (zero-bar) outcome
}

describe('force_overlay mapping (real PineTS run)', () => {
    it('flags series, markers, backgrounds, drawings, and anchor-following fills', async () => {
        const model = await runModel(SOURCE);

        // plot(): only the flagged series carries overlay.
        expect(model.series.find((s) => s.title === 'own')?.overlay).toBeUndefined();
        expect(model.series.find((s) => s.title === 'p_fo')?.overlay).toBe(true);

        // plotcandle(): the candle series carries overlay.
        expect(model.series.find((s) => s.title === 'pc_fo')?.overlay).toBe(true);

        // plotshape() renders as labels — every rendered marker carries overlay.
        const markerLabels = model.labels?.filter((l) => l.id.includes(':ps_fo#')) ?? [];
        expect(markerLabels.length).toBeGreaterThan(0);
        expect(markerLabels.every((l) => l.overlay === true)).toBe(true);

        // bgcolor(): background spans carry overlay.
        expect(model.backgrounds.length).toBeGreaterThan(0);
        expect(model.backgrounds.every((b) => b.overlay === true)).toBe(true);

        // fill(): no flag of its own in Pine — it follows its anchors (both forced ⇒ overlay).
        expect(model.fills.find((f) => f.id.includes('fill_fo'))?.overlay).toBe(true);
        expect(model.fills.find((f) => f.id.includes('fill_own'))?.overlay).toBeUndefined();

        // line.new / label.new: the drawing objects carry overlay (parsed from the object).
        expect(model.lines?.length).toBe(1);
        expect(model.lines?.[0]?.overlay).toBe(true);
        const drawnLabel = model.labels?.find((l) => !l.id.includes(':ps_fo#'));
        expect(drawnLabel?.overlay).toBe(true);
    });

    it('flags every drawing constructor — forced instances true, plain controls false', async () => {
        const model = await runModel(DRAWINGS_SOURCE);

        // Each pair below: one drawing created with force_overlay=true, one without.
        const flags = (items?: ReadonlyArray<{ overlay?: boolean }>): boolean[] =>
            (items ?? []).map((d) => d.overlay === true).sort((a, b) => Number(b) - Number(a));

        // line.new: 2 standalone pairs + 4 linefill anchors (2 forced, 2 plain).
        expect(model.lines).toHaveLength(6);
        expect(model.lines!.filter((l) => l.overlay === true)).toHaveLength(3);

        expect(flags(model.labels)).toEqual([true, false]);
        expect(flags(model.boxes)).toEqual([true, false]);
        expect(flags(model.polylines)).toEqual([true, false]);
        expect(flags(model.tables)).toEqual([true, false]);

        // linefill.new follows its lines (PineTS stamps the linefill object itself when
        // its anchors are forced): the blue band between the two forced lines carries
        // the flag, the red band between the plain lines does not.
        expect(model.linefills).toHaveLength(2);
        const forcedFill = model.linefills!.find((lf) => lf.color?.startsWith('#2196F3'));
        const plainFill = model.linefills!.find((lf) => lf.color?.startsWith('#F23645'));
        expect(forcedFill?.overlay).toBe(true);
        expect(plainFill?.overlay).toBe(false);
    });
});
