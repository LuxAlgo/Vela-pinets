import type { ExternalIndicatorEntry, InputValue } from '@luxalgo/vela/plugin';

/**
 * A saved custom indicator — a named Pine script plus the metadata needed to put
 * it back on a chart. Stored as plain JSON; every field that comes back OUT of
 * storage is re-validated ({@link sanitizeCustomIndicator}), because a persisted
 * record is untrusted input (a `localStorage` key anyone can edit, a synced file,
 * a row from a backend), never something this package wrote itself.
 */
export interface CustomIndicator {
    /** Stable library id (NOT the chart id: one saved indicator can be added many times). */
    id: string;
    /** Display name — required, trimmed, non-empty. Distinct from any `indicator("…")` title inside the script. */
    name: string;
    /** Pine source, stored verbatim; non-empty. */
    script: string;
    /** Engine language id (default `'pine'`). */
    language: string;
    /** Free-form note. */
    description?: string;
    /** Input-value overrides to apply when adding to a chart (`ExternalIndicatorEntry.inputs`). */
    inputs?: Record<string, InputValue>;
    /** Declaration-prop overrides to apply when adding to a chart (`ExternalIndicatorEntry.props`). */
    props?: Record<string, InputValue>;
    /** Creation time, epoch ms. */
    createdAt: number;
    /** Last modification time, epoch ms. */
    updatedAt: number;
}

/** What {@link CustomIndicatorStore.save} accepts. `id` present → upsert that id; absent → mint one. */
export interface CustomIndicatorInput {
    name: string;
    script: string;
    /** Update target: an existing id updates in place (keeps `createdAt`); a fresh id saves under it. */
    id?: string;
    /** Engine language id (default `'pine'`; on update, `undefined` keeps the stored value only via {@link CustomIndicatorStore.update}). */
    language?: string;
    description?: string;
    inputs?: Record<string, InputValue>;
    props?: Record<string, InputValue>;
}

/** Merge-style patch for {@link CustomIndicatorStore.update}: absent fields keep their stored value. */
export type CustomIndicatorPatch = Partial<
    Pick<CustomIndicator, 'name' | 'script' | 'language' | 'description' | 'inputs' | 'props'>
>;

/** A value that may or may not need awaiting. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Where saved indicators live. Two members, both async-tolerant. `read` returns
 * RAW records (untrusted — they are validated on the way in); `write` receives
 * fully-formed {@link CustomIndicator}s and replaces everything.
 */
export interface CustomIndicatorStorage {
    /** Read back saved records. Unknown shapes are dropped, not thrown. */
    read(): MaybePromise<readonly unknown[]>;
    /** Replace ALL saved records. */
    write(indicators: readonly CustomIndicator[]): MaybePromise<void>;
}

/** The Web Storage slice used by {@link localStorageIndicatorStorage} (`window.localStorage`, or any compatible mock). */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** Listener called after any mutation; re-read {@link CustomIndicatorStore.list} for current state. */
export type CustomIndicatorListener = () => void;

/** Options for {@link CustomIndicatorStore}. */
export interface CustomIndicatorStoreOptions {
    /** Storage backend; default: a fresh in-memory store ({@link memoryIndicatorStorage}). */
    storage?: CustomIndicatorStorage;
    /** Clock, epoch ms; injectable for tests. Default `Date.now`. */
    now?: () => number;
    /** Id minter; injectable for tests. Default `crypto.randomUUID()` with a non-crypto fallback. */
    idFactory?: () => string;
}

/** Options for {@link CustomIndicatorStore.toExternalIndicatorEntry} / {@link CustomIndicatorStore.addToChart}. */
export interface AddCustomIndicatorOptions {
    /** Input-value overrides merged OVER the saved `inputs`. */
    inputs?: Record<string, InputValue>;
    /** Declaration-prop overrides merged OVER the saved `props`. */
    props?: Record<string, InputValue>;
    /**
     * Set the CHART-side indicator id. `true` reuses the library id; a string uses it verbatim;
     * omitted lets the chart mint one. Re-adding an id already live on the chart is rejected by
     * Vela, so only opt in when restoring a chart you own.
     */
    chartId?: boolean | string;
}

