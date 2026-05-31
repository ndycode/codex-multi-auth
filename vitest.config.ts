import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const forcePlainTestOutput =
  process.env.CODEX_PLAIN_LOGS === '1' ||
  process.env.NO_COLOR === '1' ||
  process.env.CI === 'true' ||
  process.env.GITHUB_ACTIONS === 'true' ||
  !process.stdout.isTTY;

if (forcePlainTestOutput) {
  process.env.NO_COLOR = '1';
  process.env.FORCE_COLOR = '0';
}

export default defineConfig({
  plugins: [
    {
      name: 'strip-script-shebangs-for-vitest',
      enforce: 'pre',
      transform(code, id) {
        const scriptsRoot = `${resolve(process.cwd(), 'scripts').replace(/\\/g, '/')}/`;
        const normalizedId = id.replace(/\\/g, '/');
        if (!normalizedId.startsWith(scriptsRoot)) return null;
        if (!code.startsWith('#!')) return null;
        return code.replace(/^#!.*(?:\r?\n|$)/, '');
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Wire the property-test global config so fc.configureGlobal (numRuns, time
    // budget) actually applies; it was previously a dead export never imported
    // (tests-ci-02).
    // Global HOME/CODEX_HOME sandbox (tests-ci-01) must load first so any suite
    // that forgets to redirect storage paths resolves into a throwaway temp dir
    // rather than the developer's real ~/.codex. Then the property-test config.
    setupFiles: ['test/helpers/global-sandbox.ts', 'test/property/setup.ts'],
    // tests-ci-03: the fixed-port OAuth callback (1455) collision risk is covered
    // by `--maxWorkers=1` in the npm `test` script plus the awaited port-release in
    // test/oauth-server.integration.test.ts afterEach, so `fileParallelism: false`
    // is not set here (it added no protection beyond those). NOTE: this suite has a
    // pre-existing, environment-level intermittent vitest worker crash on Windows
    // (exit 1 with no test failure and no summary) that reproduces on upstream main
    // too; it is unrelated to fileParallelism. See finding tests-ci-16.
    exclude: [
      'node_modules/**',
      '.codex/**',
      'dist/**',
      'coverage/**',
      '.tmp*/**',
      '.omx/**',
      '.opencode/**',
      '.sisyphus/**',
      '.history/**',
      'tmp/**',
      '**/node_modules/**',
      '**/.codex/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.tmp*/**',
      '**/.omx/**',
      '**/.opencode/**',
      '**/.sisyphus/**',
      '**/.history/**',
      '**/tmp/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
        'eslint.config.js',
        'index.ts',
        'lib/codex-manager.ts',
        'lib/ui/**',
        'lib/tools/**',
        'scripts/**',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});

