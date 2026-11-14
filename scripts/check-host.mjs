import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

if (!process.argv[2]) throw Error('请提供片场源码目录');
const host = path.resolve(process.argv[2]), plugin = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-plugin-contract-'));
try {
  const output = path.join(tmp, 'check.cjs');
  await build({ stdin: { contents: `
    import fs from 'node:fs';
    import { parseManifest } from ${JSON.stringify(path.join(host, 'packages/engine/src/flow/parse.ts'))};
    import { checkFiles } from ${JSON.stringify(path.join(host, 'packages/engine/src/flow/fetch.ts'))};
    import { recordInstalled, roleOf } from ${JSON.stringify(path.join(host, 'packages/engine/src/flow/installed.ts'))};
    import { runStationOp } from ${JSON.stringify(path.join(host, 'packages/engine/src/flow/run.ts'))};
    import { setHostVersion } from ${JSON.stringify(path.join(host, 'packages/engine/src/version/index.ts'))};
    setHostVersion(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(host, 'apps/desktop/package.json'))}, 'utf8')).version);
    const root = ${JSON.stringify(plugin)};
    const manifest = parseManifest(fs.readFileSync(root + '/onset-station.json', 'utf8'));
    checkFiles(root, manifest);
    if (manifest.ops.some(op => op.trigger !== 'user')) throw Error('操作必须由用户触发');
    const scratch = ${JSON.stringify(tmp)};
    fs.mkdirSync(scratch + '/project');
    recordInstalled(scratch + '/stations', { id: manifest.id, version: manifest.version,
      source: 'link:' + root, commit: '', digest: '', role: roleOf(manifest) });
    runStationOp(scratch + '/project', manifest.id, 'accounts', {}, () => {}, undefined,
      { ...process.env, ONSET_STATIONS_DIR: scratch + '/stations' }).then(result => {
      if (!result.ok || result.out_of_scope?.length || result.data?.status !== 'accounts_loaded') throw Error(JSON.stringify(result));
      console.log('片场插件契约与子进程调用通过：' + manifest.id);
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `, resolveDir: host }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: output, loader: { '.tmpl': 'text' }, logLevel: 'silent' });
  const result = spawnSync(process.execPath, [output], { env: { ...process.env, ONSET_ASSETS_DIR: path.join(host, 'assets') }, stdio: 'inherit' });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
