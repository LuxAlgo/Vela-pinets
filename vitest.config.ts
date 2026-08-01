import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Stub the build-time-inlined worker source (`inline-worker:*`) — tests drive
    // PineWorkerEngine with a fake worker, so the real bundled string isn't needed.
    // Production inlining is done by the tsup/vite `inline-worker` plugins.
    plugins: [
        {
            name: 'inline-worker-stub',
            resolveId(id: string) {
                return id.startsWith('inline-worker:') ? '\0inline-worker-stub' : undefined;
            },
            load(id: string) {
                return id === '\0inline-worker-stub' ? 'export default "";' : undefined;
            },
        },
    ],
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
