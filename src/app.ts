import path from 'node:path';
import { AccountStore, MaxAvatarChars, newAccountID, withAccountLock, type Account } from './accounts';
import { connectBridge, openBrowser, validateBridge, type BrowserBridge } from './browser';
import { delay, Page } from './cdp';
import * as scripts from './page-scripts';
import { readDraft } from './draft';
import { writeProjectJSON } from './files';
import { AlreadyPublished, canResume, editorHoldsFilm, preparePage, type Progress } from './prepare';

export interface Request {
  /** 空字符串：没打开项目时从片场设置里点的账号操作，不往项目里写任何东西。 */
  project_root: string; data_dir: string; browser?: BrowserBridge;
  params: Record<string, unknown>; settings: Record<string, unknown>;
}
export interface Result { status: string; message: string; account?: Account; warnings?: string[]; video_sha256?: string; items?: unknown[]; accounts?: unknown[] }
const operations = ['accounts', 'login', 'open_account', 'remove_account', 'prepare'];
/** 小红书 CDN 上的头像：插件进程取回来存成 data URL，片场与插件页面都只认这种图片。 */
async function fetchAvatar(raw: string): Promise<string> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !/(^|\.)(xhscdn\.com|xiaohongshu\.com)$/.test(url.hostname)) return '';
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return '';
  const bytes = Buffer.from(await response.arrayBuffer());
  const dataURL = `data:${type};base64,${bytes.toString('base64')}`;
  return dataURL.length <= MaxAvatarChars ? dataURL : '';
}
const defaults = { open: openBrowser, page: Page.create, draft: readDraft, prepare: preparePage, avatar: fetchAvatar, sleep: delay, bridge: connectBridge, loginTimeout: 10 * 60_000 };
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
  if (typeof r.data_dir !== 'string' || !path.isAbsolute(r.data_dir)) throw Error('data_dir 需要绝对路径');
  if (typeof r.project_root !== 'string' || (r.project_root !== '' && !path.isAbsolute(r.project_root))) throw Error('project_root 需要绝对路径');
  const params = object(r.params ?? {}), settings = object(r.settings ?? {});
  for (const key of Object.keys(params)) if (!['account', 'again'].includes(key)) throw Error(`不支持参数 ${key}；插件不会自动发布`);
  for (const value of Object.values(params)) if (typeof value !== 'string' || value.length > 500) throw Error('参数需要字符串');
  const browser = r.browser === undefined ? undefined : validateBridge(r.browser);
  return { project_root: r.project_root, data_dir: r.data_dir, params, settings, browser };
}

/** 设置里的账号卡片：头像、昵称、「打开」「移除」。 */
function accountItems(accounts: Account[]): unknown[] {
  return accounts.map(a => ({
    title: a.name,
    detail: `登录于 ${a.created_at.slice(0, 10)}`,
    ...(a.avatar ? { image: a.avatar } : {}),
    actions: [
      { label: '打开', op: 'open_account', params: { account: a.id } },
      { label: '移除', op: 'remove_account', params: { account: a.id }, confirm: `移除「${a.name}」后要重新登录，确定吗？` },
    ],
  }));
}
/** 给插件页面（onset.list）的账号：编号、名字与头像，不含登录状态。账号只在插件自己的数据目录里，不写进项目。 */
function pageAccounts(accounts: Account[]) {
  return accounts.map(a => ({ id: a.id, name: a.name, created_at: a.created_at, ...(a.avatar ? { avatar: a.avatar } : {}) }));
}

