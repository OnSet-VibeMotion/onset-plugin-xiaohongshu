import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/**/*.browser.test.ts'], testTimeout: process.env.CI ? 60_000 : 30_000, hookTimeout: 30_000,
} });
