import { Context } from 'pinets';

/**
 * PineTS labels know nothing of Pine's `text_formatting` and miss two namespace
 * setters. The label object stores `textalign`, `tooltip`, and `text_font_family`
 * (and its `toPlotData` emits them), but:
 *
 * - `text_formatting` has NO home: not a constructor parameter, not a field, not
 *   in `label.new`'s named-argument map, and no setter anywhere — a script using
 *   it either dies ("not a function") or silently loses the formatting;
 * - `label.set_text_font_family` and `label.set_text_formatting` are absent from
 *   the bound `label.*` namespace (the object METHOD `set_text_font_family`
 *   exists, but Pine calls setters namespace-style: `label.set_x(id, …)`).
 *
 * Until pinets ships these natively, patch the label namespace as each Context
 * binds it: add the missing setters, route a `text_formatting` named argument
 * around the original `new`, and widen the label prototype so `toPlotData`
 * serializes the stamped property (and `copy` carries it). The drawings adapter
 * then picks `text_formatting` up as bold/italic, exactly like boxes and tables.
 *
 * The patch is idempotent, applies to every context this module graph creates
 * (main-thread engine and the worker bundle alike), and steps aside the day
 * pinets provides the parameter (`label.new` already tagged → passed through).
 */

interface LabelNamespace {
    new?: (...args: unknown[]) => unknown;
    set_text_font_family?: (...args: unknown[]) => unknown;
    set_text_formatting?: (...args: unknown[]) => unknown;
}

/** The private surfaces the patch relies on (verified against pinets 0.9.x). */
interface PatchableContext {
    pine: Record<string, unknown>;
    bindContextObject(target: unknown, names: string[], ns?: string): void;
}
interface PatchableLabelHelper {
    _resolve?: (v: unknown) => unknown;
}
interface PatchableLabel {
    _deleted?: boolean;
    text_formatting?: unknown;
    text_font_family?: unknown;
}
interface PatchableLabelProto {
    toPlotData?: (this: PatchableLabel) => Record<string, unknown>;
    copy?: (this: PatchableLabel) => unknown;
    set_text_formatting?: (this: PatchableLabel, v: unknown) => void;
}

let patched = false;
let protoPatched = false;

/**
 * Widen the label class (reached through a live instance — pinets doesn't export
 * it) so the stamped `text_formatting` survives `toPlotData` serialization and
 * `copy`, and a method-style `set_text_formatting` exists like its siblings.
 */
function patchLabelPrototype(lbl: object): void {
    if (protoPatched) return;
    const proto = Object.getPrototypeOf(lbl) as PatchableLabelProto | null;
    if (!proto || typeof proto.toPlotData !== 'function') return;
    protoPatched = true;
    // Deliberately unbound: re-invoked below with the label instance as `this`.
    const origToPlotData = proto.toPlotData;
    const origCopy = proto.copy;
    proto.toPlotData = function (this: PatchableLabel): Record<string, unknown> {
        const out = origToPlotData.call(this);
        if (this.text_formatting !== undefined) out['text_formatting'] = this.text_formatting;
        return out;
    };
    if (typeof origCopy === 'function') {
        proto.copy = function (this: PatchableLabel): unknown {
            const dup = origCopy.call(this) as PatchableLabel | null;
            if (dup && typeof dup === 'object' && this.text_formatting !== undefined) dup.text_formatting = this.text_formatting;
            return dup;
        };
    }
    if (typeof proto.set_text_formatting !== 'function') {
        proto.set_text_formatting = function (this: PatchableLabel, v: unknown): void {
            if (!this._deleted) this.text_formatting = v;
        };
    }
}

export function ensurePineLabelPatch(): void {
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
        if (ns !== 'label') return;
        const label = this.pine['label'] as LabelNamespace | undefined;
        if (!label) return;
        const helper = target as PatchableLabelHelper;
        // Series/function arguments resolve to their current value, like every native setter.
        const resolve = (v: unknown): unknown => (typeof helper._resolve === 'function' ? helper._resolve(v) : v);

        if (typeof label.set_text_font_family !== 'function') {
            label.set_text_font_family = (lbl: unknown, v: unknown): void => {
                const l = lbl as PatchableLabel | null;
                if (l && typeof l === 'object' && !l._deleted) l.text_font_family = resolve(v);
            };
        }
        if (typeof label.set_text_formatting !== 'function') {
            label.set_text_formatting = (lbl: unknown, v: unknown): void => {
                const l = lbl as PatchableLabel | null;
                if (l && typeof l === 'object' && !l._deleted) l.text_formatting = resolve(v);
            };
        }

        const origNew = label.new;
        if (typeof origNew !== 'function') return;
        label.new = (...args: unknown[]): unknown => {
            const last = args[args.length - 1];
            const named = last && typeof last === 'object' && !Array.isArray(last) && 'text_formatting' in last ? (last as Record<string, unknown>) : null;
            let fmt: unknown;
            let forwarded = args;
            if (named) {
                // Strip the key pinets doesn't know before its named-args mapper sees it.
                const { text_formatting, ...rest } = named;
                fmt = text_formatting;
                forwarded = Object.keys(rest).length > 0 ? [...args.slice(0, -1), rest] : args.slice(0, -1);
            }
            const lbl = origNew(...forwarded) as PatchableLabel | null;
            if (lbl && typeof lbl === 'object') {
                patchLabelPrototype(lbl);
                if (named) lbl.text_formatting = resolve(fmt);
            }
            return lbl;
        };
    };
}
