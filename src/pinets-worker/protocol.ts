import type { OHLCV } from '@luxalgo/vela/plugin';
import type { InputValue } from '@luxalgo/vela/plugin';
import type { IndicatorModel } from '@luxalgo/vela/plugin';
import type { BarRange } from '@luxalgo/vela/plugin';
import type { PreparedScript, ExecutionMarket, VisibleBarRange, EngineAlert, EngineWarning, ContextSelect, EngineContextSnapshot } from '@luxalgo/vela/plugin';
import type { PropsFilter } from '../pinets/runtime';
import type { FootprintBar, FootprintRange } from '../pinets/footprints';

/**
 * The message protocol between `PineWorkerEngine` (main thread) and `worker.ts`
 * (worker thread). Everything here is structured-clone-serializable — notably the
 * neutral `IndicatorModel`, which is plain data, so results cross for free.
 *
 * Functions in the port (`getBars`, `fetchSeries`, handlers) don't cross the wire:
 * bars are shipped as data, handler callbacks become worker→main messages, and a
 * `fetchSeries` call becomes a request/response pair (the worker asks, the main
 * thread — which owns the cache + network — answers). The engine's `footprints`
 * source follows the same pattern: `execute` only flags that one exists, and each
 * `getFootprintData` call PineTS makes round-trips as `fetchFootprints`.
 */

export type MainToWorker =
    | { kind: 'prepare'; reqId: number; source: string; instanceId: string; defaultProps?: Record<string, InputValue>; propsVisibility?: PropsFilter }
    | {
          kind: 'execute';
          sessionId: number;
          prepared: PreparedScript;
          market: ExecutionMarket;
          bars: OHLCV[];
          inputs: Record<string, InputValue>;
          props?: Record<string, InputValue>;
          visibleRange?: VisibleBarRange;
          mode?: 'static' | 'live';
          historyState?: 'backfill' | 'complete';
          /** The engine holds a footprint source — the worker exposes `getFootprintData` and round-trips it. */
          footprints?: true;
      }
    | { kind: 'update'; sessionId: number; inputs: Record<string, InputValue>; props?: Record<string, InputValue> }
    | { kind: 'setVisibleRange'; sessionId: number; range: VisibleBarRange }
    | { kind: 'notifyBars'; sessionId: number; bars: OHLCV[] }
    /**
     * LIVE sessions only — bar delta for the worker-local array the streaming
     * provider polls. Normally the TAIL (the forming bar + anything newer since
     * the last send); with `restart: true` a FULL snapshot that (re)starts the
     * stream over it (history backfill completed / inputs changed).
     */
    | { kind: 'bars'; sessionId: number; bars: OHLCV[]; restart?: boolean }
    | { kind: 'getContext'; sessionId: number; reqId: number; select?: ContextSelect }
    | { kind: 'stop'; sessionId: number }
    | { kind: 'fetchSeriesResult'; reqId: number; bars?: OHLCV[]; error?: string }
    | { kind: 'fetchFootprintsResult'; reqId: number; bars?: FootprintBar[]; error?: string };

export type WorkerToMain =
    | { kind: 'prepared'; reqId: number; prepared?: PreparedScript; error?: string }
    | { kind: 'model'; sessionId: number; model: IndicatorModel }
    | { kind: 'alert'; sessionId: number; alert: EngineAlert }
    | { kind: 'warning'; sessionId: number; warning: EngineWarning }
    | { kind: 'error'; sessionId: number; message: string }
    | { kind: 'done'; sessionId: number }
    | { kind: 'reactsToViewport'; sessionId: number; value: boolean }
    | { kind: 'contextResult'; reqId: number; snapshot: EngineContextSnapshot | null }
    | { kind: 'fetchSeries'; reqId: number; symbol: string; timeframe: string; range: BarRange }
    | { kind: 'fetchFootprints'; reqId: number; symbol: string; timeframe: string; range: FootprintRange };

/** Minimal Worker surface the proxy needs — the real `Worker` satisfies it; tests inject a fake. */
export interface WorkerLike {
    postMessage(message: unknown): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    terminate(): void;
}
