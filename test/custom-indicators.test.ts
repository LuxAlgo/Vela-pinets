import { describe, it, expect, vi } from 'vitest';
import {
    CustomIndicatorStore,
    CustomIndicatorError,
    memoryIndicatorStorage,
    localStorageIndicatorStorage,
    sanitizeCustomIndicator,
    externalIndicatorEntryFrom,
    DEFAULT_CUSTOM_INDICATOR_STORAGE_KEY,
    type CustomIndicator,
    type CustomIndicatorStorage,
    type StorageLike,
    type ChartAddIndicatorLike,
} from '../src';
import type { ExternalIndicatorEntry } from '@luxalgo/vela/plugin';

/**
 * Saving your own indicators: the CustomIndicatorStore library API + its storage
 * adapters. Saved records are UNTRUSTED on the way out of storage — validation,
 * sanitization, tolerance of corrupt persistence — and the chart bridge emits
 * Vela's ExternalIndicatorEntry shape.
 */

const SCRIPT = `//@version=5
indicator("My RSI", overlay=false)
plot(ta.rsi(close, 14), color=color.purple)`;

function fakeLocalStorage(seed: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>(Object.entries(seed));
    return {
        data,
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => void data.set(k, v),
    };
}

describe('CustomIndicatorStore — save / list / get', () => {
    it('saves a custom indicator and lists it back (trimmed name, verbatim script, pine default, timestamps)', async () => {
        const store = new CustomIndicatorStore({ now: () => 1000 });
        const saved = await store.save({ name: '  My RSI  ', script: SCRIPT });
        expect(saved.id).toBeTruthy();
        expect(saved.name).toBe('My RSI');
        expect(saved.script).toBe(SCRIPT);
        expect(saved.language).toBe('pine');
        expect(saved.createdAt).toBe(1000);
        expect(saved.updatedAt).toBe(1000);
        expect(await store.list()).toEqual([saved]);
        expect(await store.get(saved.id)).toEqual(saved);
        expect(await store.getByName(' My RSI ')).toEqual(saved);
        expect(await store.has(saved.id)).toBe(true);
        expect(await store.has('nope')).toBe(false);
    });

    it('mints unique ids; accepts a caller-chosen id', async () => {
        const store = new CustomIndicatorStore({ idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
        const a = await store.save({ name: 'a', script: SCRIPT });
        const b = await store.save({ name: 'b', script: SCRIPT });
        expect(a.id).toBe('id-1');
        expect(b.id).toBe('id-2');
        const c = await store.save({ id: 'mine', name: 'c', script: SCRIPT });
        expect(c.id).toBe('mine');
        // An idFactory colliding with an existing id is skipped.
        const d = await store.save({ name: 'd', script: SCRIPT });
        expect(d.id).not.toBe(a.id);
        expect(d.id).not.toBe(b.id);
    });

    it('rejects empty name / empty script with CustomIndicatorError', async () => {
        const store = new CustomIndicatorStore();
        await expect(store.save({ name: '   ', script: SCRIPT })).rejects.toBeInstanceOf(CustomIndicatorError);
        await expect(store.save({ name: 'x', script: '   \n  ' })).rejects.toBeInstanceOf(CustomIndicatorError);
        await expect(store.save({ name: '', script: SCRIPT })).rejects.toBeInstanceOf(CustomIndicatorError);
        expect(await store.list()).toEqual([]);
    });

    it('save with an existing id REPLACES it, keeps createdAt, bumps updatedAt', async () => {
        let t = 1000;
        const store = new CustomIndicatorStore({ now: () => t });
        const a = await store.save({ id: 'x', name: 'first', script: SCRIPT, description: 'note', inputs: { len: 14 } });
        t = 2000;
        const b = await store.save({ id: 'x', name: 'second', script: `${SCRIPT}\n// edit`, language: 'pine' });
        expect(b.createdAt).toBe(a.createdAt);
        expect(b.updatedAt).toBe(2000);
        expect(b.name).toBe('second');
        expect(b.description).toBeUndefined(); // replace semantics: not carried over
        expect(b.inputs).toBeUndefined();
        expect((await store.list()).length).toBe(1);
    });

    it('carries saved inputs / props, filtering non-InputValue entries', async () => {
        const store = new CustomIndicatorStore();
        const saved = await store.save({
            name: 'x',
            script: SCRIPT,
            inputs: { len: 20, mode: 'ema', on: true, bad: Number.NaN, obj: { nope: 1 } as unknown as number, nil: null as unknown as number },
            props: { precision: 2 },
        });
        expect(saved.inputs).toEqual({ len: 20, mode: 'ema', on: true });
        expect(saved.props).toEqual({ precision: 2 });
    });

    it('returns fresh copies — mutating a returned indicator changes nothing', async () => {
        const store = new CustomIndicatorStore();
        const saved = await store.save({ name: 'x', script: SCRIPT, inputs: { len: 14 } });
        saved.name = 'hacked';
        saved.inputs!['len'] = 999;
        const list = await store.list();
        expect(list[0]!.name).toBe('x');
        expect(list[0]!.inputs).toEqual({ len: 14 });
        list[0]!.script = 'nope';
        expect((await store.get(saved.id))!.script).toBe(SCRIPT);
    });
});

describe('CustomIndicatorStore — update / rename / remove / clear', () => {
    it('update merges a patch, keeps createdAt, bumps updatedAt', async () => {
        let t = 1000;
        const store = new CustomIndicatorStore({ now: () => t });
        const a = await store.save({ id: 'x', name: 'x', script: SCRIPT, description: 'keep', inputs: { len: 14 } });
        t = 5000;
        const b = await store.update('x', { name: 'renamed' });
        expect(b).toMatchObject({ id: 'x', name: 'renamed', script: SCRIPT, description: 'keep', inputs: { len: 14 }, createdAt: a.createdAt, updatedAt: 5000 });
        expect((await store.update('x', { description: '' }))!.description).toBe('');
        expect((await store.update('x', { inputs: {} }))!.inputs).toBeUndefined();
        expect(await store.update('missing', { name: 'nope' })).toBeUndefined();
    });

    it('update rejects a patch that would empty name or script', async () => {
        const store = new CustomIndicatorStore();
        await store.save({ id: 'x', name: 'x', script: SCRIPT });
        await expect(store.update('x', { name: '  ' })).rejects.toBeInstanceOf(CustomIndicatorError);
        await expect(store.update('x', { script: '' })).rejects.toBeInstanceOf(CustomIndicatorError);
        expect((await store.get('x'))!.name).toBe('x');
    });

    it('rename trims and validates; remove deletes; clear empties', async () => {
        const store = new CustomIndicatorStore();
        await store.save({ id: 'x', name: 'x', script: SCRIPT });
        expect((await store.rename('x', '  y '))!.name).toBe('y');
        await expect(store.rename('x', ' ')).rejects.toBeInstanceOf(CustomIndicatorError);
        expect(await store.rename('missing', 'y')).toBeUndefined();
        expect(await store.remove('x')).toBe(true);
        expect(await store.remove('x')).toBe(false);
        await store.save({ name: 'a', script: SCRIPT });
        await store.save({ name: 'b', script: SCRIPT });
        await store.clear();
        expect(await store.list()).toEqual([]);
    });

    it('serializes concurrent mutations (no lost updates)', async () => {
        const store = new CustomIndicatorStore();
        await Promise.all(Array.from({ length: 10 }, (_, i) => store.save({ name: `n${i}`, script: SCRIPT })));
        expect((await store.list()).length).toBe(10);
    });
});

describe('CustomIndicatorStore — subscribe', () => {
    it('notifies after every successful mutation; unsubscribes; swallows listener errors', async () => {
        const store = new CustomIndicatorStore();
        const seen: number[] = [];
        const bad = vi.fn(() => { throw new Error('listener blew up'); });
        const unsubBad = store.subscribe(bad);
        const unsub = store.subscribe(() => seen.push(1));
        await store.save({ id: 'x', name: 'x', script: SCRIPT });
        await store.update('x', { name: 'y' });
        await store.rename('x', 'z');
        await store.remove('x');
        await store.save({ name: 'a', script: SCRIPT });
        await store.clear();
        expect(seen.length).toBe(6);
        expect(bad).toHaveBeenCalledTimes(6);
        unsub();
        unsubBad();
        await store.save({ name: 'b', script: SCRIPT });
        expect(seen.length).toBe(6);
        // failed saves don't notify
        await expect(store.save({ name: ' ', script: SCRIPT })).rejects.toBeInstanceOf(CustomIndicatorError);
        expect(seen.length).toBe(6);
    });
});

describe('sanitizeCustomIndicator — untrusted storage', () => {
    it('drops malformed records', () => {
        expect(sanitizeCustomIndicator(null)).toBeNull();
        expect(sanitizeCustomIndicator(42)).toBeNull();
        expect(sanitizeCustomIndicator('x')).toBeNull();
        expect(sanitizeCustomIndicator([])).toBeNull();
        expect(sanitizeCustomIndicator({})).toBeNull();
        expect(sanitizeCustomIndicator({ id: 'x', name: 'x', script: '' })).toBeNull();
        expect(sanitizeCustomIndicator({ id: 'x', name: 'x', script: '   ' })).toBeNull();
        expect(sanitizeCustomIndicator({ id: 'x', name: '', script: SCRIPT })).toBeNull();
        expect(sanitizeCustomIndicator({ id: '', name: 'x', script: SCRIPT })).toBeNull();
        expect(sanitizeCustomIndicator({ id: 1, name: 'x', script: SCRIPT })).toBeNull();
    });

    it('defaults language, timestamps, optional fields; sanitizes input values', () => {
        const s = sanitizeCustomIndicator({ id: 'x', name: ' n ', script: SCRIPT, createdAt: 'soon', updatedAt: -5, language: '', description: 7, inputs: { a: 1, b: 'x', c: true, d: null, e: {}, f: Number.NaN } });
        expect(s).toEqual({ id: 'x', name: 'n', script: SCRIPT, language: 'pine', createdAt: 0, updatedAt: 0, inputs: { a: 1, b: 'x', c: true } });
    });

    it('a backend returning garbage reads as an empty library; duplicate ids keep the first', async () => {
        const junk: CustomIndicatorStorage = {
            read: () => [null, 5, 'x', { id: 'a', name: 'a', script: SCRIPT }, { id: 'a', name: 'dupe', script: SCRIPT }, { id: 'b' }, { id: 'b', name: 'b', script: SCRIPT }],
            write: () => {},
        };
        const store = new CustomIndicatorStore({ storage: junk });
        const list = await store.list();
        expect(list.map((i) => i.id)).toEqual(['a', 'b']);
        expect(list[0]!.name).toBe('a');
    });
});

describe('storage adapters', () => {
    it('memoryIndicatorStorage round-trips, isolates mutation, seeds initial', async () => {
        const storage = memoryIndicatorStorage([{ id: 'x', name: 'x', script: SCRIPT }]);
        const store = new CustomIndicatorStore({ storage });
        expect((await store.list()).length).toBe(1);
        const read = await storage.read();
        (read as unknown[]).length = 0; // mutating what read returned changes nothing
        expect((await storage.read()).length).toBe(1);
    });

    it('localStorageIndicatorStorage persists under a namespaced key; reload reads it back', async () => {
        const backing = fakeLocalStorage();
        const storage = localStorageIndicatorStorage({ storage: backing });
        const store = new CustomIndicatorStore({ storage });
        const saved = await store.save({ name: 'mine', script: SCRIPT, description: 'd', inputs: { len: 9 } });
        const raw = backing.data.get(DEFAULT_CUSTOM_INDICATOR_STORAGE_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw!) as { version: number; indicators: CustomIndicator[] };
        expect(parsed.version).toBe(1);
        expect(parsed.indicators[0]!.name).toBe('mine');
        // A NEW store over the same backing (a page reload) sees it.
        const reloaded = new CustomIndicatorStore({ storage: localStorageIndicatorStorage({ storage: backing }) });
        expect(await reloaded.get(saved.id)).toEqual(saved);
        await reloaded.remove(saved.id);
        expect(await store.list()).toEqual([]);
    });

    it('custom key; accepts a bare-array payload; corrupt JSON reads empty; write failure throws', async () => {
        const backing = fakeLocalStorage();
        const key = 'my.key';
        // legacy bare-array payload
        backing.data.set(key, JSON.stringify([{ id: 'x', name: 'x', script: SCRIPT }]));
        const storage = localStorageIndicatorStorage({ key, storage: backing });
        expect((await new CustomIndicatorStore({ storage }).list()).length).toBe(1);
        backing.data.set(key, '{not json');
        expect(await new CustomIndicatorStore({ storage }).list()).toEqual([]);
        backing.data.set(key, '{"nope":1}');
        expect(await new CustomIndicatorStore({ storage }).list()).toEqual([]);
        const throwing: StorageLike = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
        await expect(new CustomIndicatorStore({ storage: localStorageIndicatorStorage({ storage: throwing }) }).save({ name: 'x', script: SCRIPT })).rejects.toBeInstanceOf(CustomIndicatorError);
        const readThrowing: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
        expect(await new CustomIndicatorStore({ storage: localStorageIndicatorStorage({ storage: readThrowing }) }).list()).toEqual([]);
    });

    it('localStorage unavailable: read empty, write throws (no silent no-persist)', async () => {
        // Node has no window.localStorage at module scope here; explicit empty backing proves the path via throwing setItem.
        const storage = localStorageIndicatorStorage({ storage: { getItem: () => null, setItem: () => { throw new Error('nope'); } } });
        const store = new CustomIndicatorStore({ storage });
        expect(await store.list()).toEqual([]);
        await expect(store.save({ name: 'x', script: SCRIPT })).rejects.toBeInstanceOf(CustomIndicatorError);
    });

    it('a custom async CustomIndicatorStorage backend works', async () => {
        let saved: readonly CustomIndicator[] = [];
        const backend: CustomIndicatorStorage = {
            read: async () => saved,
            write: async (all) => { saved = all; },
        };
        const store = new CustomIndicatorStore({ storage: backend });
        await store.save({ name: 'x', script: SCRIPT });
        expect(saved.length).toBe(1);
        expect((await store.list())[0]!.name).toBe('x');
    });
});

describe('chart bridge — Vela ExternalIndicatorEntry', () => {
    it('toExternalIndicatorEntry: name/script/language, saved + merged inputs/props, optional chartId', async () => {
        const store = new CustomIndicatorStore();
        const saved = await store.save({ id: 'x', name: 'My RSI', script: SCRIPT, inputs: { len: 14 }, props: { precision: 2 } });
        expect(await store.toExternalIndicatorEntry('x')).toEqual({ name: 'My RSI', script: SCRIPT, language: 'pine', inputs: { len: 14 }, props: { precision: 2 } });
        expect(await store.toExternalIndicatorEntry('x', { inputs: { len: 21, src: 'open' }, props: { precision: 4 } })).toEqual({
            name: 'My RSI',
            script: SCRIPT,
            language: 'pine',
            inputs: { len: 21, src: 'open' },
            props: { precision: 4 },
        });
        expect((await store.toExternalIndicatorEntry('x', { chartId: true }))!.id).toBe('x');
        expect((await store.toExternalIndicatorEntry('x', { chartId: 'chart-9' }))!.id).toBe('chart-9');
        expect(await store.toExternalIndicatorEntry('missing')).toBeUndefined();
        expect(saved.id).toBe('x');
    });

    it('externalIndicatorEntryFrom is pure; omits empty inputs/props', () => {
        const ind: CustomIndicator = { id: 'x', name: 'n', script: SCRIPT, language: 'pine', createdAt: 0, updatedAt: 0 };
        expect(externalIndicatorEntryFrom(ind)).toEqual({ name: 'n', script: SCRIPT, language: 'pine' });
    });

    it('addToChart calls chart.addIndicator with the entry; undefined when not saved', async () => {
        const store = new CustomIndicatorStore();
        await store.save({ id: 'x', name: 'n', script: SCRIPT });
        const calls: ExternalIndicatorEntry[] = [];
        const chart: ChartAddIndicatorLike = { addIndicator: (entry) => { calls.push(entry); return { id: 'chart-1' }; } };
        const result = await store.addToChart(chart, 'x');
        expect(result).toEqual({ id: 'chart-1' });
        expect(calls).toEqual([{ name: 'n', script: SCRIPT, language: 'pine' }]);
        expect(await store.addToChart(chart, 'missing')).toBeUndefined();
        expect(calls.length).toBe(1);
    });

    it('a saved indicator actually prepares and runs on the Pine engine', async () => {
        // End to end: what we hand Vela is a real runnable Pine script through THIS package's engine.
        const { PineEngine } = await import('../src');
        const store = new CustomIndicatorStore();
        await store.save({ id: 'x', name: 'My RSI', script: SCRIPT });
        const entry = (await store.toExternalIndicatorEntry('x'))!;
        const engine = new PineEngine();
        const prepared = await engine.prepare(entry.script, 'custom-1');
        expect(prepared.meta.title).toContain('My RSI');
    });
});

describe('id minting robustness', () => {
    it('a constant idFactory cannot collide or loop', async () => {
        const store = new CustomIndicatorStore({ idFactory: () => 'same' });
        const a = await store.save({ name: 'a', script: SCRIPT });
        const b = await store.save({ name: 'b', script: SCRIPT });
        expect(a.id).toBe('same');
        expect(b.id).toBe('same-2');
        expect((await store.list()).length).toBe(2);
    });
});
