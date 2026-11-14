import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { openBrowser, validateBridge } from '../src/browser';
import { Page } from '../src/cdp';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
it('经客户端连接控制已有页面，不申请外部标签页；断开后不能继续填表', async () => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer ' + 'a'.repeat(64));
    let text = ''; for await (const c of req) text += c;
    const body = JSON.parse(text); calls.push(body);
    res.setHeader('content-type', 'application/json');
    if (body.method === 'Unsupported') { res.writeHead(400); res.end(JSON.stringify({ error: '不支持' })); }
    else res.end(JSON.stringify(body.action === 'open' ? { reused: true } : {}));
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const bridge = { endpoint: `http://127.0.0.1:${(server.address() as any).port}/`, token: 'a'.repeat(64) };
  const browser = await openBrowser('/unused', { bridge, account: 'account-a', label: '工作号' });
  expect(browser.reused).toBe(true);
  const page = await Page.create(browser);
  await page.navigate('https://creator.xiaohongshu.com/publish/publish');
  expect(calls.map(c => c.action === 'open' ? 'open' : c.method)).toEqual(['open', 'Page.enable', 'Page.bringToFront', 'Page.navigate']);
  await expect(browser.send('Unsupported')).rejects.toThrow('不支持');
  browser.disconnect();
  await expect(page.raw('Input.insertText', { text: 'should not run' })).rejects.toThrow('已结束');
});
it('拒绝缺失、远端、带路径或格式不合法的客户端连接', async () => {
  for (const value of [null, {}, { endpoint: 'http://127.0.0.1:1234/', token: 'bad' },
    ...['https://example.com/', 'http://localhost:1234/', 'http://127.0.0.1:1234/other', 'http://user@127.0.0.1:1234/', 'http://127.0.0.1:1234/?token=x'].map(endpoint => ({ endpoint, token: 'a'.repeat(64) })),
  ]) expect(() => validateBridge(value)).toThrow();
  await expect(openBrowser('/unused', { account: 'a', label: '工作号' })).rejects.toThrow('更新片场');
});
