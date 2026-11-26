// The PineTS engine addon for Vela: Pine Script execution through Vela's public
// `ScriptingEngine` port — in-process (`PineEngine`) or off the main thread
// (`PineWorkerEngine`, its worker source inlined at build time). A host registers
// one per chart: `chart.registerEngine('pine', new PineEngine())`, or the widget's
// `engines: { pine: () => new PineWorkerEngine() }`.
export { PineEngine } from './pinets/PineEngine';
export type { PineEngineOptions } from './pinets/PineEngine';
export type { PropsVisibility, PropsFilter } from './pinets/runtime';
// The `importResolver` option of both engines: where `import user/library/version` sources come from.
export type { PineLibraryResolver, PineLibraryImport } from './pinets/runtime';
// The host-facing order-flow seam behind Pine's `request.footprint()` (both engines'
// `footprints` option): the shapes PineTS consumes, declared here so hosts type
// against this package alone.
export type { FootprintSource, FootprintBar, FootprintLevel, FootprintRange } from './pinets/footprints';
export { PineWorkerEngine } from './pinets-worker/PineWorkerEngine';
export type { PineWorkerOptions } from './pinets-worker/PineWorkerEngine';
// Saving your own indicators: a library of named Pine scripts with pluggable
// persistence (in-memory, localStorage, or any CustomIndicatorStorage), turned back
// into chart additions (`toExternalIndicatorEntry` / `addToChart`).
export { CustomIndicatorStore, CustomIndicatorError, memoryIndicatorStorage, localStorageIndicatorStorage, sanitizeCustomIndicator, externalIndicatorEntryFrom } from './indicators/CustomIndicatorStore';
export { DEFAULT_CUSTOM_INDICATOR_LANGUAGE, DEFAULT_CUSTOM_INDICATOR_STORAGE_KEY, CUSTOM_INDICATOR_STORAGE_VERSION } from './indicators/CustomIndicatorStore';
export type {
    CustomIndicator,
    CustomIndicatorInput,
    CustomIndicatorPatch,
    CustomIndicatorStorage,
    CustomIndicatorStoreOptions,
    CustomIndicatorListener,
    StorageLike,
    MaybePromise,
    AddCustomIndicatorOptions,
    ChartAddIndicatorLike,
} from './indicators/CustomIndicatorStore';
