import { describe, it, expect } from 'vitest';
import { isVisibleColor, normColor } from '../src/pinets/colors';
import { indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';
import type { OHLCV, IndicatorModel } from '@luxalgo/vela/plugin';

/**
 * `rgb(r, g, 0)` has an opaque blue channel of zero — it is NOT a transparent color.
 * The old check `/rgba?\(…,\s*0\)$/` matched it and silently dropped pure red / yellow / green-ish
 * plots (e.g. `color.rgb(255, 0, 0)`), while only `rgba(…, 0)` (alpha 0) should be hidden.
 */
describe('isVisibleColor: rgb() vs rgba() alpha', () => {
    it.each([
        'rgb(255, 0, 0)', // pure red
        'rgb(255,255,0)', // yellow
        'rgb(0, 255, 0)', // pure green
        'rgb(0, 0, 0)', // black
        'RGB(255, 0, 0)',
        'rgba(255, 0, 0, 1)',
        'rgba(255, 0, 0, 0.5)',
        'rgba(0, 0, 0, 0.01)',
    ])('%s is visible', (c) => {
        expect(isVisibleColor(c)).toBe(true);
        expect(normColor(c, 'fallback')).toBe(c);
    });

    it.each(['rgba(255, 0, 0, 0)', 'rgba(255,0,0,0.0)', 'rgba(0, 0, 0, 0)', 'RGBA(1, 2, 3, 0)', 'rgba(1,2,3, 0.00)', 'na', '#00000000', ''])('%s is hidden', (c) => {
        expect(isVisibleColor(c)).toBe(false);
    });
});

const SOURCE = `//@version=6
indicator("rgb plot colors")
plot(close, "red_line", color = color.rgb(255, 0, 0))
plot(close + 1, "yellow_line", color = color.rgb(255, 255, 0))
plot(close + 2, "cond_line", color = close > open ? color.rgb(0, 255, 30) : color.rgb(255, 0, 0))
plot(close + 3, "transparent_line", color = color.rgb(255, 0, 0, 100))
`;

function makeBars(n: number): OHLCV[] {
    return Array.from({ length: n }, (_, i) => ({
        time: 1_700_000_000_000 + i * 60_000,
        open: 100 + i,
        high: 102 + i,
        low: 98 + i,
        close: i % 2 === 0 ? 101 + i : 99.5 + i,
        volume: 1,
    }));
}

async function runModel(): Promise<IndicatorModel> {
    const prepared = preparePine(SOURCE, 'rgb-1');
    const res = await runPineStatic({
        ind: indicatorFor({}, SOURCE, {}),
        bars: makeBars(30),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'rgb-1',
        inputs: {},
        fetchSeries: undefined,
    });
    return res.model!;
}

describe('color.rgb(r, g, 0) plots (real PineTS run)', () => {
    it('keeps pure red / yellow / conditional red-green plots visible', async () => {
        const model = await runModel();
        for (const title of ['red_line', 'yellow_line', 'cond_line']) {
            const s = model.series.find((x) => x.title === title);
            expect(s, title).toBeDefined();
            expect(s?.visible, `${title} must not be hidden`).not.toBe(false);
        }
        const cond = model.series.find((x) => x.title === 'cond_line') as { points: Array<{ color?: string }> };
        const colors = new Set(cond.points.map((p) => p.color));
        expect([...colors].sort()).toEqual(['rgb(0, 255, 30)', 'rgb(255, 0, 0)'].sort());
    });

    it('still hides a genuinely transparent color (alpha 0)', async () => {
        const model = await runModel();
        const s = model.series.find((x) => x.title === 'transparent_line');
        expect(s?.visible).toBe(false);
    });
});
