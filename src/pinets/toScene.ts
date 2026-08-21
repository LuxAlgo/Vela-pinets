import type { OHLCV } from '@luxalgo/vela/plugin';
import type { IndicatorModel } from '@luxalgo/vela/plugin';
import type { SeriesSpec, SeriesPoint, LineLikeKind, LineLikeStyle, LineStyle, CandleSeries, CandleBarColor } from '@luxalgo/vela/plugin';
import type { Fill, FillGradientStop, Background, PriceLine } from '@luxalgo/vela/plugin';
import type { DrawingLine, DrawingBox, DrawingLabel, DrawingPolyline, DrawingLinefill, DrawingTable } from '@luxalgo/vela/plugin';
import type { TradeExecution } from '@luxalgo/vela/plugin';
import type { PineRun, PinePlot, PineTrade } from './PineRun';
import { asString, asNumber } from './PineRun';
import { classifyStyle } from './styleMap';
import { normColor, isVisibleColor, INVISIBLE_COLOR } from './colors';
import { IdentityMap } from './identityMap';
import { toLines, toBoxes, toLabels, toPolylines, toLinefills, toTables } from './drawings';
import { ACCENT } from '@luxalgo/vela/plugin';

const DEFAULT_COLOR = ACCENT;

export interface ToSceneResult {
    model: IndicatorModel;
    warnings: string[];
}

/**
 * Pure transform: a normalized PineTS run → a renderer-neutral `IndicatorModel`.
 * `paneId` is left as 'unrouted' — the orchestrator stamps the real pane id.
 */
export function toScene(run: PineRun, instanceId: string): ToSceneResult {
    const ids = new IdentityMap();
    const warnings: string[] = [];
    const series: SeriesSpec[] = [];
    const fills: Fill[] = [];
    const backgrounds: Background[] = [];
    const priceLines: PriceLine[] = [];
    const lines: DrawingLine[] = [];
    const boxes: DrawingBox[] = [];
    const labels: DrawingLabel[] = [];
    const polylines: DrawingPolyline[] = [];
    const linefills: DrawingLinefill[] = [];
    const tables: DrawingTable[] = [];
    const barColors: Array<{ time: number; color: string }> = [];
    const keyToSeriesId = new Map<string, string>();
    const pendingFills: PinePlot[] = [];

    for (const plot of run.plots) {
        const cls = classifyStyle(plot.style);
        const title = plot.title ?? plot.key;

        switch (cls) {
            case 'skip':
                break;
            case 'barcolor': {
                // Per-bar candle recolor. `value` is the barcolor condition (true / na);
                // a `na` color (no color this bar) leaves the candle's default colors.
                if (!displayIncludesPane(plot.options.display)) break;
                const first = showLastStart(plot.data.length, asNumber(plot.options.show_last));
                for (let i = first; i < plot.data.length; i += 1) {
                    const d = plot.data[i]!;
                    const color = normColor(d.options?.color);
                    if (color) barColors.push({ time: d.time, color });
                }
                break;
            }
            case 'fill':
                if (displayIncludesPane(plot.options.display)) pendingFills.push(plot);
                break;
            case 'hline': {
                const line = toPriceLine(plot, title, instanceId, ids);
                if (line) priceLines.push(line);
                break;
            }
            case 'background':
                if (displayIncludesPane(plot.options.display)) backgrounds.push(...toBackgrounds(plot, title, instanceId, ids));
                break;
            case 'drawing_line':
                lines.push(...toLines(plot, instanceId, ids));
                break;
            case 'drawing_box':
                boxes.push(...toBoxes(plot, instanceId, ids));
                break;
            case 'label':
                labels.push(...toLabels(plot, instanceId, ids));
                break;
            case 'drawing_polyline':
                polylines.push(...toPolylines(plot, instanceId, ids));
                break;
            case 'linefill':
                linefills.push(...toLinefills(plot, instanceId, ids));
                break;
            case 'table':
                tables.push(...toTables(plot, instanceId, ids));
                break;
            case 'markers':
                // plotshape/plotchar/plotarrow → rendered as labels (shapes + callouts)
                // so we get faithful diamonds/triangles/label bubbles and absolute /
                // pane top-bottom placement that native bar-relative markers can't do.
                if (displayIncludesPane(plot.options.display)) labels.push(...markersToLabels(plot, instanceId, ids));
                break;
            default: {
                const id = ids.next(instanceId, cls, title);
                keyToSeriesId.set(plot.key, id);
                series.push(toSeries(cls, plot, id, title));
                const track = trackPriceLine(plot, title, instanceId, ids);
                if (track) priceLines.push(track);
            }
        }
    }

    for (const fill of pendingFills) {
        const fromId = fill.plot1 ? keyToSeriesId.get(fill.plot1) : undefined;
        const toId = fill.plot2 ? keyToSeriesId.get(fill.plot2) : undefined;
        if (!fromId || !toId) {
            warnings.push(`fill "${fill.key}" references unknown plots (${fill.plot1 ?? '?'}/${fill.plot2 ?? '?'})`);
            continue;
        }
        fills.push({
            id: ids.next(instanceId, 'fill', fill.title ?? fill.key),
            paneId: 'unrouted',
            fromSeriesId: fromId,
            toSeriesId: toId,
            ...extractFillStyle(fill),
        });
    }

    const trades = run.trades ? tradesToExecutions(run.trades) : [];
    const model: IndicatorModel = {
        id: instanceId,
        title: run.meta.title,
        overlay: run.meta.overlay,
        paneHint: run.meta.overlay ? 'price' : 'new',
        series,
        fills,
        backgrounds,
        priceLines,
        lines,
        boxes,
        labels,
        polylines,
        linefills,
        tables,
        barColors: barColors.length ? barColors : undefined,
        trades: trades.length ? trades : undefined,
        inputs: [],
        inputValues: {},
    };
    return { model, warnings };
}

