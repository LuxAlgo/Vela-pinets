// A strategy's declaration properties (`strategy(initial_capital=…, commission_value=…)`)
// surfaced as ordinary settings-dialog inputs on their own "Properties" tab, and routed
// back into PineTS as `.prop` overrides — never as script inputs. Same narrow-contract
// philosophy as inputsMeta.ts: read the few PineTS fields we promise (`getPropsMeta`,
// the `.prop` view), translate at this seam, and let PineTS reshape internals freely.
//
// The keys are namespaced (`strategy.<name>`) so they can ride the ONE inputs record the
// whole pipeline already carries — dialog edits, persistence, undo, the worker protocol —
// with zero new channels. Pine identifiers cannot contain a dot, so the prefix can never
// collide with a script input's varId.
import type { Indicator } from 'pinets';
import type { InputSchema, InputValue } from '@luxalgo/vela/plugin';

export const STRATEGY_PROP_PREFIX = 'strategy.';

/** The settings-dialog tab hosting the synthesized rows. */
export const STRATEGY_PROPS_TAB = 'Properties';

/** The slice of a PineTS `IPineProp` this module reads (kept loose to absorb drift). */
interface RawProp {
    name?: string;
    type?: string;
    defval?: unknown;
    options?: unknown[];
    minval?: number;
    maxval?: number;
    mutable?: boolean;
}

/**
 * The curated Properties rows, in display order. PineTS's schema carries ~30 declaration
 * args; the dialog shows the ones a backtester actually tunes. Untitled entries render
 * as the unlabeled second control of their `inline` pair (value + unit-type dropdowns).
 * The leading rows carry no `group` on purpose — they sit directly under the tab strip.
 */
const PROP_ROWS: ReadonlyArray<{ name: string; title: string; group?: string; inline?: string }> = [
    { name: 'initial_capital', title: 'Initial capital' },
    { name: 'currency', title: 'Base currency' },
    { name: 'default_qty_value', title: 'Default order size', inline: 'qty' },
    { name: 'default_qty_type', title: '', inline: 'qty' },
    { name: 'pyramiding', title: 'Pyramiding' },
    { name: 'commission_value', title: 'Commission', group: 'Cost simulation', inline: 'commission' },
    { name: 'commission_type', title: '', group: 'Cost simulation', inline: 'commission' },
    { name: 'slippage', title: 'Slippage', group: 'Cost simulation' },
    { name: 'margin_long', title: 'Margin for long positions, %', group: 'Margin' },
    { name: 'margin_short', title: 'Margin for short positions, %', group: 'Margin' },
];

/**
 * Display labels for the enum runtime values. Vela's `InputSchema.options` are value and
 * label in one, so the dialog stores the DISPLAY string as the input value — the write
 * seam ({@link applyStrategyProps}) translates it back to PineTS's runtime vocabulary.
 * Values without a label (e.g. currency codes, already capitals) pass through unchanged.
 */
const ENUM_LABELS: Record<string, Record<string, string>> = {
    default_qty_type: { fixed: 'Fixed', cash: 'Cash', percent_of_equity: '% Of Equity' },
    commission_type: { percent: 'Percent', cash_per_contract: 'Cash Per Contract', cash_per_order: 'Cash Per Order' },
};

function toLabel(name: string, value: string): string {
    return ENUM_LABELS[name]?.[value] ?? value;
}

function toRuntime(name: string, value: InputValue): InputValue {
    const labels = ENUM_LABELS[name];
    if (!labels || typeof value !== 'string') return value;
    for (const [runtime, label] of Object.entries(labels)) if (label === value) return runtime;
    return value;
}

/** PineTS prop type → the renderer-neutral input type (enums become dropdowns). */
function inputTypeOf(propType: string | undefined): InputSchema['type'] {
    if (propType === 'int') return 'int';
    if (propType === 'float') return 'float';
    if (propType === 'bool') return 'bool';
    return 'string';
}

function asValue(raw: unknown, type: InputSchema['type']): InputValue {
    if (type === 'int' || type === 'float') return typeof raw === 'number' ? raw : Number(raw) || 0;
    if (type === 'bool') return Boolean(raw);
    return typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
}

/**
 * The synthesized Properties rows for a prepared script — empty for anything that is
 * not a `strategy()`. Defaults come from the live `.prop` view (spec default overlaid
 * with the source-declared args), so "Reset defaults" restores what the SCRIPT declared,
 * and a strategy with no `input.*()` calls still gets a settings dialog.
 */
export function strategyPropInputs(ind: InstanceType<typeof Indicator>): InputSchema[] {
    if (ind.getDeclarationType() !== 'strategy') return [];
    const meta = new Map<string, RawProp>();
    for (const p of ind.getPropsMeta() as RawProp[]) if (p.name) meta.set(p.name, p);
    const view = ind.prop;

    const out: InputSchema[] = [];
    for (const row of PROP_ROWS) {
        const p = meta.get(row.name);
        if (!p || p.mutable === false) continue;
        const type = inputTypeOf(p.type);
        const defval = asValue(view[row.name] ?? p.defval, type);
        out.push({
            key: STRATEGY_PROP_PREFIX + row.name,
            title: row.title,
            type,
            defval: typeof defval === 'string' ? toLabel(row.name, defval) : defval,
            min: p.minval,
            max: p.maxval,
            options: Array.isArray(p.options) ? p.options.map((o) => toLabel(row.name, String(o))) : undefined,
            group: row.group,
            inline: row.inline,
            tab: STRATEGY_PROPS_TAB,
        });
    }
    return out;
}

/**
 * Split one resolved inputs record into the script's own inputs and the prop overrides
 * (prefix stripped). Returns the input object untouched when no prop keys are present —
 * the norm for every indicator script.
 */
export function splitStrategyProps(inputs: Record<string, InputValue>): {
    scriptInputs: Record<string, InputValue>;
    propOverrides: Record<string, InputValue>;
} {
    if (!Object.keys(inputs).some((k) => k.startsWith(STRATEGY_PROP_PREFIX))) {
        return { scriptInputs: inputs, propOverrides: {} };
    }
    const scriptInputs: Record<string, InputValue> = {};
    const propOverrides: Record<string, InputValue> = {};
    for (const [key, value] of Object.entries(inputs)) {
        if (key.startsWith(STRATEGY_PROP_PREFIX)) propOverrides[key.slice(STRATEGY_PROP_PREFIX.length)] = value;
        else scriptInputs[key] = value;
    }
    return { scriptInputs, propOverrides };
}

/**
 * Write the overrides into the instance's `.prop` view; `pine.run()` merges them on top
 * of the source-declared `strategy()` args. Skipped for non-strategy declarations: their
 * schema has no such keys, and a stale persisted prop key must not throw the run away.
 */
export function applyStrategyProps(ind: InstanceType<typeof Indicator>, overrides: Record<string, InputValue>): void {
    if (ind.getDeclarationType() !== 'strategy') return;
    const prop = ind.prop;
    for (const [name, value] of Object.entries(overrides)) prop[name] = toRuntime(name, value);
}
