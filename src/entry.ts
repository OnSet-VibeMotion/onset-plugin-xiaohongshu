import { runOperation, validateRequest, type Request } from './app';
import { writeProjectJSON } from './files';

let request: Request | undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (request) {
    const result = { status: 'interrupted', message: '操作已取消，小红书窗口仍保留，请自行检查', request_id: request.params.request_id ?? '' };
    try {
      writeProjectJSON(request.project_root, 'production/xiaohongshu/latest.json', result);
      if (process.argv[2] === 'prepare') writeProjectJSON(request.project_root, 'production/xiaohongshu/state.json', result);
    } catch {}
  }
  process.exit(130);
});

async function main(): Promise<void> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 262_144) throw Error('插件输入过大');
    chunks.push(Buffer.from(chunk));
  }
  request = validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const result = await runOperation(process.argv[2] ?? '', request, (fraction, message) => {
    process.stdout.write(`onset-progress ${fraction.toFixed(2)} ${message.replace(/[\r\n]/g, ' ')}\n`);
  });
  process.stdout.write(`onset-result ${JSON.stringify(result)}\n`);
}
main().catch(err => { process.stderr.write(`${err instanceof Error ? err.message : '操作失败'}\n`); process.exitCode = 1; });
