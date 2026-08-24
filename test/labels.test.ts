import { describe, it, expect } from 'vitest';
import { indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';
import type { OHLCV, IndicatorModel, DrawingLabel } from '@luxalgo/vela/plugin';

/**
 * Label fidelity end to end through real PineTS: `textalign`, `tooltip`, and
 * `text_font_family` flow into the model, and `text_formatting` — which pinets
 * doesn't store at all — arrives through the label patch, from both the
 * `label.new` named argument and the (patched-in) namespace setters.
 */

function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1 });
    }
    return out;
}

async function runModel(source: string, bars = 4): Promise<IndicatorModel> {
    const prepared = preparePine(source, 'lb-1');
    const ind = indicatorFor({}, source, {});
    const res = await runPineStatic({
        ind,
        bars: makeBars(bars),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'lb-1',
        inputs: {},
        fetchSeries: undefined,
    });
    return res.model;
}

const labelsOf = (model: IndicatorModel): DrawingLabel[] => model.labels ?? [];

describe('label.new carries the full text styling into the model', () => {
    it('textalign, tooltip, and font family arrive as given', async () => {
        const model = await runModel(`//@version=6
indicator("label styling", overlay = true)
if barstate.islast
    label.new(bar_index, high, "A", textalign = text.align_left, tooltip = "the tip", text_font_family = font.family_monospace)
`);
        const labels = labelsOf(model);
        expect(labels).toHaveLength(1);
        expect(labels[0]!.textAlign).toBe('left');
        expect(labels[0]!.tooltip).toBe('the tip');
        expect(labels[0]!.fontFamily).toBe('monospace');
    });

    it('text_formatting as a named argument maps to bold/italic', async () => {
        const model = await runModel(`//@version=6
indicator("label formatting", overlay = true)
if barstate.islast
    label.new(bar_index, high, "B", text_formatting = text.format_bold + text.format_italic)
    label.new(bar_index, low, "P")
`);
        const labels = labelsOf(model);
        expect(labels).toHaveLength(2);
        const formatted = labels.find((l) => l.text === 'B')!;
        const plain = labels.find((l) => l.text === 'P')!;
        expect(formatted.bold).toBe(true);
        expect(formatted.italic).toBe(true);
        expect(plain.bold).toBe(false);
        expect(plain.italic).toBe(false);
    });

    it('bold alone stays bold-only', async () => {
        const model = await runModel(`//@version=6
indicator("bold only", overlay = true)
if barstate.islast
    label.new(bar_index, high, "B", text_formatting = text.format_bold)
`);
        const labels = labelsOf(model);
        expect(labels[0]!.bold).toBe(true);
        expect(labels[0]!.italic).toBe(false);
    });
});

describe('namespace setters the patch adds', () => {
    it('label.set_text_formatting styles an existing label', async () => {
        const model = await runModel(`//@version=6
indicator("set formatting", overlay = true)
if barstate.islast
    l = label.new(bar_index, high, "S")
    label.set_text_formatting(l, text.format_italic)
`);
        const labels = labelsOf(model);
        expect(labels).toHaveLength(1);
        expect(labels[0]!.italic).toBe(true);
        expect(labels[0]!.bold).toBe(false);
    });

    it('label.set_text_font_family switches an existing label to monospace', async () => {
        const model = await runModel(`//@version=6
indicator("set font", overlay = true)
if barstate.islast
    l = label.new(bar_index, high, "M")
    label.set_text_font_family(l, font.family_monospace)
`);
        const labels = labelsOf(model);
        expect(labels).toHaveLength(1);
        expect(labels[0]!.fontFamily).toBe('monospace');
    });
});
