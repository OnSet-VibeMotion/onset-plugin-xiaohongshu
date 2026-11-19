import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOperation, validateRequest } from '../src/app';
import { AccountStore, newAccountID } from '../src/accounts';
import type { BrowserConnection, Page } from '../src/cdp';
import { AlreadyPublished, type preparePage } from '../src/prepare';

const roots: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-xhs-app-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const request = { project_root: temp(), data_dir: temp(), params: {} as Record<string, unknown>, settings: {}, browser: { endpoint: 'http://127.0.0.1:3210/', token: 'a'.repeat(64) } };
  const account = new AccountStore(request.data_dir).saveLoggedIn({ id: newAccountID(), name: '工作号', user_id: 'w1' }).account;
  const disconnect = vi.fn(), navigate = vi.fn(), close = vi.fn(async () => {}), forget = vi.fn(async () => ({}));
  const state = vi.fn(async () => ({ open: true, visible: true }));
  const evaluate = vi.fn(async (): Promise<unknown> => null);
  const prepare = vi.fn<typeof preparePage>(async () => []);
  const deps = {
    open: vi.fn(async () => ({ disconnect, state, close }) as unknown as BrowserConnection),
    page: vi.fn(async () => ({ navigate, evaluate, raw: vi.fn(), origin: 'https://creator.xiaohongshu.com' }) as unknown as Page),
    draft: vi.fn(async () => ({ title: '标题', content: '正文', tags: [], video: '/movie.mp4', cover: '/cover.png', videoHash: 'abc' })),
    prepare,
    avatar: vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo='),
    sleep: vi.fn(async () => {}),
    bridge: vi.fn(() => ({ request: vi.fn(), forget, disconnect: vi.fn() })) as unknown as typeof import('../src/browser').connectBridge,
    loginTimeout: 60_000,
  };
  return { request, account, deps, disconnect, navigate, close, forget, state, evaluate };
}
it('账号列表给设置画卡片：头像、昵称、打开与移除；不打开浏览器、不写项目', async () => {
  const { request, deps, account } = setup();
  const listed = await runOperation('accounts', request, () => {}, deps);
  expect(deps.open).not.toHaveBeenCalled();
  expect(listed.items).toEqual([{ title: '工作号', detail: expect.stringMatching(/^登录于 /), actions: [
    { label: '打开', op: 'open_account', params: { account: account.id } },
    { label: '移除', op: 'remove_account', params: { account: account.id }, confirm: '移除「工作号」后要重新登录，确定吗？' },
  ] }]);
  expect(fs.readdirSync(request.project_root)).toEqual([]);
});
it('账号列表也给插件页面（onset.list）：编号、名字与头像，不含登录状态，不写项目', async () => {
  const { request, deps, account } = setup();
  const listed = await runOperation('accounts', request, () => {}, deps) as { accounts?: Record<string, unknown>[] };
  expect(listed.accounts).toEqual([{ id: account.id, name: '工作号', created_at: account.created_at }]);
  expect(fs.readdirSync(request.project_root)).toEqual([]);
});
it('一键登录：打开登录页，等用户登录好，读出昵称与头像记下来，关掉页面回到片场', async () => {
  const { request, deps, evaluate, close, navigate } = setup();
  request.project_root = '';
  evaluate.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ name: '小红薯', avatar: 'https://sns-avatar-qc.xhscdn.com/a.jpg', user_id: 'u9' });
  const result = await runOperation('login', request, () => {}, deps);
  expect(deps.open).toHaveBeenCalledWith('', expect.objectContaining({ label: '登录', hint: '请在下方登录小红书，登录后会自动回到片场' }));
  expect(navigate).toHaveBeenCalledWith('https://creator.xiaohongshu.com/');
  expect(deps.avatar).toHaveBeenCalledWith('https://sns-avatar-qc.xhscdn.com/a.jpg');
  expect(result).toMatchObject({ status: 'logged_in', message: '已登录：小红薯' });
  expect(close).toHaveBeenCalledOnce();
  const store = new AccountStore(request.data_dir);
  // 两个账号可能在同一毫秒加入（按编号排）：不看先后。
  expect(store.list().map(a => [a.name, a.user_id, a.avatar])).toEqual(expect.arrayContaining([['工作号', 'w1', undefined], ['小红薯', 'u9', 'data:image/png;base64,iVBORw0KGgo=']]));
  expect(store.list()).toHaveLength(2);
});
it('同一个账号重新登录：换掉旧的那条', async () => {
  const { request, deps, evaluate } = setup();
  evaluate.mockResolvedValueOnce({ name: '工作号改名', avatar: '', user_id: 'w1' });
  expect((await runOperation('login', request, () => {}, deps)).message).toBe('「工作号改名」重新登录好了');
  expect(new AccountStore(request.data_dir).list().map(a => a.name)).toEqual(['工作号改名']);
  expect(deps.avatar).not.toHaveBeenCalled();
});
it('用户收起登录页或一直不登录：不留半截账号，删掉新开的存储', async () => {
  const { request, deps, state, close, evaluate } = setup();
  state.mockResolvedValueOnce({ open: true, visible: true }).mockResolvedValueOnce({ open: true, visible: false });
  await expect(runOperation('login', request, () => {}, deps)).rejects.toThrow('登录页面关掉了');
  expect(close).toHaveBeenCalledOnce();
  expect(new AccountStore(request.data_dir).list().map(a => a.name)).toEqual(['工作号']);
  expect(fs.readdirSync(path.join(request.data_dir, 'accounts')).filter(n => /^[0-9a-f-]{36}$/.test(n))).toHaveLength(1);
  // 页面还在加载、跳转中读不到也不算失败；超时才放弃。
  evaluate.mockRejectedValue(Error('Execution context was destroyed'));
  await expect(runOperation('login', request, () => {}, { ...deps, loginTimeout: -1 })).rejects.toThrow('十分钟');
});
it('移除账号：先请片场关掉它开着的页面，再删资料与登录状态', async () => {
  const { request, deps, account, forget } = setup();
  fs.mkdirSync(path.join(request.data_dir, 'web-sessions', account.id), { recursive: true });
  request.params = { account: account.id };
  expect((await runOperation('remove_account', request, () => {}, deps)).message).toBe('已移除「工作号」');
  expect(forget).toHaveBeenCalledWith(account.id);
  expect(fs.existsSync(path.join(request.data_dir, 'web-sessions', account.id))).toBe(false);
  expect(new AccountStore(request.data_dir).list()).toEqual([]);
});
it('上传操作最后交给用户，断开自动化连接而保留浏览器', async () => {
  const { request, account, deps, disconnect } = setup();
  request.params = { account: account.id };
  deps.prepare.mockImplementationOnce(async (_page, _draft, onProgress) => { onProgress(0.5, '正在上传'); return []; });
  const result = await runOperation('prepare', request, () => {}, deps);
  expect(result.status).toBe('ready_to_publish'); expect(disconnect).toHaveBeenCalledOnce();
  expect(deps.prepare).toHaveBeenCalledOnce();
  const state = JSON.parse(fs.readFileSync(path.join(request.project_root, 'production/xiaohongshu/state.json'), 'utf8'));
  expect(state.status).toBe('ready_to_publish'); expect(state.account.id).toBe(account.id);
  expect(state.video_sha256).toBe('abc');
});
it('视频交给小红书页面后记下成片摘要，供下次续接', async () => {
  const { request, account, deps } = setup(); request.params = { account: account.id };
  deps.prepare.mockImplementationOnce(async (_page, _draft, _progress, options) => { options?.onUpload?.(); return []; });
  await runOperation('prepare', request, () => {}, deps);
  expect(deps.prepare.mock.calls[0][3]).toMatchObject({ resume: false });
  expect(new AccountStore(request.data_dir).lastUpload(account.id)).toBe('abc');
  expect(fs.existsSync(path.join(request.data_dir, 'accounts', account.id, 'upload.json'))).toBe(true);
  expect(fs.readdirSync(request.project_root)).toEqual(['production']);
});
it('窗口还停在同一个成片的编辑页时接着上次的上传，不跳回上传页', async () => {
  const { request, account, deps, navigate, evaluate, disconnect } = setup(); request.params = { account: account.id };
  new AccountStore(request.data_dir).recordUpload(account.id, 'abc');
  deps.open.mockResolvedValueOnce({ disconnect, reused: true } as unknown as BrowserConnection);
  evaluate.mockResolvedValueOnce(true).mockResolvedValueOnce({ state: 'uploading', text: '上传中 40%', percent: 40 });
  await runOperation('prepare', request, () => {}, deps);
  expect(navigate).not.toHaveBeenCalled();
  expect(deps.prepare.mock.calls[0][3]).toMatchObject({ resume: true });
});
it('插件没记过指纹时，编辑页里视频时长与成片对得上（例如自己从草稿箱打开的）也接着用', async () => {
  for (const [seconds, resumed] of [[531.466667, true], [301.739, false]] as const) {
    const { request, account, deps, navigate, evaluate, disconnect } = setup(); request.params = { account: account.id };
    deps.draft.mockResolvedValueOnce({ title: '标题', content: '正文', tags: [], video: '/movie.mp4', cover: '', videoHash: 'abc', videoDuration: 531_467 } as never);
    deps.open.mockResolvedValueOnce({ disconnect, reused: true } as unknown as BrowserConnection);
    evaluate.mockResolvedValueOnce(true).mockResolvedValueOnce({ state: 'ready', text: '上传成功', percent: null }).mockResolvedValueOnce(seconds);
    await runOperation('prepare', request, () => {}, deps);
    expect(navigate).toHaveBeenCalledTimes(resumed ? 0 : 1);
    expect(deps.prepare.mock.calls[0][3]).toMatchObject({ resume: resumed });
  }
});
it('换了成片或页面已离开编辑页时回到上传页重新上传', async () => {
  for (const [recorded, editor] of [['old', true], ['abc', false]] as const) {
    const { request, account, deps, navigate, evaluate, disconnect } = setup(); request.params = { account: account.id };
    new AccountStore(request.data_dir).recordUpload(account.id, recorded);
    deps.open.mockResolvedValueOnce({ disconnect, reused: true } as unknown as BrowserConnection);
    evaluate.mockResolvedValueOnce(editor).mockResolvedValueOnce({ state: 'ready', text: '重新上传', percent: null });
    await runOperation('prepare', request, () => {}, deps);
    expect(navigate).toHaveBeenCalledWith('https://creator.xiaohongshu.com/publish/publish?from=menu&target=video');
    expect(deps.prepare.mock.calls[0][3]).toMatchObject({ resume: false });
  }
});
it('视频交给小红书后才盖遮罩显示进度，登录与找上传入口时不盖；做完或失败都揭开', async () => {
  for (const fail of [false, true]) {
    const { request, account, deps, disconnect } = setup(); request.params = { account: account.id };
    const busy = vi.fn(async () => {}), idle = vi.fn(async () => {});
    deps.open.mockResolvedValueOnce({ disconnect, busy, idle } as unknown as BrowserConnection);
    deps.prepare.mockImplementationOnce(async (_page, _draft, onProgress, options) => {
      onProgress(0.1, '请在打开的小红书窗口完成登录');
      expect(busy).not.toHaveBeenCalled();
      options?.onUpload?.();
      onProgress(0.4, '正在上传视频 57%，请保留小红书窗口');
      if (fail) throw Error('小红书显示视频上传或处理失败');
      return [];
    });
    const run = runOperation('prepare', request, () => {}, deps);
    if (fail) await expect(run).rejects.toThrow('上传或处理失败'); else await run;
    expect(busy.mock.calls).toEqual([['正在上传视频', 0.2], ['正在上传视频 57%，请保留小红书窗口', 0.4]]);
    expect(idle).toHaveBeenCalledOnce();
  }
});
it('小红书弹出验证时揭开遮罩交给用户，验证期间的进度不再盖上，验证完按最近的进度重新盖上', async () => {
  const { request, account, deps, disconnect } = setup(); request.params = { account: account.id };
  const calls: unknown[] = [];
  const busy = vi.fn(async (...args: unknown[]) => { calls.push(['busy', ...args]); }), idle = vi.fn(async () => { calls.push('idle'); });
  deps.open.mockResolvedValueOnce({ disconnect, busy, idle } as unknown as BrowserConnection);
  deps.prepare.mockImplementationOnce(async (_page, _draft, onProgress, options) => {
    options?.onUpload?.();
    onProgress(0.3, '正在上传视频 29%，请保留小红书窗口');
    options?.onPause?.();
    onProgress(0.3, '小红书要求验证：请在小红书窗口完成验证，完成后自动继续');
    options?.onResume?.();
    onProgress(0.55, '正在填写标题、正文和话题');
    return [];
  });
  await runOperation('prepare', request, () => {}, deps);
  expect(calls).toEqual([
    ['busy', '正在上传视频', 0.2],
    ['busy', '正在上传视频 29%，请保留小红书窗口', 0.3],
    'idle',
    ['busy', '正在上传视频 29%，请保留小红书窗口', 0.3],
    ['busy', '正在填写标题、正文和话题', 0.55],
    'idle',
  ]);
});
it('续接上次的上传时一开始就盖遮罩；旧片场不认遮罩命令时照常完成', async () => {
  const { request, account, deps, evaluate, disconnect } = setup(); request.params = { account: account.id };
  new AccountStore(request.data_dir).recordUpload(account.id, 'abc');
  const busy = vi.fn(async () => { throw Error('网页操作无效'); }), idle = vi.fn(async () => { throw Error('网页操作无效'); });
  deps.open.mockResolvedValueOnce({ disconnect, reused: true, busy, idle } as unknown as BrowserConnection);
  evaluate.mockResolvedValueOnce(true).mockResolvedValueOnce({ state: 'uploading', text: '上传中', percent: null });
  await expect(runOperation('prepare', request, () => {}, deps)).resolves.toMatchObject({ status: 'ready_to_publish' });
  expect(busy).toHaveBeenCalledWith('接着上次的上传', 0.2);
  expect(idle).toHaveBeenCalledOnce();
});
it('成片已经发过时不算失败，状态写成 already_published；「仍然上传」带 again', async () => {
  const { request, account, deps } = setup(); request.params = { account: account.id };
  deps.prepare.mockRejectedValueOnce(new AlreadyPublished({ title: '标题', type: 'video', duration: 1000, time: '2026-11-18 15:44', reviewing: false }));
  const result = await runOperation('prepare', request, () => {}, deps);
  expect(result).toMatchObject({ status: 'already_published', message: expect.stringContaining('2026-11-18 15:44 已经发到这个小红书账号了') });
  expect(JSON.parse(fs.readFileSync(path.join(request.project_root, 'production/xiaohongshu/state.json'), 'utf8')).status).toBe('already_published');
  expect(deps.prepare.mock.calls[0][3]).toMatchObject({ again: false });
  request.params = { account: account.id, again: '1' };
  await runOperation('prepare', request, () => {}, deps);
  expect(deps.prepare.mock.calls[1][3]).toMatchObject({ again: true });
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
it('没打开项目时账号操作不写任何项目；上传仍要项目', async () => {
  const { request, deps, account } = setup();
  const project = request.project_root;
  request.project_root = '';
  request.params = { account: account.id };
  await runOperation('open_account', request, () => {}, deps);
  await expect(runOperation('prepare', request, () => {}, deps)).rejects.toThrow('要在项目里进行');
  expect(fs.readdirSync(project)).toEqual([]);
  expect(deps.draft).not.toHaveBeenCalled();
});
it('打开指定账号，只打开页面，不读取项目视频', async () => {
  const { request, account, deps } = setup(); request.params = { account: account.id };
  await runOperation('open_account', request, () => {}, deps);
  expect(deps.draft).not.toHaveBeenCalled(); expect(deps.prepare).not.toHaveBeenCalled();
});
it('拒绝不合法协议输入、未知操作和自动发布要求', async () => {
  for (const input of [null, [], {}, { project_root: '../bad', data_dir: '/tmp' },
    { project_root: '/tmp', data_dir: '/tmp', params: { auto_publish: true } },
    { project_root: '/tmp', data_dir: '/tmp', params: { name: '手填的备注' } },
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
