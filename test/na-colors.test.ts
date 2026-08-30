import { describe, it, expect } from 'vitest';
import { indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';
import { INVISIBLE_COLOR } from '../src/pinets/colors';
import type { OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';

/**
 * Pine `na` / `color(na)` color semantics, end to end through real PineTS:
 *  - a plot bar whose color evaluates to `na` is INVISIBLE (transparent per-point
 *    override), while the point itself survives so fills keep their anchors;
 *  - a plot whose color is `na` on every bar stays a hidden series;
 *  - a marker (plotshape) bar whose color evaluates to `na` draws nothing;
 *  - a label with `color = na` keeps its declared STYLE (the renderer places the
 *    text by the bubble geometry and skips only the fill — `noFill`).
 */

const PLOTS_SOURCE = `//@version=6
indicator("na plot colors")
plot(close, "p_cond", color = close > open ? color.red : na)
plot(close + 1, "p_na", color = na)
plot(close + 2, "p_colorna", color = color(na))
plot(close + 3, "p_plain")
plotshape(true, "ps_cond", style=shape.triangleup, color = close > open ? color.red : na)
`;

// The reported repro, verbatim (plus a `na` variant and a filled control).
const LABELS_SOURCE = `//@version=6
indicator("My script")
if barstate.islast
    label.new(bar_index, 0, 'Text', color = color(na), style = label.style_label_up)
    label.new(bar_index - 1, 0, 'Text', color = na, style = label.style_label_down)
    label.new(bar_index - 2, 0, 'Text', color = color.blue, style = label.style_label_up)

plot(0)
`;

/** Alternating up/down bars so a `close > open ? c : na` color flips every bar. */
function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        const up = i % 2 === 0;
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 102 + i, low: 98 + i, close: up ? 101 + i : 99.5 + i, volume: 1 });
    }
    return out;
}

async function runModel(source: string): Promise<IndicatorModel> {
    const prepared = preparePine(source, 'na-1');
    const ind = indicatorFor({}, source, {});
    const res = await runPineStatic({
        ind,
        bars: makeBars(30),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'na-1',
        inputs: {},
        fetchSeries: undefined,
    });
    return res.model!; // runs over real bars — never the null (zero-bar) outcome
}

describe('na / color(na) as plot colors (real PineTS run)', () => {
    it('hides exactly the bars whose conditional color evaluates to na', async () => {
        const model = await runModel(PLOTS_SOURCE);
        const cond = model.series.find((s) => s.title === 'p_cond');
        expect(cond?.visible).not.toBe(false);
        const points = (cond as { points: Array<{ value: number | null; color?: string }> }).points;
        expect(points).toHaveLength(30);
        for (let i = 0; i < points.length; i += 1) {
            // Up bars (even index) painted red; down bars invisible — never the series fallback.
            expect(points[i]!.color).toBe(i % 2 === 0 ? '#F23645' : INVISIBLE_COLOR);
            expect(points[i]!.value).not.toBeNull(); // the value survives (fills, readouts)
        }
    });

    it('keeps a whole-plot na color as a hidden series (na and color(na) alike)', async () => {
        const model = await runModel(PLOTS_SOURCE);
        for (const title of ['p_na', 'p_colorna']) {
            const s = model.series.find((x) => x.title === title);
            expect(s?.visible).toBe(false);
        }
    });

    it('leaves a plot without a color argument untouched — no invisible overrides', async () => {
        const model = await runModel(PLOTS_SOURCE);
        const plain = model.series.find((s) => s.title === 'p_plain');
        expect(plain?.visible).not.toBe(false);
        const points = (plain as { points: Array<{ color?: string }> }).points;
        expect(points.every((p) => p.color !== INVISIBLE_COLOR)).toBe(true);
    });

    it('drops plotshape markers on bars whose color evaluates to na', async () => {
        const model = await runModel(PLOTS_SOURCE);
        const markers = model.labels?.filter((l) => l.id.includes(':ps_cond#')) ?? [];
        // The shape condition is `true` on all 30 bars, but only the 15 up bars have a color.
        expect(markers).toHaveLength(15);
    });
});

describe('na / color(na) as label colors (real PineTS run)', () => {
    it('keeps the declared style and marks the bubble noFill instead of dropping it', async () => {
        const model = await runModel(LABELS_SOURCE);
        const labels = [...(model.labels ?? [])].sort((a, b) => a.x - b.x);
        expect(labels).toHaveLength(3);

        const [filled, naColor, colorNa] = labels; // x ascending: blue, na, color(na)
        expect(filled?.noFill).toBe(false);
        expect(filled?.style).toBe('label_up');

        // `color = na` and `color = color(na)` behave identically: style preserved, fill off.
        expect(naColor?.noFill).toBe(true);
        expect(naColor?.style).toBe('label_down');
        expect(colorNa?.noFill).toBe(true);
        expect(colorNa?.style).toBe('label_up');
        expect(colorNa?.text).toBe('Text');
    });
});
