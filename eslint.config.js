import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'node_modules/', '.scratchpad/'] },
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ['eslint.config.js'] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
    {
        // Config files + playground run under looser rules (top-level side effects are their job).
        files: ['*.config.ts', '*.config.js', 'playground/**'],
        rules: {
            '@typescript-eslint/no-floating-promises': 'off',
        },
    },
    {
        // The engine's raw material is UNTYPED by contract: a PineTS run hands back
        // `unknown`-shaped plots/ids/messages (see src/pinets/PineRun.ts — asString/asNumber
        // are the typed paths), and the engines implement async host interfaces whose fakes
        // and adapters have nothing to await. These three rules fight that contract, not
        // defects; everything else stays strict.
        files: ['src/pinets/**', 'src/pinets-worker/**', 'test/**'],
        rules: {
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/require-await': 'off',
        },
    },
);
