import { describe, it, expect } from 'vitest';
import { indicatorFor, runPineStatic, preparePine } from '../src/pinets/runtime';
import type { OHLCV, DrawingTable } from '@luxalgo/vela/plugin';

/**
 * Pine table argument fidelity, end to end through real PineTS:
 *  - `table.cell_set_text_formatting` exists (patched in) and reaches the model,
 *  - `table.cell(text_formatting=…)` routes into bold/italic instead of
 *    polluting the positional `width` slot,
 *  - repeated `table.merge_cells` neither duplicates merge regions nor marks
 *    the ORIGIN cell as absorbed,
 *  - cell `width`/`height` percents and integer pixel `text_size` map through.
 */

function makeBars(n: number): OHLCV[] {
    const out: OHLCV[] = [];
    for (let i = 0; i < n; i += 1) {
        out.push({ time: 1_700_000_000_000 + i * 60_000, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1 });
    }
    return out;
}

async function runTables(source: string): Promise<DrawingTable[]> {
    const prepared = preparePine(source, 'tbl-1');
    const ind = indicatorFor({}, source, {});
    const res = await runPineStatic({
        ind,
        bars: makeBars(6),
        market: { symbol: 'TEST', timeframe: '60' },
        visibleRange: undefined,
        prepared,
        instanceId: 'tbl-1',
        inputs: {},
        fetchSeries: undefined,
    });
    return res.model!.tables ?? []; // runs over real bars — never the null (zero-bar) outcome
}

describe('pine tables · text_formatting', () => {
    it('table.cell_set_text_formatting exists and marks the cell bold', async () => {
        const [t] = await runTables(`//@version=6
indicator("t")
var t = table.new(position.top_right, 1, 1)
if barstate.islast
    table.cell(t, 0, 0, "B")
    table.cell_set_text_formatting(t, 0, 0, text.format_bold)
plot(close)
`);
        expect(t!.cells[0]![0]).toMatchObject({ text: 'B', bold: true, italic: false });
    });

    it('table.cell(text_formatting=…) sets bold+italic and leaves width alone', async () => {
        const [t] = await runTables(`//@version=6
indicator("t")
var t = table.new(position.top_right, 1, 1)
if barstate.islast
    table.cell(t, 0, 0, "BI", text_formatting=text.format_bold + text.format_italic)
plot(close)
`);
        expect(t!.cells[0]![0]).toMatchObject({ text: 'BI', bold: true, italic: true });
        expect(t!.cells[0]![0]!.width).toBeUndefined();
    });

    it('the positional 14-argument table.cell form routes text_formatting too', async () => {
        const [t] = await runTables(`//@version=6
indicator("t")
var t = table.new(position.top_right, 1, 1)
if barstate.islast
    table.cell(t, 0, 0, "P", 0, 0, color.white, text.align_center, text.align_center, size.normal, color.blue, "", font.family_default, text.format_italic)
plot(close)
`);
        expect(t!.cells[0]![0]).toMatchObject({ text: 'P', bold: false, italic: true });
    });
});

describe('pine tables · merge_cells called every bar', () => {
    const SOURCE = `//@version=6
indicator("t")
var t = table.new(position.top_right, 3, 2)
table.cell(t, 0, 0, "TITLE")
table.cell(t, 0, 1, "a")
table.cell(t, 1, 1, "b")
table.cell(t, 2, 1, "c")
table.merge_cells(t, 0, 0, 2, 0)
plot(close)
`;

    it('keeps ONE merge region, not one per bar', async () => {
        const [t] = await runTables(SOURCE);
        expect(t!.merges).toEqual([{ startCol: 0, startRow: 0, endCol: 2, endRow: 0 }]);
    });

    it('the merge origin is not absorbed; the other region cells are', async () => {
        const [t] = await runTables(SOURCE);
        const row0 = t!.cells[0]!;
        expect(row0[0]).toMatchObject({ text: 'TITLE' });
        expect(row0[0]!.merged).not.toBe(true);
        expect(row0[1]!.merged).toBe(true);
        expect(row0[2]!.merged).toBe(true);
    });
});

describe('pine tables · cell sizing', () => {
    it('maps width/height percents and integer pixel text_size', async () => {
        const [t] = await runTables(`//@version=6
indicator("t")
var t = table.new(position.top_right, 2, 1)
if barstate.islast
    table.cell(t, 0, 0, "W", width=10, height=5, text_size=14)
    table.cell(t, 1, 0, "N", text_size=size.large)
plot(close)
`);
        expect(t!.cells[0]![0]).toMatchObject({ width: 10, height: 5, textSize: 14 });
        expect(t!.cells[0]![1]).toMatchObject({ textSize: 'large' });
        expect(t!.cells[0]![1]!.width).toBeUndefined();
    });

    it('an allocated-but-never-filled var table still reaches the model (hiding is the renderer side)', async () => {
        const [t] = await runTables(`//@version=6
indicator("t")
var t = table.new(position.top_right, 3, 4, bgcolor=color.white, frame_color=color.red, frame_width=2)
plot(close)
`);
        expect(t).toBeDefined();
        expect(t!.cells.flat().every((c) => c === null)).toBe(true);
    });
});
