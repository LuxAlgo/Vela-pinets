import { describe, it, expect } from 'vitest';
import { BULLISH, BEARISH } from '@luxalgo/vela/plugin';
import { indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';
import type { OHLCV, IndicatorModel, DrawingLabel } from '@luxalgo/vela/plugin';

/**
 * Marker semantics (plotshape / plotchar / plotarrow), end to end through real
 * PineTS:
 *  - UNTITLED marker calls each keep their own plot (the marker patch injects the
 *    callsite ids pinets' key resolution understands) — no last-call-wins collapse,
 *    and a non-first call's `display`/plot-level options are its own;
 *  - `plotchar` draws its CHARACTER (text-only label), not a circle;
 *  - `plotarrow` colors default to the semantic bullish/bearish palette, heights
 *    scale with |value| inside the minheight…maxheight window, and 0/na bars draw
 *    nothing.
 */

/** Alternating bars: even index up (close - open = +1), odd index down (-0.5). */
function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        const up = i % 2 === 0;
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 102 + i, low: 98 + i, close: up ? 101 + i : 99.5 + i, volume: 1 });
    }
    return out;
}

async function runModel(source: string, bars = 6): Promise<IndicatorModel> {
    const prepared = preparePine(source, 'mk-1');
    const ind = indicatorFor({}, source, {});
    const res = await runPineStatic({
        ind,
        bars: makeBars(bars),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'mk-1',
        inputs: {},
        fetchSeries: undefined,
    });
    return res.model!; // runs over real bars — never the null (zero-bar) outcome
}

const labelsOf = (model: IndicatorModel): DrawingLabel[] => model.labels ?? [];

describe('untitled markers keep their own plots (real PineTS run)', () => {
    it('two untitled plotshapes both paint, each with its own style/color/location', async () => {
        const model = await runModel(`//@version=6
indicator("markers collapse", overlay = true)
plotshape(true, style = shape.circle, color = color.red)
plotshape(true, style = shape.square, color = color.lime, location = location.belowbar)
`);
        const circles = labelsOf(model).filter((l) => l.style === 'circle');
        const squares = labelsOf(model).filter((l) => l.style === 'square');
        expect(circles).toHaveLength(6);
        expect(squares).toHaveLength(6);
        expect(circles.every((l) => l.yloc === 'abovebar')).toBe(true);
        expect(squares.every((l) => l.yloc === 'belowbar')).toBe(true);
        expect(new Set(circles.map((l) => l.color))).toEqual(new Set(['#F23645']));
        expect(new Set(squares.map((l) => l.color))).toEqual(new Set(['#00E676']));
    });

    it('a non-first untitled call owns its display: display.none hides ONLY that call', async () => {
        const model = await runModel(`//@version=6
indicator("mixed display", overlay = true)
plotshape(true, style = shape.circle, color = color.red)
plotshape(true, style = shape.square, color = color.lime, display = display.none)
`);
        expect(labelsOf(model).filter((l) => l.style === 'circle')).toHaveLength(6);
        expect(labelsOf(model).filter((l) => l.style === 'square')).toHaveLength(0);
    });

    it('two callsites REUSING one title stay separate plots', async () => {
        const model = await runModel(`//@version=6
indicator("same title", overlay = true)
plotshape(true, "Buy", style = shape.triangleup, color = color.green)
plotshape(true, "Buy", style = shape.triangledown, color = color.red, location = location.belowbar)
`);
        expect(labelsOf(model).filter((l) => l.style === 'triangleup')).toHaveLength(6);
        expect(labelsOf(model).filter((l) => l.style === 'triangledown')).toHaveLength(6);
    });

    it('a second run in the same process keys the same way (fresh per-context counters)', async () => {
        const source = `//@version=6
indicator("rerun", overlay = true)
plotshape(true, style = shape.circle, color = color.red)
plotshape(true, style = shape.square, color = color.lime)
`;
        const a = await runModel(source);
        const b = await runModel(source);
        expect(labelsOf(b).map((l) => l.id).sort()).toEqual(labelsOf(a).map((l) => l.id).sort());
        expect(labelsOf(b)).toHaveLength(12);
    });
});

