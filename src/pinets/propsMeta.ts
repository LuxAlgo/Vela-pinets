import type { Indicator } from 'pinets';
import type { InputSchema, InputType, InputValue } from '@luxalgo/vela/plugin';

/** The subset of PineTS `IPineProp` we read (kept loose to absorb drift). */
export interface RawPineProp {
    name?: string;
    type?: string;
    defval?: unknown;
    options?: unknown[];
    minval?: number;
    maxval?: number;
    mutable?: boolean;
}

/** PineTS prop types map onto a narrow InputType subset: enum renders as a
 *  select (options carry the choices), everything unrecognized as text. */
function mapType(type: string | undefined): InputType {
    switch (type) {
        case 'int':
            return 'int';
        case 'float':
            return 'float';
        case 'bool':
            return 'bool';
        default:
            return 'string';
    }
}

function asPropValue(value: unknown, type: InputType): InputValue {
    if (type === 'bool') return Boolean(value);
    if (type === 'int' || type === 'float') return typeof value === 'number' ? value : Number(value) || 0;
    return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** Display label for a prop name: `initial_capital` → "Initial capital". */
function labelOf(name: string): string {
    const words = name.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Map PineTS declaration-prop metadata → the renderer-neutral `InputSchema[]`
 * (the settings dialog's "Properties" tab). Only mutable entries cross —
 * `title`/`shorttitle` are identity, not settings, and `.prop` rejects writes
 * to them anyway.
 *
 * Each entry's `defval` is the EFFECTIVE default, resolved here so the dialog
 * opens on it and "Reset defaults" restores it:
 * source-declared value ← engine `defaultProps` ← Pine spec default.
 * The `.prop` read view merges spec ← source, so a value differing from the
 * spec default means the source declared it; a source declaration EQUAL to the
 * spec default is indistinguishable from an omission and yields to the engine
 * default (same value semantics, no author intent lost).
 */
export function mapProps(ind: InstanceType<typeof Indicator>, defaultProps?: Record<string, InputValue>): InputSchema[] {
    const meta: RawPineProp[] = ind.getPropsMeta();
    const view = ind.prop;
    return meta
        .filter((p) => p.mutable && p.name)
        .map((p) => {
            const name = p.name!;
            const type = mapType(p.type);
            const spec = asPropValue(p.defval, type);
            const merged = asPropValue(view[name] ?? p.defval, type);
            const hostDefault = defaultProps?.[name];
            const defval = merged !== spec ? merged : hostDefault !== undefined ? asPropValue(hostDefault, type) : spec;
            return {
                key: name,
                title: labelOf(name),
                type,
                defval,
                min: p.minval,
                max: p.maxval,
                options: Array.isArray(p.options) ? p.options.map((o) => String(o)) : undefined,
            };
        });
}

/**
 * Apply prop overrides onto a fresh Indicator instance. A rejected write (an
 * unknown key from a host `setProps`, an out-of-range value) warns and skips —
 * one bad prop must not kill the whole run.
 */
export function applyProps(ind: InstanceType<typeof Indicator>, props: Record<string, InputValue>): void {
    for (const [name, value] of Object.entries(props)) {
        try {
            ind.prop[name] = value;
        } catch (err) {
            console.warn(`[vela-pinets] prop "${name}" rejected:`, err instanceof Error ? err.message : err);
        }
    }
}
