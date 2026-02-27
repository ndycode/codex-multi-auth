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
      'tmp/**',
      '**/node_modules/**',
      '**/.codex/**',
      '**/dist/**',
      '**/tmp/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
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