describe('plotchar (real PineTS run)', () => {
    it('draws the character as a text-only label, painted in `color`', async () => {
        const model = await runModel(`//@version=6
indicator("pc", overlay = true)
plotchar(true, char = "•", color = color.red)
`);
        const labels = labelsOf(model);
        expect(labels).toHaveLength(6);
        for (const l of labels) {
            expect(l.style).toBe('none');
            expect(l.text).toBe('•');
            expect(l.textColor).toBe('#F23645');
            expect(l.yloc).toBe('abovebar');
        }
    });

    it('renders `text` under the character; an explicit textcolor wins', async () => {
        const model = await runModel(`//@version=6
indicator("pc2", overlay = true)
plotchar(true, char = "▲", color = color.red, text = "Buy", textcolor = color.white)
`);
        const l = labelsOf(model)[0]!;
        expect(l.text).toBe('▲\nBuy');
        expect(l.textColor).toBe('#FFFFFF');
    });

    it('falls back to the ★ default when char is omitted', async () => {
        const model = await runModel(`//@version=6
indicator("pc3", overlay = true)
plotchar(close > open, color = color.red)
`);
        const labels = labelsOf(model);
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.every((l) => l.text === '★' && l.style === 'none')).toBe(true);
    });
});

describe('plotarrow (real PineTS run)', () => {
    it('defaults to the semantic bullish/bearish palette and TV arrow anchors', async () => {
        const model = await runModel(`//@version=6
indicator("pa", overlay = true)
plotarrow(close - open)
`);
        const ups = labelsOf(model).filter((l) => l.style === 'arrowup');
        const downs = labelsOf(model).filter((l) => l.style === 'arrowdown');
        expect(ups).toHaveLength(3);
        expect(downs).toHaveLength(3);
        expect(ups.every((l) => l.color === BULLISH && l.yloc === 'belowbar')).toBe(true);
        expect(downs.every((l) => l.color === BEARISH && l.yloc === 'abovebar')).toBe(true);
    });

    it('scales arrows proportionally to |value| within minheight…maxheight', async () => {
        const model = await runModel(`//@version=6
indicator("pa2", overlay = true)
plotarrow(close - open)
`);
        // Up bars carry |+1| (the plot's max → maxheight 100px → huge); down bars
        // |−0.5| (5 + 0.5×95 = 52.5px → large).
        expect(labelsOf(model).filter((l) => l.style === 'arrowup').every((l) => l.size === 'huge')).toBe(true);
        expect(labelsOf(model).filter((l) => l.style === 'arrowdown').every((l) => l.size === 'large')).toBe(true);
    });

    it('honors explicit colorup/colordown and the minheight/maxheight window', async () => {
        const model = await runModel(`//@version=6
indicator("pa3", overlay = true)
plotarrow(close - open, colorup = color.aqua, colordown = color.orange, minheight = 5, maxheight = 60)
`);
        const ups = labelsOf(model).filter((l) => l.style === 'arrowup');
        const downs = labelsOf(model).filter((l) => l.style === 'arrowdown');
        expect(ups.every((l) => l.color === '#00BCD4')).toBe(true);
        expect(downs.every((l) => l.color === '#FF9800')).toBe(true);
        // The narrowed 5…60px window pulls the buckets down from huge/large.
        expect(ups.every((l) => l.size === 'large')).toBe(true); // 60px
        expect(downs.every((l) => l.size === 'normal')).toBe(true); // 32.5px
    });

    it('draws nothing on 0 and na bars', async () => {
        const model = await runModel(`//@version=6
indicator("pa4", overlay = true)
plotarrow(close > open ? close - open : bar_index % 4 == 1 ? 0 : na)
`);
        // Only the up bars (even indexes) carry a non-zero value: 3 arrows on 6 bars.
        expect(labelsOf(model)).toHaveLength(3);
        expect(labelsOf(model).every((l) => l.style === 'arrowup')).toBe(true);
    });
});
