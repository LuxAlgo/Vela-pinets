// The PineTS engine addon for Vela: Pine Script execution through Vela's public
// `ScriptingEngine` port — in-process (`PineEngine`) or off the main thread
// (`PineWorkerEngine`, its worker source inlined at build time). A host registers
// one per chart: `chart.registerEngine('pine', new PineEngine())`, or the widget's
// `engines: { pine: () => new PineWorkerEngine() }`.
export { PineEngine } from './pinets/PineEngine';
export type { PineEngineOptions } from './pinets/PineEngine';
export type { PropsVisibility, PropsFilter } from './pinets/runtime';
// The host-facing order-flow seam behind Pine's `request.footprint()` (both engines'
// `footprints` option): the shapes PineTS consumes, declared here so hosts type
// against this package alone.
export type { FootprintSource, FootprintBar, FootprintLevel, FootprintRange } from './pinets/footprints';
export { PineWorkerEngine } from './pinets-worker/PineWorkerEngine';
export type { PineWorkerOptions } from './pinets-worker/PineWorkerEngine';
