import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (!process.argv[2]) throw Error('请提供已构建的片场源码目录');
const host = path.resolve(process.argv[2]);
const run = spawnSync(process.execPath, [path.join(host, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'scripts/desktop.config.mjs'], {
  stdio: 'inherit', env: { ...process.env, ONSET_XHS_HOST: host },
});
process.exitCode = run.status ?? 1;
