import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@lo/state/stream': fileURLToPath(new URL('./packages/state/src/stream.ts', import.meta.url)),
      ...Object.fromEntries(
        ['state', 'policy', 'adapters', 'evals'].map(name => [
          `@lo/${name}`,
          fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url)),
        ]),
      ),
    },
  },
  test: {
    // Native integration suites share one PostgreSQL server. Bound parallel
    // database creation/teardown without relaxing test or hook time budgets.
    maxWorkers: 2,
    include: ['packages/**/*.test.{ts,tsx}', 'apps/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/tests/ui/**'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/runtime/src/**/*.ts', 'apps/voice/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts', '**/fixtures/**'],
      thresholds: {
        lines: 80,
        'apps/runtime/src/**': { lines: 80 },
        'apps/voice/src/**': { lines: 80 },
        'apps/web/src/**': { lines: 80 },
        'packages/adapters/src/**': { lines: 80 },
        'packages/evals/src/**': { lines: 80 },
        'packages/policy/src/**': { lines: 90 },
        'packages/state/src/**': { lines: 90 },
      },
    },
  },
});