/**
 * Ledger trades → chart order executions, ONE MARKER PER ORDER FILL. The ledger splits
 * a fill across trades (a reversal entry closes the old trade AND opens the new one; one
 * exit order can close several lots FIFO), but on the chart those slices are the same
 * order executing once — so ledger fills sharing (bar, direction, order label) merge
 * back into a single execution whose quantity is the sum. A merged reversal reads as an
 * ENTRY (that is what the order was), keeping the entry side's color.
 *
 * Markers land on the FILL bar/price the broker emulator recorded — a market order
 * filled at the next bar's open shows there, exactly where it executed. The `comment`
 * given to an order replaces its id as the marker label.
 */
function tradesToExecutions(trades: PineTrade[]): TradeExecution[] {
    const groups = new Map<string, TradeExecution>();
    const fill = (e: TradeExecution): void => {
        const key = `${e.time}|${e.side}|${e.label ?? ''}`;
        const g = groups.get(key);
        if (!g) {
            groups.set(key, e);
            return;
        }
        g.qty = (g.qty ?? 0) + (e.qty ?? 0);
        if (e.kind === 'entry' && g.kind === 'exit') {
            // The entry slice names the merged fill: a reversal is an entry order.
            g.kind = 'entry';
            g.price = e.price;
            g.tradeId = e.tradeId;
        }
    };
    for (const t of trades) {
        const long = t.size > 0;
        const qty = Math.abs(t.size);
        fill({
            time: t.entry_time,
            price: t.entry_price,
            side: long ? 'buy' : 'sell',
            kind: 'entry',
            label: t.entry_comment ?? t.entry_id,
            qty,
            tradeId: t.id,
        });
        if (t.status === 'closed' && t.exit_time != null && t.exit_price != null) {
            fill({
                time: t.exit_time,
                price: t.exit_price,
                side: long ? 'sell' : 'buy',
                kind: 'exit',
                label: t.exit_comment ?? t.exit_id,
                qty,
                tradeId: t.id,
            });
        }
    }
    // Chronological, stable: a same-bar round trip keeps entry before exit.
    return [...groups.values()].sort((a, b) => a.time - b.time);
}

function toSeries(cls: LineLikeKind | 'candle' | 'bar', plot: PinePlot, id: string, title: string): SeriesSpec {
    const showLast = asNumber(plot.options.show_last);
    if (cls === 'candle' || cls === 'bar') {
        const spec: CandleSeries = { id, title, paneId: 'unrouted', kind: cls, bars: toOhlcBars(plot, showLastStart(plot.data.length, showLast)) };
        const barColors = toCandleBarColors(plot);
        if (barColors) spec.barColors = barColors;
        return spec;
    }
    const kind = cls;
    const repColor = normColor(representativeColor(plot));
    // Hidden = declared off-pane (a `display` without the pane flag: none,
    // data_window, status_line, price_scale) or a `na` color. Kept as a series
    // (with points) so it can still anchor a fill().
    const hidden = !displayIncludesPane(plot.options.display) || !repColor;
    const width = asNumber(plot.options.linewidth) ?? 1;
    const connected = kind === 'line' || kind === 'step' || kind === 'area';
    const points = applyOffset(applyShowLast(toPoints(plot), showLast, connected), asNumber(plot.options.offset));
    const style: LineLikeStyle = { color: repColor ?? DEFAULT_COLOR, width, lineStyle: asLineStyle(plot.options.linestyle) ?? 'solid' };
    // `histbase` re-bases the styles that grow from a reference level.
    const base = asNumber(plot.options.histbase);
    if (base !== undefined && (kind === 'histogram' || kind === 'columns' || kind === 'area')) style.base = base;
    return { id, title, paneId: 'unrouted', kind, points, style, visible: !hidden };
}

