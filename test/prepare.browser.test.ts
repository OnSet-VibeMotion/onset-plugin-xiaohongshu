import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from './support/browser';
import { CDP, Page } from '../src/cdp';
import { preparePage } from '../src/prepare';
import * as scripts from '../src/page-scripts';

let root: string, origin: string, server: http.Server;
/** 登录检测用：创作者中心接口这次回什么（null 表示 404）。 */
let personalInfo: unknown = null;
const browsers: Awaited<ReturnType<typeof openBrowser>>[] = [];
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-xhs-browser-'));
  server = http.createServer((req, res) => {
    const files: Record<string, [string, string]> = { '/ui/': ['ui/index.html', 'text/html'], '/ui/app.js': ['ui/app.js', 'text/javascript'], '/ui/style.css': ['ui/style.css', 'text/css'] };
    const route = files[req.url ?? ''];
    if (route) { res.setHeader('Content-Type', route[1] + '; charset=utf-8'); res.end(fs.readFileSync(route[0])); return; }
    if (req.url === '/api/galaxy/creator/home/personal_info') {
      if (personalInfo === null) { res.writeHead(404).end('{}'); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(personalInfo)); return;
    }
    if (req.url === '/login' || req.url === '/new/home') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/login' ? '<!doctype html><p>扫码登录</p>' : '<!doctype html><header><img class="user-avatar" src="https://sns-avatar-qc.xhscdn.com/dom.jpg" width="32" height="32"><span class="user-name">页面昵称</span></header>');
      return;
    }
    if (req.url === '/station-ui/_sdk.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(`
        document.documentElement.style.cssText='--text:#eee8dd;--bg:#17191b;--panel:#25272a;--well:#202224;--line:#3b3d40;--accent:#ccb486;--accent-ink:#17191b;--text-2:#b3b0a9;--text-3:#96928b;--bad:#e98c80';
        window.calls=[]; window.latest=null;
        window.onset={ready:Promise.resolve(),onRefresh:()=>{},read:async p=>{if(p.includes('accounts'))throw Error('账号不在项目文件里');return {text:JSON.stringify(window.latest)};},
        list:async op=>op==='accounts'?{accounts:[{id:'a',name:'个人号'},{id:'b',name:'工作号'}]}:{},
        run:async(op,params)=>{calls.push({op,params});window.latest={status:'ready_to_publish',updated_at:new Date(Date.now()+1000).toISOString(),message:'内容已填好，请在小红书页面手动发布',account:{id:params.account},warnings:[]};return {started:true};}};
      `); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterAll(async () => {
  const ownedProcesses = new Set<number>();
  for (const browser of browsers) {
    try {
      const info = await browser.send('SystemInfo.getProcessInfo');
      for (const processInfo of info.processInfo) ownedProcesses.add(processInfo.id);
      await browser.send('Browser.close');
    } catch {} finally { browser.disconnect(); }
  }
  await new Promise<void>(r => server.close(() => r()));
  // Browser.close acknowledges the request before Chromium and its children have
  // exited. Only these test-owned PIDs may be stopped; never touch normal Chrome.
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while ([...ownedProcesses].some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  for (const pid of ownedProcesses) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
async function pageFor(name: string) {
  const profile = path.join(root, name); fs.mkdirSync(profile, { recursive: true });
  const browser = await openBrowser(profile, { headless: true }); browsers.push(browser);
  const page = await Page.create(browser, origin); await page.navigate(origin + '/publish/publish');
  await page.waitFor(() => document.querySelector('.upload-input') !== null, 5000);
  return { page, browser, profile };
}
it('上传并填写后保持浏览器打开，永远不提交', async () => {
  const { page, browser, profile } = await pageFor('account-a');
  const video = path.join(root, 'video.mp4'), cover = path.join(root, 'cover.png');
  fs.writeFileSync(video, 'fixture-video'); fs.writeFileSync(cover, 'fixture-image');
  const warnings = await preparePage(page, { title: '我的视频', content: '中文正文\n第二段', tags: [], video, videoHash: 'hash', cover }, () => {}, { timeout: 5000 });
  expect(warnings).toEqual([]);
  expect(await page.evaluate(() => ({ title: (document.querySelector('input[placeholder]') as HTMLInputElement).value,
    body: (document.querySelector('[contenteditable]') as HTMLElement).innerText,
    submits: (window as any).submits,
    cover: (document.querySelector('input[accept="image/*"]') as HTMLInputElement).files?.[0]?.name,
  }))).toEqual({ title: '我的视频', body: '中文正文\n第二段', submits: 0, cover: 'cover.png' });
  await page.evaluate(() => { document.cookie = 'account=a; path=/'; });
  browser.disconnect();
  const reopened = await openBrowser(profile, { headless: true }); browsers.push(reopened);
  expect((await reopened.send('Target.getTargets')).targetInfos.some((t: any) => t.url.startsWith(origin))).toBe(true);
  const other = await pageFor('account-b');
  expect(await other.page.evaluate(() => document.cookie)).not.toContain('account=a');
});
it('账号页面离开创作者站点后拒绝填表和上传', async () => {
  const { page } = await pageFor('wrong-origin');
  await page.raw('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 100));
  await expect(page.evaluate(() => document.body.textContent)).rejects.toThrow('页面');
  await expect(page.upload('.upload-input', path.join(root, 'video.mp4'))).rejects.toThrow();
});
it('上传控件缺失时报告失败，不会点击发布', async () => {
  const { page } = await pageFor('missing-input');
  await page.evaluate(() => document.querySelector('.upload-input')?.remove());
  await expect(preparePage(page, { title: '标题', content: '正文', tags: [], video: '/unused.mp4', videoHash: '', cover: '/unused.png' }, () => {}, { timeout: 50 })).rejects.toThrow();
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});
it('页面操作边界、缺失控件和 CDP 断开都会返回清楚的错误', async () => {
  const { page, browser, profile } = await pageFor('errors');
  await expect(CDP.connect('wss://example.com/devtools')).rejects.toThrow('本机');
  await expect(page.navigate('https://example.com')).rejects.toThrow('小红书');
  await expect(page.click('#publish')).rejects.toThrow('不允许');
  await expect(browser.send('NoSuchDomain.test')).rejects.toThrow();
  await page.evaluate(() => { document.querySelector('input[placeholder]')?.remove(); document.querySelector('[contenteditable]')?.remove(); });
  await expect(page.fillTitle('标题')).rejects.toThrow('标题');
  await expect(page.fillContent('正文')).rejects.toThrow('正文');
  expect(await page.click('.missing')).toBe(false);
  browser.disconnect();
  await expect(browser.send('Browser.getVersion')).rejects.toThrow();
  browsers.push(await openBrowser(profile, { headless: true }));
  expect(() => findBrowser('/missing-browser')).toThrow('未找到');
});
it('未匹配的话题保留文字并明确提醒用户，封面失败不能算准备完成', async () => {
  const { page } = await pageFor('tags');
  const draft = { title: '标题', content: '正文', tags: ['冷门话题'], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') };
  const warnings = await preparePage(page, draft, () => {}, { timeout: 100 });
  expect(warnings[0]).toContain('冷门话题');
  expect(await page.evaluate(() => (document.querySelector('[contenteditable]') as HTMLElement).innerText)).toContain('#冷门话题');
  expect(await page.evaluate(() => document.querySelectorAll('a[data-topic]').length)).toBe(0);
  await page.evaluate(() => document.querySelector('.upload-cover')?.remove());
  await expect(preparePage(page, { ...draft, tags: [] }, () => {}, { timeout: 100 })).rejects.toThrow('封面');
  // 没有登记封面：不去点设置封面（入口已经没了也不报错），提醒一句。
  const noCover = await preparePage(page, { ...draft, tags: [], cover: '' }, () => {}, { timeout: 100 }).catch((err: Error) => err);
  expect(noCover instanceof Error ? noCover.message : '').not.toContain('封面');

  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});
it('逐字输入话题、按话题名点中候选（不被浏览量和同前缀的话题干扰），确认封面不触及其他确认弹窗', async () => {
  const { page } = await pageFor('topic-selected');
  await page.evaluate(() => {
    const unrelated = document.createElement('div'); unrelated.setAttribute('role', 'dialog'); unrelated.hidden = true;
    unrelated.innerHTML = '<button>确定</button>'; document.body.append(unrelated);
  });
  const warnings = await preparePage(page, { title: '标题', content: '正文', tags: ['科技', 'ai', '冷门话题'], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 2000 });
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain('冷门话题');
  expect(await page.evaluate(() => [...document.querySelectorAll('a[data-topic]')].map(a => JSON.parse(a.getAttribute('data-topic')!).name))).toEqual(['科技', 'AI']);
  expect(await page.evaluate(() => (document.querySelector('[contenteditable]') as HTMLElement).innerText)).toMatch(/^正文\n#科技\[话题\]# ?#AI\[话题\]# ?#冷门话题\s$/);
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});
/** 往假页面的本机草稿库里放几条视频草稿（与小红书的 draft-database-v1 / video-draft 同形）。 */
async function seedDrafts(page: Page, drafts: { id: string; title: string; size: number; at: number }[]) {
  await page.evaluate(async (list: { id: string; title: string; size: number; at: number }[]) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('draft-database-v1', 10);
      open.onupgradeneeded = () => { for (const s of ['video-draft', 'image-draft']) open.result.createObjectStore(s, { keyPath: 'draftId' }); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('video-draft', 'readwrite');
        for (const d of list) tx.objectStore('video-draft').put({ draftId: d.id, timeStamp: d.at, uid: 'u', content: { draftStore: { title: d.title, video: { fileid: 'spectrum/' + d.id, fsize: d.size } } } });
        tx.oncomplete = () => { open.result.close(); resolve(); };
      };
    });
  }, drafts);
}
it('同一个成片上次传过没发布：从草稿箱打开那条草稿接着填，不再上传；成片换了就照常上传', async () => {
  const { page } = await pageFor('resume-draft');
  const video = path.join(root, 'video.mp4'), size = fs.statSync(video).size;
  const base = Date.parse('2026-11-17T03:36:12Z');
  await seedDrafts(page, [
    { id: 'old', title: '同名标题', size, at: base - 3600_000 },
    { id: 'mine', title: '同名标题', size, at: base },
    { id: 'other-video', title: '别的片子', size: size + 1, at: base + 60_000 },
  ]);
  const draft = { title: '新标题', content: '新正文', tags: [], video, videoHash: '', cover: path.join(root, 'cover.png') };
  await preparePage(page, draft, () => {}, { timeout: 2000 });
  expect(await page.evaluate(() => (window as any).resumed)).toBe('mine');
  expect(await page.evaluate(() => (window as any).uploads)).toEqual([]);
  expect(await page.evaluate(() => (window as any).deleted)).toBeUndefined();
  expect(await page.evaluate(() => (document.querySelector('input[placeholder]') as HTMLInputElement).value)).toBe('新标题');

  const { page: fresh } = await pageFor('changed-video');
  await seedDrafts(fresh, [{ id: 'stale', title: '旧成片', size: size + 1, at: base }]);
  await preparePage(fresh, draft, () => {}, { timeout: 2000 });
  expect(await fresh.evaluate(() => (window as any).resumed)).toBeUndefined();
  expect(await fresh.evaluate(() => (window as any).uploads)).toEqual(['video.mp4']);
});
it('视频尚未处理完成或平台校验不通过时不能报告已准备好', async () => {
  const { page } = await pageFor('not-ready');
  await page.evaluate(() => { (document.querySelector('#publish') as HTMLButtonElement).disabled = true; });
  await expect(preparePage(page, { title: '标题', content: '正文', tags: [], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 100 })).rejects.toThrow('尚未允许发布');
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});
it('插件页面选中工作号后只请求上传准备，并显示手动发布提示', async () => {
  const { page } = await pageFor('plugin-ui'); await page.navigate(origin + '/ui/');
  await page.waitFor(() => document.querySelectorAll('#accounts option').length === 2, 5000);
  await page.evaluate(() => { const select = document.querySelector('#accounts') as HTMLSelectElement; select.value = 'b'; select.dispatchEvent(new Event('change')); });
  await page.click('#prepare');
  await page.waitFor(() => document.querySelector('#status')?.textContent?.includes('内容已填好') ?? false, 5000);
  const calls = await page.evaluate(() => (window as any).calls);
  expect(calls).toHaveLength(1); expect(calls[0].op).toBe('prepare'); expect(calls[0].params.account).toBe('b');
  expect(await page.evaluate(() => (document.querySelector('#accounts') as HTMLSelectElement).value)).toBe('b');
  await page.raw('Emulation.setDeviceMetricsOverride', { width: 720, height: 620, deviceScaleFactor: 1, mobile: false });
  const screenshot = await page.raw('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/plugin-ui.png', Buffer.from(screenshot.data, 'base64'));
});

it('认出登录了没有、登录的是谁：登录页不算；先读创作者中心接口，读不到再读页面上的头像与昵称', async () => {
  const { page } = await pageFor('login-info');
  await page.navigate(origin + '/login');
  expect(await page.evaluate(scripts.loginInfo)).toBeNull();
  await page.navigate(origin + '/new/home');
  personalInfo = { data: { userName: '小红薯', userAvatar: 'https://sns-avatar-qc.xhscdn.com/api.jpg', userId: 'u1' }, success: true };
  expect(await page.evaluate(scripts.loginInfo)).toEqual({ name: '小红薯', avatar: 'https://sns-avatar-qc.xhscdn.com/api.jpg', user_id: 'u1' });
  personalInfo = null;
  expect(await page.evaluate(scripts.loginInfo)).toEqual({ name: '页面昵称', avatar: 'https://sns-avatar-qc.xhscdn.com/dom.jpg', user_id: '' });
});
