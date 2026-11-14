import path from 'node:path';
import { AccountStore, withAccountLock, type Account } from './accounts';
import { openBrowser, validateBridge, type BrowserBridge } from './browser';
import { Page } from './cdp';
import { readDraft } from './draft';
import { writeProjectJSON } from './files';
import { preparePage, type Progress } from './prepare';

export interface Request {
  project_root: string; data_dir: string; browser?: BrowserBridge;
  params: Record<string, unknown>; settings: Record<string, unknown>;
}
export interface Result { status: string; message: string; account?: Account; warnings?: string[]; video_sha256?: string }
const operations = ['accounts', 'add_account', 'rename_account', 'open_account', 'prepare'];
const defaults = { open: openBrowser, page: Page.create, draft: readDraft, prepare: preparePage };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('插件输入必须是 JSON 对象');
  return value as Record<string, unknown>;
}
function parameter(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw Error(`${label}无效`);
  return value;
}
export function validateRequest(raw: unknown): Request {
  const r = object(raw);
  for (const key of ['project_root', 'data_dir']) if (typeof r[key] !== 'string' || !path.isAbsolute(r[key] as string)) throw Error(`${key} 需要绝对路径`);
  const params = object(r.params ?? {}), settings = object(r.settings ?? {});
  for (const key of Object.keys(params)) if (!['account', 'name', 'request_id'].includes(key)) throw Error(`不支持参数 ${key}；插件不会自动发布`);
  for (const value of Object.values(params)) if (typeof value !== 'string' || value.length > 500) throw Error('参数需要字符串');
  const browser = r.browser === undefined ? undefined : validateBridge(r.browser);
  return { project_root: r.project_root as string, data_dir: r.data_dir as string, params, settings, browser };
}

export async function runOperation(operation: string, raw: unknown, progress: Progress = () => {}, deps = defaults): Promise<Result> {
  const request = validateRequest(raw);
  if (!operations.includes(operation)) throw Error('不支持这个操作；插件只上传填表，不提交发布');
  const { project_root: root, params } = request;
  const store = new AccountStore(request.data_dir);
  let account: Account | undefined;
  const snapshot = () => writeProjectJSON(root, 'production/xiaohongshu/accounts.json', { accounts: store.list() });
  const update = (result: Result) => {
    writeProjectJSON(root, 'production/xiaohongshu/latest.json', { ...result, operation, request_id: params.request_id ?? '', updated_at: new Date().toISOString() });
    if (operation === 'prepare') writeProjectJSON(root, 'production/xiaohongshu/state.json', { ...result, updated_at: new Date().toISOString() });
  };
  try {
    update({ status: 'running', message: '正在准备…' });
    if (operation === 'accounts') {
      snapshot(); const result = { status: 'accounts_loaded', message: '账号列表已刷新' }; update(result); return result;
    }
    if (operation === 'add_account') account = store.add(parameter(params.name, '账号名称'));
    else account = store.get(parameter(params.account, '账号'));
    if (operation === 'rename_account') {
      account = store.rename(account.id, parameter(params.name, '账号名称')); snapshot();
      const result = { status: 'renamed', message: '账号名称已更新，登录状态保留', account }; update(result); return result;
    }
    snapshot();
    const result = await withAccountLock(store.profile(account.id), async (): Promise<Result> => {
      const draft = operation === 'prepare' ? await deps.draft(root) : null;
      progress(0.05, `正在打开「${account!.name}」的小红书窗口`);
      const browser = await deps.open(store.profile(account!.id), { bridge: request.browser, account: account!.id, label: account!.name });
      try {
        const page = await deps.page(browser);
        if (draft || !browser.reused) await page.navigate(page.origin + (draft ? '/publish/publish?from=menu&target=video' : '/'));
        if (!draft) return { status: 'browser_opened', message: `已打开「${account!.name}」，请在片场内登录或查看账号`, account };
        const warnings = await deps.prepare(page, draft, (fraction, message) => {
          progress(fraction, message); update({ status: 'running', message, account });
        });
        await page.raw('Page.bringToFront');
        return { status: 'ready_to_publish', message: '内容已填好，请在小红书页面核对账号、封面和文案，再手动发布', account, warnings, video_sha256: draft.videoHash };
      } finally { browser.disconnect(); }
    });
    update(result); return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败';
    update({ status: 'error', message, account });
    throw err;
  }
}