/**
 * Pine `display.*` arrives as the enum's plain string ('all', 'none', 'pane',
 * 'data_window', 'price_scale', 'status_line'); a `+`-combined argument
 * concatenates the parts. A plot paints in the pane only when its display
 * includes the pane — `display.all` (the default) or `display.pane`; a
 * status-line / price-scale / data-window-only plot stays off-chart.
 */
function displayIncludesPane(v: unknown): boolean {
    const s = asString(v);
    return s === undefined || s.includes('all') || s.includes('pane');
}

/** First data index inside a Pine `show_last` window (0 = no trimming). */
function showLastStart(dataLen: number, showLast: number | undefined): number {
    if (showLast === undefined || showLast <= 0) return 0;
    return Math.max(0, dataLen - Math.floor(showLast));
}

/**
 * Pine `show_last=N` draws only the last N bars. Out-of-window values become
 * gaps — the points themselves stay so fills keep their by-index alignment.
 * Connected kinds keep one extra value as the entering segment's anchor:
 * `show_last=1` on a line draws the one-bar segment into the last bar, as Pine
 * does.
 */
function applyShowLast(points: SeriesPoint[], showLast: number | undefined, connected: boolean): SeriesPoint[] {
    let first = showLastStart(points.length, showLast);
    if (connected) first -= 1;
    if (first <= 0) return points;
    return points.map((p, i) => (i < first ? { ...p, value: null } : p));
}

/**
 * Pine `trackprice=true` extends the plot's LAST value across the pane as a
 * dotted price line. Deliberately independent of `display`: the documented
 * Pine idiom draws only the level (`display.none`, or `show_last=1` with a far
 * negative offset), so the level must survive a hidden plot.
 */
function trackPriceLine(plot: PinePlot, title: string, instanceId: string, ids: IdentityMap): PriceLine | null {
    if (plot.options.trackprice !== true) return null;
    for (let i = plot.data.length - 1; i >= 0; i -= 1) {
        const d = plot.data[i]!;
        if (typeof d.value !== 'number' || !Number.isFinite(d.value)) continue;
        return {
            id: ids.next(instanceId, 'hline', title),
            paneId: 'unrouted',
            price: d.value,
            color: normColor(d.options?.color) ?? normColor(representativeColor(plot)),
            lineStyle: 'dotted',
            width: asNumber(plot.options.linewidth),
            title,
        };
    }
    return null;
}

/** Per-bar plotcandle/plotbar colors (`color`/`wickcolor`/`bordercolor`), or null if none vary. */
function toCandleBarColors(plot: PinePlot): Array<CandleBarColor | null> | undefined {
    let any = false;
    const out = plot.data.map((d): CandleBarColor | null => {
        const o = d.options ?? {};
        const color = normColor(o.color);
        const wickColor = normColor(o.wickcolor);
        const borderColor = normColor(o.bordercolor);
        if (!color && !wickColor && !borderColor) return null;
        any = true;
        return { color, wickColor, borderColor };
    });
    return any ? out : undefined;
}

function toPoints(plot: PinePlot): SeriesPoint[] {
    // PineTS stamps each bar's EVALUATED color into the point options and leaves
    // it out (or NaN) where it evaluated to `na`. On a plot that otherwise
    // carries per-bar colors, such a bar means "don't draw this segment" — emit
    // a transparent override so the point survives (fills still anchor to it)
    // but nothing is painted. A plot with no per-bar colors at all is untouched.
    const hasPerBarColor = plot.data.some((d) => isVisibleColor(d.options?.color));
    return plot.data.map((d) => {
        const value = typeof d.value === 'number' && Number.isFinite(d.value) ? d.value : null;
        const color = normColor(d.options?.color);
        if (color) return { time: d.time, value, color };
        return hasPerBarColor ? { time: d.time, value, color: INVISIBLE_COLOR } : { time: d.time, value };
    });
}

/** Median spacing between consecutive bar times (for converting bar offsets to time). */
function inferIntervalMs(items: ReadonlyArray<{ time: number }>): number {
    const diffs: number[] = [];
    for (let i = 1; i < items.length; i += 1) {
        const d = items[i]!.time - items[i - 1]!.time;
        if (d > 0) diffs.push(d);
    }
    if (diffs.length === 0) return 0;
    diffs.sort((a, b) => a - b);
    return diffs[diffs.length >> 1] ?? 0;
}

