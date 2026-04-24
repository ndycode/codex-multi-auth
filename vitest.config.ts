import { defineConfig } from 'vitest/config';

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
        if (!id.includes('/scripts/') && !id.includes('\\scripts\\')) return null;
        if (!code.startsWith('#!')) return null;
        return code.replace(/^#!.*(?:\r?\n|$)/, '');
      },
    },
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
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

