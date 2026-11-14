import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000,
  // page-scripts executes in Chromium and is covered by real-browser tests, outside Node V8's counters.
  coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/entry.ts', 'src/page-scripts.ts'],
    thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 } },
} });
