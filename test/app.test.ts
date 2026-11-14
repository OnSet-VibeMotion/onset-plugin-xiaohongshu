import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOperation, validateRequest } from '../src/app';
import { AccountStore } from '../src/accounts';
import type { BrowserConnection, Page } from '../src/cdp';
import type { preparePage } from '../src/prepare';

const roots: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-xhs-app-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const request = { project_root: temp(), data_dir: temp(), params: {} as Record<string, unknown>, settings: {}, browser: { endpoint: 'http://127.0.0.1:3210/', token: 'a'.repeat(64) } };
  const account = new AccountStore(request.data_dir).add('工作号');
  const disconnect = vi.fn(), navigate = vi.fn();
  const prepare = vi.fn<typeof preparePage>(async () => []);
  const deps = {
    open: vi.fn(async () => ({ disconnect }) as unknown as BrowserConnection),
    page: vi.fn(async () => ({ navigate, raw: vi.fn(), origin: 'https://creator.xiaohongshu.com' }) as unknown as Page),
    draft: vi.fn(async () => ({ title: '标题', content: '正文', tags: [], video: '/movie.mp4', cover: '/cover.png', videoHash: 'abc' })),
    prepare,
  };
  return { request, account, deps, disconnect, navigate };
}
it('只刷新账号时不打开浏览器，项目里没有 cookie 或 profile 路径', async () => {
  const { request, deps } = setup();
  await runOperation('accounts', request, () => {}, deps);
  expect(deps.open).not.toHaveBeenCalled();
  const snapshot = JSON.parse(fs.readFileSync(path.join(request.project_root, 'production/xiaohongshu/accounts.json'), 'utf8'));
  expect(snapshot.accounts).toHaveLength(1);
  expect(Object.keys(snapshot.accounts[0])).toEqual(['id', 'name', 'created_at']);
});
it('上传操作最后交给用户，断开自动化连接而保留浏览器', async () => {
  const { request, account, deps, disconnect } = setup();
  request.params = { account: account.id, request_id: 'test-prepare' };
  deps.prepare.mockImplementationOnce(async (_page, _draft, onProgress) => { onProgress(0.5, '正在上传'); return []; });
  const result = await runOperation('prepare', request, () => {}, deps);
  expect(result.status).toBe('ready_to_publish'); expect(disconnect).toHaveBeenCalledOnce();
  expect(deps.prepare).toHaveBeenCalledOnce();
  const state = JSON.parse(fs.readFileSync(path.join(request.project_root, 'production/xiaohongshu/state.json'), 'utf8'));
  expect(state.status).toBe('ready_to_publish'); expect(state.account.id).toBe(account.id);
  expect(state.video_sha256).toBe('abc');
});
it('封面等操作失败时保留窗口并写失败状态，不冒充已填写', async () => {
  const { request, account, deps, disconnect } = setup(); request.params = { account: account.id };
  deps.prepare.mockRejectedValueOnce(Error('封面失败'));
  await expect(runOperation('prepare', request, () => {}, deps)).rejects.toThrow('封面失败');
  expect(disconnect).toHaveBeenCalledOnce();
  expect(JSON.parse(fs.readFileSync(path.join(request.project_root, 'production/xiaohongshu/state.json'), 'utf8')).status).toBe('error');
});
it('先校验素材，再开浏览器，错误时不会上传', async () => {
  const { request, account, deps } = setup(); request.params = { account: account.id };
  deps.draft.mockRejectedValueOnce(Error('成片已变动'));
  await expect(runOperation('prepare', request, () => {}, deps)).rejects.toThrow('成片已变动');
  expect(deps.open).not.toHaveBeenCalled();
});
it('添加账号打开登录页，重命名不重新打开浏览器', async () => {
  const { request, deps, navigate } = setup(); request.params = { name: '个人号' };
  const created = await runOperation('add_account', request, () => {}, deps);
  expect(navigate).toHaveBeenCalledWith('https://creator.xiaohongshu.com/');
  request.params = { account: created.account!.id, name: '生活号' };
  await runOperation('rename_account', request, () => {}, deps);
  expect(deps.open).toHaveBeenCalledOnce();
});
it('打开指定账号，只打开页面，不读取项目视频', async () => {
  const { request, account, deps } = setup(); request.params = { account: account.id };
  await runOperation('open_account', request, () => {}, deps);
  expect(deps.draft).not.toHaveBeenCalled(); expect(deps.prepare).not.toHaveBeenCalled();
});
it('拒绝不合法协议输入、未知操作和自动发布要求', async () => {
  for (const input of [null, [], {}, { project_root: '../bad', data_dir: '/tmp' },
    { project_root: '/tmp', data_dir: '/tmp', params: { auto_publish: true } },
    { project_root: '/tmp', data_dir: '/tmp', params: { account: 3 } },
    { project_root: '/tmp', data_dir: '/tmp', browser: { endpoint: 'https://remote.example/', token: 'secret' } },
  ]) expect(() => validateRequest(input)).toThrow();
  const { request, deps } = setup();
  await expect(runOperation('publish', request, () => {}, deps)).rejects.toThrow('操作');
  expect(deps.open).not.toHaveBeenCalled();
});

it('重新打开账号保留用户修改过的页面，不跳回首页', async () => {
  const { request, account, deps, navigate } = setup();
  request.params = { account: account.id };
  deps.open.mockResolvedValueOnce({ disconnect: vi.fn(), reused: true } as unknown as BrowserConnection);
  await runOperation('open_account', request, () => {}, deps);
  expect(navigate).not.toHaveBeenCalled();
});
it('旧客户端缺内嵌页面连接时明确报错，不启动外部浏览器', async () => {
  const { request, account } = setup();
  request.params = { account: account.id };
  await expect(runOperation('open_account', { ...request, browser: undefined })).rejects.toThrow(/更新片场/);
});