/** Pine `offset` shifts a plot N bars (negative = left/past). Re-time each point by N×interval. */
function applyOffset(points: SeriesPoint[], offset: number | undefined): SeriesPoint[] {
    if (!offset) return points;
    const shift = offset * inferIntervalMs(points);
    if (!shift) return points;
    return points.map((p) => ({ ...p, time: p.time + shift }));
}

function toOhlcBars(plot: PinePlot, firstIdx = 0): OHLCV[] {
    // With a `show_last` window the array stays index-aligned to the plot data
    // (holes before the window) so the renderer's bar-index lookup still lands
    // on the right chart bars; without one, invalid points compact as before.
    const out: OHLCV[] = firstIdx > 0 ? new Array<OHLCV>(plot.data.length) : [];
    for (let i = firstIdx; i < plot.data.length; i += 1) {
        const d = plot.data[i]!;
        const v = d.value;
        if (!Array.isArray(v) || v.length < 4) continue;
        const bar: OHLCV = { time: d.time, open: v[0] ?? 0, high: v[1] ?? 0, low: v[2] ?? 0, close: v[3] ?? 0 };
        if (firstIdx > 0) out[i] = bar;
        else out.push(bar);
    }
    return out;
}

function representativeColor(plot: PinePlot): string | undefined {
    for (const d of plot.data) {
        if (typeof d.options?.color === 'string' && d.options.color) return d.options.color;
    }
    return asString(plot.options.color);
}

/**
 * Resolve a `fill()`'s styling from its plot. Three shapes:
 *  - gradient overload (`gradient:true` / per-bar top_color/bottom_color) → per-bar gradient stops,
 *  - per-bar solid color that varies (conditional fill) → `colors[]`,
 *  - otherwise a single flat `color`.
 * Per-bar arrays align to the anchor points by index (same bars).
 */
function extractFillStyle(plot: PinePlot): { color?: string; colors?: Array<string | null>; gradient?: Array<FillGradientStop | null> } {
    const isGradient =
        plot.options.gradient === true ||
        plot.data.some((d) => d.options && (typeof d.options.top_color === 'string' || typeof d.options.bottom_color === 'string'));

    if (isGradient) {
        const gradient = plot.data.map((d): FillGradientStop | null => {
            const o = d.options ?? {};
            const tv = asNumber(o.top_value);
            const bv = asNumber(o.bottom_value);
            // Keep raw gradient colors (incl. alpha 00) — transparency IS the gradient.
            const tc = typeof o.top_color === 'string' ? o.top_color : undefined;
            const bc = typeof o.bottom_color === 'string' ? o.bottom_color : undefined;
            if (tv === undefined || bv === undefined || (!tc && !bc)) return null;
            return { topValue: tv, bottomValue: bv, topColor: tc ?? 'rgba(0,0,0,0)', bottomColor: bc ?? 'rgba(0,0,0,0)' };
        });
        return { gradient };
    }

    const perBar = plot.data.map((d) => normColor(d.options?.color) ?? null);
    const distinct = new Set(perBar.filter((c): c is string => c !== null));
    const hasNull = perBar.some((c) => c === null);
    if (distinct.size === 0) return { color: normColor(plot.options.color) };
    if (distinct.size === 1 && !hasNull) return { color: [...distinct][0] };
    return { colors: perBar };
}

function toPriceLine(plot: PinePlot, title: string, instanceId: string, ids: IdentityMap): PriceLine | null {
    if (!displayIncludesPane(plot.options.display)) return null;
    let price: number | undefined;
    for (const d of plot.data) {
        if (typeof d.value === 'number' && Number.isFinite(d.value)) {
            price = d.value;
            break;
        }
    }
    if (price === undefined) return null;
    return {
        id: ids.next(instanceId, 'hline', title),
        paneId: 'unrouted',
        price,
        color: normColor(plot.options.color),
        // Pine's hline default style is dashed; solid must be asked for.
        lineStyle: asLineStyle(plot.options.linestyle) ?? 'dashed',
        title,
        width: asNumber(plot.options.linewidth),
    };
}

/**
 * Pine line-style constants → neutral LineStyle. Handles the various emitted
 * forms: `hline` → "solid"/"dashed"/"dotted"; `plot(linestyle=…)` →
 * "linestyle_dashed". Unknown/absent → undefined (the caller picks the
 * function's own default).
 */
function asLineStyle(v: unknown): LineStyle | undefined {
    const s = asString(v)?.replace(/^(hline\.style_|plot\.linestyle_|linestyle_|style_)/, '');
    return s === 'solid' || s === 'dashed' || s === 'dotted' ? s : undefined;
}

