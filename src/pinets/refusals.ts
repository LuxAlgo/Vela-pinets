import type { FetchSeries } from '@luxalgo/vela/plugin';

/**
 * A data source's PERMANENT refusal of a series, as Vela states it: the gateway behind
 * `request.security` rejects with a `DataUnavailableError` when the source never serves the
 * series (a monthly economic series asked for hourly bars). A transient failure still reads
 * as an empty series, so only a refusal is final.
 *
 * Recognized by its name and fields, never by class, the same way Vela's own
 * `isDataUnavailableError` guard reads it. This package does not import that guard: it
 * would raise the Vela floor this package supports, and the browser-global build reads Vela
 * from the page, where an older Vela lacks it.
 */

/** The plain fields of a refusal: what crosses the worker boundary next to its message. */
export interface SeriesRefusal {
    /** Why the source refuses, `'timeframe'` for a series not served at that timeframe. */
    reason: string;
    symbol?: string;
    timeframe?: string;
    /** The finest timeframe the source serves the symbol at. */
    finest?: string;
    /** The timeframe the source suggests showing the symbol at. */
    default?: string;
}

const NAME = 'DataUnavailableError';
const FIELDS = ['symbol', 'timeframe', 'finest', 'default'] as const;

/** Whether `e` is a source's permanent refusal of a series (see the module notes). */
export function isSeriesRefusal(e: unknown): e is Error & SeriesRefusal {
    if (typeof e !== 'object' || e === null) return false;
    const o = e as Record<string, unknown>;
    return o.name === NAME && typeof o.reason === 'string' && typeof o.message === 'string' && FIELDS.every((k) => o[k] === undefined || typeof o[k] === 'string');
}

/** A refusal's plain fields, to send across the worker boundary. */
export function refusalFields(e: SeriesRefusal): SeriesRefusal {
    const out: SeriesRefusal = { reason: e.reason };
    for (const k of FIELDS) if (e[k] !== undefined) out[k] = e[k];
    return out;
}

/** The refusal rebuilt on the other side of the worker boundary: same name, message and fields. */
export function refusalError(message: string, fields: SeriesRefusal): Error & SeriesRefusal {
    return Object.assign(new Error(message), { name: NAME }, refusalFields(fields));
}

/**
 * A session's gateway that asks the source only once for a series it refused: the refusal
 * is remembered per (symbol, timeframe) and every later request for that series rejects
 * with it straight away. A static session re-runs the script on every tick, so without this
 * each run would ask the source again for a series it will never serve. Any other failure,
 * and an empty answer, is not remembered: the next run asks again.
 */
export function rememberRefusals(fetchSeries: FetchSeries): FetchSeries;
export function rememberRefusals(fetchSeries: FetchSeries | undefined): FetchSeries | undefined;
export function rememberRefusals(fetchSeries: FetchSeries | undefined): FetchSeries | undefined {
    if (!fetchSeries) return undefined;
    const refused = new Map<string, Error & SeriesRefusal>();
    return async (symbol, timeframe, range) => {
        const key = `${symbol}\u0000${timeframe}`;
        const known = refused.get(key);
        if (known) throw known;
        try {
            return await fetchSeries(symbol, timeframe, range);
        } catch (e) {
            if (isSeriesRefusal(e)) refused.set(key, e);
            throw e;
        }
    };
}
