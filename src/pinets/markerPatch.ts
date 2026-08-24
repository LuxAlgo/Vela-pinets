import { Context } from 'pinets';

/**
 * PineTS keys a plot by TITLE, falling back to a transpiler-injected callsite id
 * (`__callsiteId`, read and popped by its own argument reader) and finally the
 * literal `"plot"` — but its transpiler injects no callsite ids today, so every
 * UNTITLED `plotshape`/`plotchar`/`plotarrow` call in a script lands on the SAME
 * plot: the per-bar points interleave (the streaming dedupe then keeps only the
 * last call's point per bar) and the FIRST call's plot-level options (`display`,
 * `show_last`) silently govern every other call. A script with twelve untitled
 * plotshapes paints one series, and a `display.none` on a non-first call is lost.
 *
 * Until pinets injects callsite ids natively, synthesize them here: wrap the three
 * marker functions as each Context binds them and append the `{__callsiteId}`
 * trailer pinets already understands. The id is the call's POSITION in the bar's
 * marker-call sequence — Pine only allows plot-family calls at global scope, so
 * the sequence replays identically on every bar and the position is a stable
 * callsite identity. The first executed bar measures the sequence length; from
 * then on the counter wraps modulo that length, so a streaming re-execution of
 * the forming bar (same `idx`, full sequence replayed) keys back onto the same
 * plots. (Limitation: a stream whose whole history is ONE bar never sees a second
 * bar to lock the length, and ids would drift on its live ticks — real charts
 * execute hundreds of bars before the first tick.)
 *
 * Titled calls benefit too: pinets suffixes the title with the callsite id when a
 * SECOND callsite reuses it, so two `plotshape(…, "Buy")` calls stay separate
 * plots instead of merging. Idempotent, applies to every context this module
 * graph creates (main-thread engine and worker bundle alike), and steps aside the
 * day pinets ships transpiler-injected ids (an already-tagged call is passed
 * through untouched).
 */

const MARKER_FNS = ['plotshape', 'plotchar', 'plotarrow'] as const;

/** The private surfaces the patch relies on (verified against pinets 0.9.x). */
interface PatchableContext {
    pine: Record<string, unknown>;
    /** The executing bar's index — advanced by the runner between bars. */
    idx?: number;
    bindContextObject(target: unknown, names: string[], ns?: string): void;
}

let patched = false;

export function ensurePineMarkerPatch(): void {
    if (patched) return;
    patched = true;
    const proto = Context.prototype as unknown as PatchableContext;
    // Deliberately unbound: the wrapper re-invokes it with the constructing context
    // as `this` (`orig.call(this, …)`) — never as a free-standing call.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const orig = proto.bindContextObject;
    if (typeof orig !== 'function') return; // pinets reshaped — leave it alone
    proto.bindContextObject = function (this: PatchableContext, target: unknown, names: string[], ns?: string): void {
        orig.call(this, target, names, ns);
        if (ns !== undefined || !MARKER_FNS.some((n) => names.includes(n))) return;
        // ONE sequence counter per context, shared by all three functions, so the
        // position reflects the script's call order across the whole marker family.
        const state = { idx: undefined as number | undefined, n: 0, len: 0 };
        for (const name of MARKER_FNS) {
            const bound = this.pine[name];
            if (typeof bound !== 'function') continue;
            const inner = bound as (...args: unknown[]) => unknown;
            this.pine[name] = (...args: unknown[]): unknown => {
                const last: unknown = args[args.length - 1];
                const tagged = last !== null && typeof last === 'object' && '__callsiteId' in last;
                if (!tagged) {
                    const idx = this.idx;
                    if (state.len === 0 && state.idx !== undefined && idx !== state.idx) {
                        state.len = state.n; // the first bar measured the calls-per-bar sequence
                        state.n = 0;
                    }
                    state.idx = idx;
                    const pos = state.len > 0 ? state.n % state.len : state.n;
                    state.n += 1;
                    args.push({ __callsiteId: `~m${pos}` });
                }
                return inner(...args);
            };
        }
    };
}
