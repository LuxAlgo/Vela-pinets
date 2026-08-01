import { defineConfig } from 'tsup';
import * as esbuild from 'esbuild';
import { resolve } from 'node:path';

/**
 * Inlines a worker entry as a string — the same mechanism as Vela's own build.
 * `import code from 'inline-worker:./worker.ts'` bundles that entry into a
 * self-contained IIFE at build time and yields its source as a default-exported
 * string; `PineWorkerEngine` spawns it from a Blob URL at runtime — no separate
 * file, no URL to configure. The nested build sets no `external`, so the worker
 * carries its own pinets AND the few `@luxalgo/vela/plugin` values it uses
 * (series identity, palette): a worker is a separate execution context with no
 * module graph to share.
 */
const inlineWorker = (): esbuild.Plugin => ({
    name: 'inline-worker',
    setup(build) {
        const PREFIX = 'inline-worker:';
        build.onResolve({ filter: /^inline-worker:/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.slice(PREFIX.length)),
            namespace: 'inline-worker',
        }));
        build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (args) => {
            const out = await esbuild.build({
                entryPoints: [args.path],
                bundle: true,
                write: false,
                format: 'iife',
                platform: 'browser',
                minify: true,
                sourcemap: false,
                target: 'es2020',
            });
            return { contents: `export default ${JSON.stringify(out.outputFiles?.[0]?.text ?? '')};`, loader: 'js', watchFiles: [args.path] };
        });
    },
});

/**
 * Maps `@luxalgo/vela*` imports onto the page global for the IIFE builds: the addon
 * script loads NEXT TO `vela.global.js` and shares its one Vela instance — bundling a
 * second Vela would duplicate the SDK registries, not just the bytes.
 */
const velaAsGlobal = (): esbuild.Plugin => ({
    name: 'vela-as-global',
    setup(build) {
        build.onResolve({ filter: /^@luxalgo\/vela(\/|$)/ }, (args) => ({ path: args.path, namespace: 'vela-as-global' }));
        build.onLoad({ filter: /.*/, namespace: 'vela-as-global' }, () => ({ contents: 'module.exports = window.Vela;', loader: 'js' }));
    },
});

export default defineConfig([
    // Library build — ESM + CJS + types; Vela and pinets stay external (the peers).
    {
        name: 'lib',
        entry: { index: 'src/index.ts' },
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: false,
        clean: true,
        treeshake: true,
        external: ['pinets', '@luxalgo/vela', /^@luxalgo\/vela\//],
        esbuildPlugins: [inlineWorker()],
    },
    // Browser globals — `window.VelaPinets`, pinets + the inlined worker bundled, in the
    // same dev/prod pair as Vela: `vela-pinets.global.js` readable, `.global.min.js` for CDN.
    {
        name: 'browser-dev',
        entry: { 'vela-pinets': 'src/browser.ts' },
        format: ['iife'],
        globalName: 'VelaPinets',
        platform: 'browser',
        sourcemap: false,
        clean: false,
        treeshake: true,
        minify: false,
        esbuildPlugins: [inlineWorker(), velaAsGlobal()],
    },
    {
        name: 'browser-min',
        entry: { 'vela-pinets': 'src/browser.ts' },
        format: ['iife'],
        globalName: 'VelaPinets',
        platform: 'browser',
        outExtension: () => ({ js: '.global.min.js' }),
        sourcemap: false,
        clean: false,
        treeshake: true,
        minify: true,
        esbuildPlugins: [inlineWorker(), velaAsGlobal()],
    },
]);
