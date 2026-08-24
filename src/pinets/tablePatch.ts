import { Context } from 'pinets';

/**
 * PineTS tables know nothing of Pine's `text_formatting`:
 * `table.cell_set_text_formatting` doesn't exist (a script calling it dies with
 * "not a function"), and a `table.cell(…, text_formatting=…)` named argument
 * falls through the named-args sniff into the positional `width` slot. Until
 * pinets ships the parameter natively, patch the table namespace as each
 * Context binds it: add the missing setter and route `text_formatting` around
 * the original `cell`. The stamped property survives serialization (the table
 * object spreads cells wholesale into the plot container), where the drawings
 * adapter picks it up as bold/italic.
 *
 * The patch is idempotent, applies to every context this module graph creates
 * (main-thread engine and the worker bundle alike — each calls it before
 * constructing PineTS), and steps aside the day pinets provides the setter.
 */

interface TableNamespace {
    cell?: (...args: unknown[]) => unknown;
    cell_set_text_formatting?: (...args: unknown[]) => unknown;
}

/** The private surfaces the patch relies on (verified against pinets 0.9.x). */
interface PatchableContext {
    pine: Record<string, unknown>;
    bindContextObject(target: unknown, names: string[], ns?: string): void;
}
interface PatchableTableHelper {
    _setCellProp?: (tableId: unknown, column: unknown, row: unknown, prop: string, value: unknown) => void;
}

let patched = false;

export function ensurePineTablePatch(): void {
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
        if (ns !== 'table') return;
        const table = this.pine['table'] as TableNamespace | undefined;
        const helper = target as PatchableTableHelper;
        if (!table || typeof table.cell_set_text_formatting === 'function' || typeof helper._setCellProp !== 'function') return;
        const setFmt = (tableId: unknown, column: unknown, row: unknown, value: unknown): void =>
            helper._setCellProp!(tableId, column, row, 'text_formatting', value);

        table.cell_set_text_formatting = (tableId, column, row, value) => setFmt(tableId, column, row, value);

        const origCell = table.cell;
        if (typeof origCell !== 'function') return;
        table.cell = (...args: unknown[]): unknown => {
            const last = args[args.length - 1];
            const named = last && typeof last === 'object' && !Array.isArray(last) && 'text_formatting' in last ? (last as Record<string, unknown>) : null;
            // Positional form: text_formatting is the 14th argument (index 13).
            if (!named && args.length < 14) return origCell(...args);
            const pos = named ? args.slice(0, -1) : args.slice(0, 13);
            let fmt: unknown;
            let forwarded: unknown[];
            if (named) {
                const { text_formatting, ...rest } = named;
                fmt = text_formatting;
                forwarded = Object.keys(rest).length > 0 ? [...pos, rest] : pos;
            } else {
                fmt = args[13];
                forwarded = pos;
            }
            const out = origCell(...forwarded);
            const rest = named ?? {};
            const column = pos.length > 1 ? pos[1] : (rest['column'] ?? 0);
            const row = pos.length > 2 ? pos[2] : (rest['row'] ?? 0);
            setFmt(pos[0], column, row, fmt);
            return out;
        };
    };
}
