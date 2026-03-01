import { defineConfig } from 'vitest/config';

export default defineConfig({
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
        'lib/codex-manager/settings-hub.ts',
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

