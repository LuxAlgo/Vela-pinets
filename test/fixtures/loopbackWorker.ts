import type { WorkerLike } from '../../src/pinets-worker/protocol';

type Listener = (event: { data: unknown }) => void;

/**
 * The REAL worker module (`src/pinets-worker/worker.ts`) run in this thread behind a
 * loopback: messages are structured-cloned both ways, as across a real worker boundary, so
 * a `PineWorkerEngine({ createWorker: () => worker })` executes through the worker module and
 * the protocol exactly as in a browser.
 *
 * The worker module binds its global scope once, at import, and test files run in their own
 * module graphs: load it once per test file (in `beforeAll`) and drive it with ONE engine,
 * since every engine on the loopback hears every reply. `restore()` puts the global back.
 */
export async function loadLoopbackWorker(): Promise<{ worker: WorkerLike; restore(): void }> {
    const toWorker: Listener[] = [];
    const toMain: Listener[] = [];
    const g = globalThis as { self?: unknown };
    const hadSelf = 'self' in g;
    const previousSelf = g.self;
    g.self = {
        postMessage: (message: unknown) => queueMicrotask(() => toMain.forEach((l) => l({ data: structuredClone(message) }))),
        addEventListener: (_type: 'message', listener: Listener) => void toWorker.push(listener),
    };
    await import('../../src/pinets-worker/worker');
    const worker: WorkerLike = {
        postMessage: (message) => queueMicrotask(() => toWorker.forEach((l) => l({ data: structuredClone(message) }))),
        addEventListener: (_type, listener) => void toMain.push(listener),
        terminate: () => {},
    };
    return {
        worker,
        restore: () => {
            if (hadSelf) g.self = previousSelf;
            else delete g.self;
        },
    };
}
