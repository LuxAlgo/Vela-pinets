import { snapshotFromCtx } from './contextSnapshot';
import type {
    ScriptingEngine,
    EngineCapabilities,
    PreparedScript,
    ExecutionRequest,
    ExecutionHandlers,
    ExecutionSession,
} from '@luxalgo/vela/plugin';
import type { OHLCV } from '@luxalgo/vela/plugin';
import type { InputValue } from '@luxalgo/vela/plugin';
import {
    preparePine,
    indicatorFor,
    runPineStatic,
    openLiveStream,
    type LiveStreamHandle,
    type IndicatorCache,
    type PineToken,
    type PropsFilter,
} from './runtime';

/** The prepared token plus the in-process Indicator cache (reused across re-runs/ticks). */
type PineSession = PineToken & IndicatorCache;

/** Options for {@link PineEngine}. */
export interface PineEngineOptions {
    /**
     * Host-level defaults for declaration props (`initial_capital`, `precision`, …),
     * applied BENEATH source-declared values: a script that declares the prop keeps
     * its own value; a script that omits it gets the host's default instead of the
     * Pine spec one. Folded into the props schema's `defval`s at prepare, so the
     * settings dialog opens on them and "Reset defaults" restores them.
     */
    defaultProps?: Record<string, InputValue>;
    /**
     * Which scripts publish the declaration-props schema (drives whether the
     * settings dialog shows a "Properties" tab): `'all'` (default) every script,
     * `'strategy'` only `strategy()` scripts, `'none'` no script — or an explicit
     * WHITELIST of prop keys, published in the list's order (a script owning none
     * of the listed keys gets no tab). Presentation-only: hidden props keep their
     * source/spec values, and `setProps` still applies.
     */
    props?: PropsFilter;
}

/**
 * The in-process PineTS implementation of `ScriptingEngine`. Both the static run
 * and the live stream go through the shared `runtime` — the same code the
 * worker-backed `PineWorkerEngine` runs — so this class is just the in-process
 * wiring to the port. Vela owns market data and passes bars into `execute`;
 * this engine never fetches.
 */
export class PineEngine implements ScriptingEngine {
    readonly language = 'pine';
    readonly capabilities: EngineCapabilities = { streaming: true, visibleRange: true, inputs: true, props: true };
    private readonly defaultProps: Record<string, InputValue> | undefined;
    private readonly propsVisibility: PropsFilter;

    constructor(opts: PineEngineOptions = {}) {
        this.defaultProps = opts.defaultProps;
        this.propsVisibility = opts.props ?? 'all';
    }

    prepare(source: string, instanceId: string): Promise<PreparedScript> {
        return Promise.resolve(preparePine(source, instanceId, this.defaultProps, this.propsVisibility));
    }

    execute(req: ExecutionRequest, handlers: ExecutionHandlers): ExecutionSession {
        const token = req.prepared.token as PineSession;
        const getBars = req.getBars ?? ((): OHLCV[] => req.bars);
        let inputs: Record<string, InputValue> = { ...(req.inputs ?? {}) };
        let props: Record<string, InputValue> = { ...(req.props ?? {}) };
        let visibleRange = req.visibleRange;
        let stopped = false;

        // ── Live streaming: one persistent context, re-executes only the forming bar per tick ──
        if (req.mode === 'live' && this.capabilities.streaming) {
            let stream: LiveStreamHandle | null = null;
            let started = false;

            const start = (): void => {
                started = true;
                stream?.stop();
                stream = openLiveStream({
                    token,
                    cache: token,
                    prepared: req.prepared,
                    inputs,
                    props,
                    bars: getBars,
                    market: () => req.market,
                    fetchSeries: req.fetchSeries,
                    visibleRange,
                    onModel: (m) => {
                        if (!stopped) handlers.onModel(m);
                    },
                    onAlert: (a) => handlers.onAlert?.(a),
                    onWarning: (w) => handlers.onWarning?.(w),
                    onError: (e) => handlers.onError?.(e),
                });
            };
            // Policy A: during a history backfill the stream must not start — its history
            // length is FROZEN at start() (ticks only re-feed the tail), so a stream begun
            // over a partial history would never see the rest. `'complete'` starts it.
            if (req.historyState !== 'backfill') start();

            return {
                getContext: (select) => {
                    const ctx = stream?.lastCtx() ?? null;
                    return Promise.resolve(ctx === null ? null : snapshotFromCtx(ctx, stopped ? 'idle' : 'streaming', select));
                },
                stop: () => {
                    stopped = true;
                    stream?.stop();
                },
                update: (next, nextProps) => {
                    inputs = { ...inputs, ...next };
                    if (nextProps) props = { ...props, ...nextProps };
                    if (started) start(); // re-stream with the new inputs/props baked in
                },
                setVisibleRange: (range) => {
                    visibleRange = range;
                    if (started) stream?.setVisibleRange(range.left, range.right); // deferred — start() applies it
                },
                notifyBars: (reason) => {
                    if (reason === 'backfill') return; // partial history — keep holding
                    if (reason === 'complete') {
                        // (Re)start over the FULL history: a stream running through the
                        // backfill has its history frozen at the pre-backfill length.
                        start();
                        return;
                    }
                    if (started) stream?.markDirty();
                },
            };
        }

        // ── Static: run on demand; re-run whenever the session is poked ──
        // Policy A: while the chart's history backfill is in progress, every run is
        // HELD (state changes merge meanwhile) — the `'complete'` notification fires
        // the first run over the full history. Backfill pokes are ignored outright.
        let deferred = req.historyState === 'backfill';
        let lastCtx: unknown = null;
        let running = false;
        const runOnce = async (): Promise<void> => {
            if (stopped) return;
            running = true;
            try {
                const outcome = await runPineStatic({
                    ind: indicatorFor(token, token.source, inputs, props),
                    bars: getBars(),
                    market: req.market,
                    visibleRange,
                    prepared: req.prepared,
                    instanceId: token.instanceId,
                    inputs,
                    props,
                    fetchSeries: req.fetchSeries,
                });
                if (stopped) return;
                lastCtx = outcome.ctx;
                running = false;
                req.prepared.reactsToViewport = outcome.reactsToViewport; // refine in place
                for (const a of outcome.alerts) handlers.onAlert?.(a);
                for (const w of outcome.warnings) handlers.onWarning?.(w);
                // A null model = the run never executed (zero bars): emit nothing — the
                // host keeps its prepared placeholder and pokes the session when bars land.
                if (outcome.model) handlers.onModel(outcome.model);
                handlers.onDone?.();
            } catch (err) {
                handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
            }
        };
        if (!deferred) void runOnce();

        return {
            getContext: (select) =>
                Promise.resolve(lastCtx === null ? null : snapshotFromCtx(lastCtx, running ? 'computing' : 'idle', select)),
            stop: () => {
                stopped = true;
            },
            update: (next, nextProps) => {
                inputs = { ...inputs, ...next };
                if (nextProps) props = { ...props, ...nextProps };
                if (!deferred) void runOnce();
            },
            setVisibleRange: (range) => {
                visibleRange = range;
                if (!deferred) void runOnce();
            },
            notifyBars: (reason) => {
                if (reason === 'backfill') return;
                if (reason === 'complete') deferred = false;
                if (!deferred) void runOnce();
            },
        };
    }

}
