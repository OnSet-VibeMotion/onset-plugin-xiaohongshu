import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.env.ONSET_XHS_HOST, 'package.json'));
const { defineConfig } = require('@playwright/test');
export default defineConfig({ testDir: '../test', testMatch: 'desktop.spec.mjs', workers: 1, timeout: 60_000, reporter: 'list' });