export async function runOperation(operation: string, raw: unknown, progress: Progress = () => {}, deps = defaults): Promise<Result> {
  const request = validateRequest(raw);
  if (!operations.includes(operation)) throw Error('不支持这个操作；插件只上传填表，不提交发布');
  const { project_root: root, params } = request;
  const store = new AccountStore(request.data_dir);
  let account: Account | undefined;
  if (!root && operation === 'prepare') throw Error('要在项目里进行：先在片场打开这个项目');
  const update = (result: Result) => {
    if (!root || operation === 'accounts') return;
    writeProjectJSON(root, 'production/xiaohongshu/latest.json', { status: result.status, message: result.message, ...(result.account ? { account: { id: result.account.id, name: result.account.name } } : {}), ...(result.warnings ? { warnings: result.warnings } : {}), operation, updated_at: new Date().toISOString() });
    if (operation === 'prepare') writeProjectJSON(root, 'production/xiaohongshu/state.json', { ...result, updated_at: new Date().toISOString() });
  };
  try {
    if (operation === 'accounts') {
      const accounts = store.list();
      return { status: 'accounts_loaded', message: accounts.length ? `${accounts.length} 个账号` : '还没有账号', items: accountItems(accounts), accounts: pageAccounts(accounts) };
    }
    update({ status: 'running', message: operation === 'login' ? '正在打开小红书登录页…' : '正在准备…' });
    if (operation === 'login') { const result = await login(request, store, progress, deps); update(result); return result; }
    account = store.get(parameter(params.account, '账号'));
    if (operation === 'remove_account') {
      if (request.browser) { const bridge = deps.bridge(request.browser); try { await bridge.forget(account.id); } finally { bridge.disconnect(); } }
      store.remove(account.id);
      const result = { status: 'removed', message: `已移除「${account.name}」` }; update(result); return result;
    }
    const result = await withAccountLock(store.profile(account.id), async (): Promise<Result> => {
      const draft = operation === 'prepare' ? await deps.draft(root) : null;
      progress(0.05, `正在打开「${account!.name}」的小红书窗口`);
      const browser = await deps.open(store.profile(account!.id), { bridge: request.browser, account: account!.id, label: account!.name, hint: draft ? '请检查账号与内容，发布由你确认' : '这是这个账号的小红书窗口' });
      try {
        const page = await deps.page(browser);
        // 窗口还停在这个成片的编辑页（上次等上传时中断了，或从草稿箱打开了它）：接着用，不跳回上传页重传。
        // 是不是这个成片：插件记下的指纹，或编辑页里视频的时长。换了成片或页面已离开编辑页才重新上传。
        const resume = !!draft && browser.reused === true && await canResume(page)
          && (store.lastUpload(account!.id) === draft.videoHash || await editorHoldsFilm(page, draft));
        if (!resume && (draft || !browser.reused)) await page.navigate(page.origin + (draft ? '/publish/publish?from=menu&target=video' : '/'));
        if (!draft) return { status: 'browser_opened', message: `已打开「${account!.name}」的小红书窗口`, account };
        // 视频交给小红书之后（或接着上次的上传）到填完：页面上盖遮罩显示进度，免得用户点乱。登录、找上传入口时不盖，用户可能要在页面上登录。
        // 旧版片场不认遮罩命令，照常进行。小红书弹出验证时揭开遮罩交给用户（paused），验证没了再按最近的进度盖上。
        let masked = false, paused = false, lastMessage = '', lastFraction = 0;
        const mask = (message: string, fraction: number) => {
          masked = true;
          lastMessage = message; lastFraction = Math.max(0, Math.min(1, fraction));
          if (!paused) void browser.busy?.(lastMessage, lastFraction).catch(() => {});
        };
        if (resume) mask('接着上次的上传', 0.2);
        let warnings: string[];
        try {
          warnings = await deps.prepare(page, draft, (fraction, message) => {
            progress(fraction, message); update({ status: 'running', message, account });
            if (masked && !paused) mask(message, fraction);
          }, {
            resume,
            again: params.again === '1',
            onUpload: () => { store.recordUpload(account!.id, draft.videoHash); mask('正在上传视频', 0.2); },
            onPause: () => { paused = true; if (masked) void browser.idle?.().catch(() => {}); },
            onResume: () => { paused = false; if (masked) mask(lastMessage, lastFraction); },
          });
        } catch (err) {
          // 这个成片已经发过：不算失败，交给用户在插件页面决定要不要「仍然上传」。
          if (err instanceof AlreadyPublished) return { status: 'already_published', message: err.message, account };
          throw err;
        } finally {
          if (masked) await browser.idle?.().catch(() => {});
        }
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

/**
 * 登录：给新账号开一个独立的网页存储，打开小红书，等用户在片场里的页面登录好，读出昵称与头像记下来，再把页面关掉回到片场。
 * 用户点「返回片场」收起页面、或十分钟没登录，就当不登了，新开的存储一起删掉。
 */
async function login(request: Request, store: AccountStore, progress: Progress, deps: typeof defaults): Promise<Result> {
  const id = newAccountID();
  progress(0.05, '正在打开小红书登录页');
  const browser = await deps.open('', { bridge: request.browser, account: id, label: '登录', hint: '请在下方登录小红书，登录后会自动回到片场' });
  let saved = false;
  try {
    const page = await deps.page(browser);
    await page.navigate(page.origin + '/');
    progress(0.1, '等你在小红书页面登录…');
    const deadline = Date.now() + deps.loginTimeout;
    let info: { name: string; avatar: string; user_id: string } | null = null;
    for (;;) {
      if (Date.now() > deadline) throw Error('等了十分钟还没登录，这次没有添加账号');
      const state = await browser.state?.();
      if (state && (!state.open || !state.visible)) throw Error('登录页面关掉了，这次没有添加账号');
      try { info = await page.evaluate(scripts.loginInfo); } catch { info = null; } // 跳转中、还在别的小红书页面：下一轮再看
      if (info?.name) break;
      await deps.sleep(1500);
    }
    progress(0.9, `已登录「${info.name}」，正在读取头像`);
    const avatar = info.avatar ? await deps.avatar(info.avatar).catch(() => '') : '';
    const { account, replaced } = store.saveLoggedIn({ id, name: info.name, user_id: info.user_id, avatar });
    saved = true;
    await browser.close?.().catch(() => {});
    return { status: 'logged_in', message: replaced ? `「${account.name}」重新登录好了` : `已登录：${account.name}`, account };
  } finally {
    // 没登录成：关掉页面，删掉为它开的存储，账号列表里不留半截的账号。
    if (!saved) await browser.close?.().catch(() => {});
    browser.disconnect();
    if (!saved) store.removeFiles(id);
  }
}
