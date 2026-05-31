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
    setupFiles: ['test/property/setup.ts'],
    // Enforce single-worker / no file parallelism here too, not only in the npm
    // scripts. Several suites bind fixed resources (e.g. the OAuth callback on
    // port 1455) and collide under parallel files when vitest is run directly
    // (tests-ci-03).
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
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

