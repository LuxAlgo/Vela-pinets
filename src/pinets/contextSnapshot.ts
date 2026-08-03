// Build the NEUTRAL, serializable EngineContextSnapshot from a PineTS run context.
// Same narrow-contract philosophy as PineRun.ts: we read a few known fields and
// deep-copy only what survives structured cloning — live references never escape.
import type { EngineContextSnapshot, ContextSelect } from '@luxalgo/vela/plugin';
import { normalizeContext } from './normalizeContext';
import { toStrategyState, toStrategyTrades } from './strategyState';

interface RawCtx {
    fullContext?: RawCtx;
    idx?: unknown;
    length?: unknown;
    params?: Record<string, unknown>;
    const?: Record<string, unknown>;
    var?: Record<string, unknown>;
    let?: Record<string, unknown>;
    strategy?: unknown;
    warnings?: Array<{ message?: unknown; method?: unknown; bar?: unknown }>;
}

/** Deep-copy a value if it survives structured cloning; undefined otherwise. */
function cloneable(v: unknown): unknown {
    try {
        return structuredClone(v);
    } catch {
        return undefined;
    }
}

/**
 * A PineTS variable's value AT THE LAST COMPUTED BAR. The transpiler stores a series as
 * `{ data: [...one entry per bar...] }`, and the snapshot contract is current values, not
 * per-bar buffers — a host wanting the history asks for the plot instead.
 */
function currentValue(v: unknown): unknown {
    const data = Array.isArray(v) ? v : v != null && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data) ? (v as { data: unknown[] }).data : null;
    return cloneable(data ? data[data.length - 1] : v);
}

/**
 * The name as WRITTEN in the source. PineTS scopes globals as `glb<n>_<name>`; that scheme
 * is the transpiler's business and the contract forbids leaking it. Bucket names go too —
 * a script's `posSize` is `posSize`, wherever the transpiler filed it.
 */
function sourceName(key: string): string {
    return key.replace(/^glb\d+_/, '');
}

/** Serializable subset of a variables bucket, keyed by source names, at the current bar. */
function pickVars(bucket: Record<string, unknown> | undefined, into: Record<string, unknown>): void {
    if (!bucket) return;
    for (const [k, v] of Object.entries(bucket)) {
        if (k.startsWith('_')) continue;
        const c = currentValue(v);
        if (c !== undefined) into[sourceName(k)] = c;
    }
}

export function snapshotFromCtx(ctx: unknown, phase: EngineContextSnapshot['phase'], select?: ContextSelect): EngineContextSnapshot {
    const c = (ctx ?? {}) as RawCtx;
    const root = c.fullContext ?? c;
    const want = (k: keyof EngineContextSnapshot): boolean => !select || select.includes(k);
    const run = want('meta') || want('plots') ? normalizeContext(ctx) : null;

    const plots: EngineContextSnapshot['plots'] = {};
    if (run && want('plots')) {
        for (const p of run.plots) {
            if (p.key.startsWith('__')) continue; // engine-internal channels (drawings buffers)
            plots[p.key] = p.data.map((pt) => ({ time: pt.time, value: cloneable(pt.value) ?? null }));
        }
    }
    const variables: Record<string, unknown> = {};
    if (want('variables')) {
        // `params` holds the transpiler's positional slots (the literal `0` in
        // `ta.crossover(x, 0)`), never anything the script named — it stays out.
        pickVars(root.const, variables);
        pickVars(root.var, variables);
        pickVars(root.let, variables);
    }
    // Only a strategy() script builds a broker ledger; its absence is what tells the core
    // this run is an ordinary indicator.
    const strategy = want('strategy') ? toStrategyState(root.strategy) : undefined;
    const trades = want('trades') && root.strategy ? toStrategyTrades(root.strategy) : undefined;
    const barIndexRaw = typeof root.idx === 'number' ? root.idx : typeof root.length === 'number' ? root.length - 1 : -1;
    return {
        language: 'pine',
        phase,
        barIndex: barIndexRaw,
        meta: run && want('meta')
            ? { title: run.meta.title, overlay: run.meta.overlay, precision: run.meta.precision, shorttitle: run.meta.shorttitle }
            : { title: '', overlay: false },
        plots,
        variables,
        ...(strategy ? { strategy } : {}),
        ...(trades && trades.length > 0 ? { trades } : {}),
        warnings: want('warnings')
            ? (root.warnings ?? []).map((w) => ({ message: String(w.message ?? ''), method: typeof w.method === 'string' ? w.method : undefined, bar: Number(w.bar ?? 0) }))
            : [],
    };
}