/** The slice of Vela's chart API {@link CustomIndicatorStore.addToChart} needs (`Vela` satisfies it). */
export interface ChartAddIndicatorLike {
    addIndicator(entry: ExternalIndicatorEntry): unknown;
}

/** Default language for saved indicators. */
export const DEFAULT_CUSTOM_INDICATOR_LANGUAGE = 'pine';
/** Default `localStorage` key for {@link localStorageIndicatorStorage}. */
export const DEFAULT_CUSTOM_INDICATOR_STORAGE_KEY = 'vela-pinets.custom-indicators';
/** On-disk/on-wire format version written by {@link localStorageIndicatorStorage}. */
export const CUSTOM_INDICATOR_STORAGE_VERSION = 1;

/** Thrown on invalid saves (empty name/script) and storage failures. */
export class CustomIndicatorError extends Error {
    override readonly name = 'CustomIndicatorError';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitizeInputValues(raw: unknown): Record<string, InputValue> | undefined {
    if (!isPlainObject(raw)) return undefined;
    const out: Record<string, InputValue> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'number') {
            if (Number.isFinite(v)) out[k] = v;
        } else if (typeof v === 'string' || typeof v === 'boolean') {
            out[k] = v;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate ONE raw record from storage; `null` when it is not a usable
 * {@link CustomIndicator} (missing id/name/script, wrong types, …).
 * Timestamps default to `0` when absent or malformed rather than dropping the record.
 */
export function sanitizeCustomIndicator(raw: unknown): CustomIndicator | null {
    if (!isPlainObject(raw)) return null;
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    const script = typeof raw['script'] === 'string' ? raw['script'] : '';
    if (id === '' || name === '' || script.trim() === '') return null;
    const language = typeof raw['language'] === 'string' && raw['language'].trim() !== '' ? raw['language'].trim() : DEFAULT_CUSTOM_INDICATOR_LANGUAGE;
    const description = typeof raw['description'] === 'string' ? raw['description'] : undefined;
    const inputs = sanitizeInputValues(raw['inputs']);
    const props = sanitizeInputValues(raw['props']);
    const createdAt = typeof raw['createdAt'] === 'number' && Number.isFinite(raw['createdAt']) && raw['createdAt'] >= 0 ? raw['createdAt'] : 0;
    const updatedAt = typeof raw['updatedAt'] === 'number' && Number.isFinite(raw['updatedAt']) && raw['updatedAt'] >= 0 ? raw['updatedAt'] : createdAt;
    const out: CustomIndicator = { id, name, script, language, createdAt, updatedAt };
    if (description !== undefined) out.description = description;
    if (inputs !== undefined) out.inputs = inputs;
    if (props !== undefined) out.props = props;
    return out;
}

/** JSON-deep-clone; `undefined` round-trips as `undefined`, nothing throws on plain data. */
function cloneJson<T>(v: T): T {
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function cloneIndicator(i: CustomIndicator): CustomIndicator {
    return cloneJson(i);
}

/** In-memory {@link CustomIndicatorStorage}; `initial` seeds it (validated on read, like any backend). */
export function memoryIndicatorStorage(initial: readonly unknown[] = []): CustomIndicatorStorage {
    let saved: readonly unknown[] = cloneJson(initial);
    return {
        read(): readonly unknown[] {
            return cloneJson(saved);
        },
        write(indicators: readonly CustomIndicator[]): void {
            saved = cloneJson(indicators);
        },
    };
}

function globalLocalStorage(): StorageLike | undefined {
    try {
        const s = (globalThis as { localStorage?: StorageLike }).localStorage;
        // Touch the store: some privacy modes expose it but throw on access.
        if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') {
            s.getItem('__vela_pinets_probe__');
            return s;
        }
    } catch {
        /* unavailable */
    }
    return undefined;
}

/**
 * Browser `localStorage` {@link CustomIndicatorStorage}. The whole library is one
 * JSON value under `key`. Corrupt JSON, a wrong shape, or unavailable storage on
 * READ answers "nothing saved"; WRITE surfaces failure as {@link CustomIndicatorError}
 * (a save that silently didn't persist is worse than a thrown one). Validation of
 * individual records happens on read, in {@link CustomIndicatorStore}.
 */
export function localStorageIndicatorStorage(options: { key?: string; storage?: StorageLike } = {}): CustomIndicatorStorage {
    const key = options.key ?? DEFAULT_CUSTOM_INDICATOR_STORAGE_KEY;
    const pick = (): StorageLike | undefined => options.storage ?? globalLocalStorage();
    return {
        read(): readonly unknown[] {
            const storage = pick();
            if (!storage) return [];
            let raw: string | null;
            try {
                raw = storage.getItem(key);
            } catch {
                return [];
            }
            if (raw === null || raw === '') return [];
            try {
                const parsed: unknown = JSON.parse(raw);
                // Envelope `{ version, indicators }` or a bare array (hand-written / legacy).
                if (Array.isArray(parsed)) return parsed;
                if (isPlainObject(parsed) && Array.isArray(parsed['indicators'])) return parsed['indicators'] as readonly unknown[];
                return [];
            } catch {
                return []; // corrupt JSON: read empty; the next write replaces it
            }
        },
        write(indicators: readonly CustomIndicator[]): void {
            const storage = pick();
            if (!storage) throw new CustomIndicatorError('localStorage is not available in this environment');
            try {
                storage.setItem(key, JSON.stringify({ version: CUSTOM_INDICATOR_STORAGE_VERSION, indicators }));
            } catch (e) {
                throw new CustomIndicatorError(`failed to persist custom indicators to localStorage key "${key}": ${e instanceof Error ? e.message : String(e)}`, { cause: e });
            }
        },
    };
}

/**
 * A library of the user's OWN indicators — named Pine scripts saved, listed,
 * updated and removed, and turned back into chart additions. Storage-agnostic:
 * the default is in-memory; pass {@link localStorageIndicatorStorage} to persist
 * across reloads, or any {@link CustomIndicatorStorage} (file, IndexedDB, backend).
 *
 * Operations are serialized (a read-modify-write queue), so concurrent calls
 * can't clobber each other. Every mutation notifies {@link subscribe} listeners.
 * Nothing is cached in memory across calls: storage is the source of truth.
 *
 * Distinct from Vela's own chart-state persistence (`persist` /
 * `registerStatePersistence`), which restores what is ON a chart — this restores
 * what a user has WRITTEN, independent of any chart.
 *
 * ```ts
 * const library = new CustomIndicatorStore({ storage: localStorageIndicatorStorage() });
 * await library.save({ name: 'My RSI', script: `//@version=5\nindicator("My RSI", overlay=false)\nplot(ta.rsi(close, 14))` });
 * chart.addIndicator(await library.toExternalIndicatorEntry(id)!);
 * ```
 */
export class CustomIndicatorStore {
    private readonly storage: CustomIndicatorStorage;
    private readonly now: () => number;
    private readonly idFactory: () => string;
    private readonly listeners = new Set<CustomIndicatorListener>();
    /** Serializes read-modify-write cycles; a failed op never breaks the chain. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(options: CustomIndicatorStoreOptions = {}) {
        this.storage = options.storage ?? memoryIndicatorStorage();
        this.now = options.now ?? ((): number => Date.now());
        this.idFactory = options.idFactory ?? defaultIdFactory;
    }

    /** All saved indicators, in insertion order. Fresh copies; mutating them changes nothing. */
    async list(): Promise<CustomIndicator[]> {
        return this.enqueue(async () => (await this.readAll()).map(cloneIndicator));
    }

    /** One saved indicator by id. */
    async get(id: string): Promise<CustomIndicator | undefined> {
        return this.enqueue(async () => {
            const found = (await this.readAll()).find((i) => i.id === id);
            return found ? cloneIndicator(found) : undefined;
        });
    }

    /** One saved indicator by display name (trimmed, case-sensitive). */
    async getByName(name: string): Promise<CustomIndicator | undefined> {
        const wanted = name.trim();
        return this.enqueue(async () => {
            const found = (await this.readAll()).find((i) => i.name === wanted);
            return found ? cloneIndicator(found) : undefined;
        });
    }

    /** Whether an id is saved. */
    async has(id: string): Promise<boolean> {
        return (await this.get(id)) !== undefined;
    }

    /**
     * Save an indicator — CREATE, or REPLACE an existing id when `input.id` names one
     * (`createdAt` is kept on replace; `updatedAt` is bumped). Replace semantics:
     * fields not in `input` are cleared; use {@link update} for merge semantics.
     * Name must be non-empty after trim; script must be non-empty; throws {@link CustomIndicatorError}.
     */
    async save(input: CustomIndicatorInput): Promise<CustomIndicator> {
        const name = validateName(input.name);
        const script = validateScript(input.script);
        return this.enqueue(async () => {
            const all = await this.readAll();
            const wantedId = typeof input.id === 'string' ? input.id.trim() : '';
            const existingIndex = wantedId === '' ? -1 : all.findIndex((i) => i.id === wantedId);
            const existing = existingIndex >= 0 ? all[existingIndex] : undefined;
            const id = wantedId !== '' ? wantedId : this.mintUnusedId(all);
            const now = this.now();
            const next: CustomIndicator = {
                id,
                name,
                script,
                language: normalizeLanguage(input.language) ?? DEFAULT_CUSTOM_INDICATOR_LANGUAGE,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            };
            if (input.description !== undefined) next.description = input.description;
            const inputs = sanitizeInputValues(input.inputs);
            if (inputs !== undefined) next.inputs = inputs;
            const props = sanitizeInputValues(input.props);
            if (props !== undefined) next.props = props;
            if (existingIndex >= 0) all[existingIndex] = next;
            else all.push(next);
            await this.storage.write(all);
            this.notify();
            return cloneIndicator(next);
        });
    }

    /**
     * Merge-style update of an existing id: absent patch fields keep their stored
     * value. `name`/`script` stay validated; `description: ''` clears. Returns
     * `undefined` when `id` is not saved (nothing is written).
     */
    async update(id: string, patch: CustomIndicatorPatch): Promise<CustomIndicator | undefined> {
        return this.enqueue(async () => {
            const all = await this.readAll();
            const index = all.findIndex((i) => i.id === id);
            const current = index >= 0 ? all[index] : undefined;
            if (!current) return undefined;
            const next: CustomIndicator = {
                ...current,
                name: patch.name !== undefined ? validateName(patch.name) : current.name,
                script: patch.script !== undefined ? validateScript(patch.script) : current.script,
                language: patch.language !== undefined ? (normalizeLanguage(patch.language) ?? current.language) : current.language,
                updatedAt: this.now(),
            };
            if (patch.description !== undefined) next.description = patch.description;
            if (patch.inputs !== undefined) {
                const inputs = sanitizeInputValues(patch.inputs);
                if (inputs !== undefined) next.inputs = inputs;
                else delete next.inputs;
            }
            if (patch.props !== undefined) {
                const props = sanitizeInputValues(patch.props);
                if (props !== undefined) next.props = props;
                else delete next.props;
            }
            all[index] = next;
            await this.storage.write(all);
            this.notify();
            return cloneIndicator(next);
        });
    }

    /** Rename a saved indicator. `undefined` when `id` is not saved. */
    async rename(id: string, name: string): Promise<CustomIndicator | undefined> {
        return this.update(id, { name });
    }

    /** Remove a saved indicator. `true` when something was removed. */
    async remove(id: string): Promise<boolean> {
        return this.enqueue(async () => {
            const all = await this.readAll();
            const next = all.filter((i) => i.id !== id);
            if (next.length === all.length) return false;
            await this.storage.write(next);
            this.notify();
            return true;
        });
    }

    /** Remove everything saved. */
    async clear(): Promise<void> {
        return this.enqueue(async () => {
            await this.storage.write([]);
            this.notify();
        });
    }

    /** Subscribe to changes (after every successful mutation). Returns an unsubscribe. */
    subscribe(listener: CustomIndicatorListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * The saved indicator as Vela's {@link ExternalIndicatorEntry} for
     * `chart.addIndicator(...)`. Saved `inputs`/`props` are carried; `options`
     * merge over them. `undefined` when `id` is not saved.
     */
    async toExternalIndicatorEntry(id: string, options: AddCustomIndicatorOptions = {}): Promise<ExternalIndicatorEntry | undefined> {
        const found = await this.get(id);
        if (!found) return undefined;
        return externalIndicatorEntryFrom(found, options);
    }

    /**
     * Add a saved indicator to a chart through `chart.addIndicator(...)`
     * (any Vela `Vela` / `WidgetContext` chart satisfies {@link ChartAddIndicatorLike}).
     * Returns whatever `addIndicator` returns; `undefined` when `id` is not saved.
     */
    async addToChart(chart: ChartAddIndicatorLike, id: string, options: AddCustomIndicatorOptions = {}): Promise<unknown> {
        const entry = await this.toExternalIndicatorEntry(id, options);
        if (!entry) return undefined;
        return chart.addIndicator(entry);
    }

    /** Validated records from the backend; malformed entries are dropped. */
    private async readAll(): Promise<CustomIndicator[]> {
        const raw = await this.storage.read();
        if (!Array.isArray(raw)) return [];
        const out: CustomIndicator[] = [];
        const seen = new Set<string>();
        for (const item of raw) {
            const s = sanitizeCustomIndicator(item);
            if (s && !seen.has(s.id)) {
                seen.add(s.id);
                out.push(s);
            }
        }
        return out;
    }

    private mintUnusedId(all: readonly CustomIndicator[]): string {
        const used = new Set(all.map((i) => i.id));
        const minted = this.idFactory().trim();
        const base = minted !== '' ? minted : defaultIdFactory();
        if (!used.has(base)) return base;
        // A constant/sloppy idFactory can't spin forever: disambiguate with a suffix.
        for (let n = 2; ; n += 1) {
            const candidate = `${base}-${n}`;
            if (!used.has(candidate)) return candidate;
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                /* a throwing listener never breaks the store or other listeners */
            }
        }
    }

    private enqueue<T>(op: () => Promise<T>): Promise<T> {
        const run = this.queue.then(op, op);
        this.queue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }
}

/** Pure form of {@link CustomIndicatorStore.toExternalIndicatorEntry}. */
export function externalIndicatorEntryFrom(indicator: CustomIndicator, options: AddCustomIndicatorOptions = {}): ExternalIndicatorEntry {
    const inputs = { ...(indicator.inputs ?? {}), ...(options.inputs ?? {}) };
    const props = { ...(indicator.props ?? {}), ...(options.props ?? {}) };
    const entry: ExternalIndicatorEntry = {
        name: indicator.name,
        script: indicator.script,
        language: indicator.language,
    };
    if (Object.keys(inputs).length > 0) entry.inputs = inputs;
    if (Object.keys(props).length > 0) entry.props = props;
    if (options.chartId === true) entry.id = indicator.id;
    else if (typeof options.chartId === 'string' && options.chartId.trim() !== '') entry.id = options.chartId.trim();
    return entry;
}

function validateName(name: unknown): string {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed === '') throw new CustomIndicatorError('custom indicator name must be a non-empty string');
    return trimmed;
}

function validateScript(script: unknown): string {
    if (typeof script !== 'string' || script.trim() === '') throw new CustomIndicatorError('custom indicator script must be a non-empty string');
    return script;
}

function normalizeLanguage(language: string | undefined): string | undefined {
    if (language === undefined) return undefined;
    const trimmed = language.trim();
    return trimmed === '' ? undefined : trimmed;
}

function defaultIdFactory(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `ci_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