function toBackgrounds(plot: PinePlot, title: string, instanceId: string, ids: IdentityMap): Background[] {
    const out: Background[] = [];
    const data = plot.data;
    const interval = data.length > 1 ? (data[1]?.time ?? 0) - (data[0]?.time ?? 0) : 0;
    let i = showLastStart(data.length, asNumber(plot.options.show_last));
    while (i < data.length) {
        const d = data[i]!;
        const color = normColor(d.options?.color);
        if (d.value === true && color) {
            const start = d.time;
            let last = d.time;
            let j = i;
            while (j + 1 < data.length) {
                const next = data[j + 1]!;
                if (next.value === true && normColor(next.options?.color) === color) {
                    last = next.time;
                    j += 1;
                } else break;
            }
            out.push({ id: ids.next(instanceId, 'background', title), paneId: 'unrouted', from: start, to: last + interval, color });
            i = j + 1;
        } else {
            i += 1;
        }
    }
    return out;
}

/**
 * `plotshape`/`plotchar`/`plotarrow` → labels. Each rendered bar (where the
 * series is `true` or a finite number) becomes a label whose style is the Pine
 * `shape.*` and whose anchor follows `location` (absolute price, pane top/bottom,
 * or above/below the bar).
 */
function markersToLabels(plot: PinePlot, instanceId: string, ids: IdentityMap): DrawingLabel[] {
    const offset = asNumber(plot.options.offset);
    const shift = offset ? offset * inferIntervalMs(plot.data) : 0;
    const out: DrawingLabel[] = [];
    const first = showLastStart(plot.data.length, asNumber(plot.options.show_last));
    for (let i = first; i < plot.data.length; i += 1) {
        const d = plot.data[i]!;
        const v = d.value;
        const isNum = typeof v === 'number' && Number.isFinite(v);
        if (v !== true && !isNum) continue; // only bars where the shape shows
        const opts = d.options ?? plot.options;
        // PineTS stamps the bar's EVALUATED color: `undefined` means no color
        // argument (default applies), while `na` arrives as NaN/null/an na
        // object — an evaluated-but-invisible color draws no shape on this bar.
        const rawColor = opts.color !== undefined ? opts.color : plot.options.color;
        if (rawColor !== undefined && !isVisibleColor(rawColor)) continue;
        const text = asString(opts.text) ?? asString(plot.options.text);
        out.push({
            id: ids.next(instanceId, 'label', `${plot.key}#${out.length}`),
            paneId: 'unrouted',
            xloc: 'bar_time',
            x: d.time + shift,
            y: isNum ? v : 0, // bool (e.g. squeeze) at location.absolute → the zero line
            yloc: markerYLoc(asString(opts.location) ?? asString(plot.options.location)),
            text: text && text.trim().length > 0 ? text : undefined,
            style: markerShape(asString(opts.shape) ?? asString(plot.options.shape)),
            color: normColor(opts.color) ?? normColor(plot.options.color) ?? DEFAULT_COLOR,
            textColor: normColor(opts.textcolor) ?? normColor(plot.options.textcolor),
            size: markerSize(asString(opts.size) ?? asString(plot.options.size)),
            textAlign: 'center',
            fontFamily: 'default',
        });
    }
    return out;
}

function markerYLoc(location: string | undefined): DrawingLabel['yloc'] {
    const s = (location ?? '').toLowerCase();
    if (s === 'absolute') return 'price';
    if (s === 'top') return 'top';
    if (s === 'bottom') return 'bottom';
    if (s.includes('below')) return 'belowbar';
    return 'abovebar'; // Pine plotshape default
}

function markerShape(shape: string | undefined): DrawingLabel['style'] {
    const s = (shape ?? '').toLowerCase().replace(/^shape_/, '').replace(/_/g, '');
    switch (s) {
        case 'diamond': return 'diamond';
        case 'triangleup': return 'triangleup';
        case 'triangledown': return 'triangledown';
        case 'labelup': return 'label_up';
        case 'labeldown': return 'label_down';
        case 'arrowup': return 'arrowup';
        case 'arrowdown': return 'arrowdown';
        case 'square': return 'square';
        case 'cross': return 'cross';
        case 'xcross': return 'xcross';
        case 'flag': return 'flag';
        default: return 'circle';
    }
}

function markerSize(size: string | undefined): DrawingLabel['size'] {
    const s = (size ?? '').toLowerCase();
    return s === 'tiny' || s === 'small' || s === 'large' || s === 'huge' || s === 'normal' ? s : 'small';
}
