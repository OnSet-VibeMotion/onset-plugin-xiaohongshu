import { build } from 'esbuild';
await build({ entryPoints: ['src/entry.ts'], bundle: true, platform: 'node', target: 'node22',
  format: 'cjs', outfile: 'dist/plugin.cjs', legalComments: 'eof' });
