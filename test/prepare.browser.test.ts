import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from './support/browser';
import { CDP, Page } from '../src/cdp';
import { AlreadyPublished, canResume, preparePage } from '../src/prepare';
import * as scripts from '../src/page-scripts';

let root: string, origin: string, server: http.Server;
/** 登录检测用：创作者中心接口这次回什么（null 表示 404）。 */
let personalInfo: unknown = null;
/** 已发布笔记接口这次回什么：默认一条也没有；null 表示读不到（500）。 */
let postedNotes: unknown = { code: 0, success: true, data: { notes: [], page: -1 } };
const browsers: Awaited<ReturnType<typeof openBrowser>>[] = [];
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-xhs-browser-'));
  fs.writeFileSync(path.join(root, 'video.mp4'), 'fixture-video'); fs.writeFileSync(path.join(root, 'cover.png'), 'fixture-image');
  server = http.createServer((req, res) => {
    const files: Record<string, [string, string]> = { '/ui/': ['ui/index.html', 'text/html'], '/ui/app.js': ['ui/app.js', 'text/javascript'], '/ui/style.css': ['ui/style.css', 'text/css'] };
    const route = files[req.url ?? ''];
    if (route) { res.setHeader('Content-Type', route[1] + '; charset=utf-8'); res.end(fs.readFileSync(route[0])); return; }
    if (req.url === '/api/galaxy/creator/home/personal_info') {
      if (personalInfo === null) { res.writeHead(404).end('{}'); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(personalInfo)); return;
    }
    if (req.url?.startsWith('/api/galaxy/v2/creator/note/user/posted')) {
      if (postedNotes === null) { res.writeHead(500).end(''); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(postedNotes)); return;
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
        run:async(op,params)=>{calls.push({op,params});window.latest={status:window.nextStatus||'ready_to_publish',updated_at:new Date(Date.now()+1000).toISOString(),message:window.nextStatus?'这个成片已经发到这个小红书账号了':'内容已填好，请在小红书页面手动发布',account:{id:params.account},warnings:[]};return {started:true};}};
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
  // 等假页面的脚本跑完：测试里改写的上传处理不能被它盖掉。
  await page.waitFor(() => Array.isArray((window as any).uploads), 5000);
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
    cover: (window as any).coverSaved,
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
  await page.evaluate(() => document.querySelector('.cover-plugin-preview')?.remove());
  await expect(preparePage(page, { ...draft, tags: [] }, () => {}, { timeout: 100 })).rejects.toThrow('封面');
  // 没有登记封面：不去点设置封面（入口已经没了也不报错），提醒一句。
  const noCover = await preparePage(page, { ...draft, tags: [], cover: '' }, () => {}, { timeout: 100 }).catch((err: Error) => err);
  expect(noCover instanceof Error ? noCover.message : '').not.toContain('封面');

  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});
it('编辑器里已经有一张传上去的封面（接着草稿做）：先清掉，再放进这次的封面', async () => {
  const { page } = await pageFor('cover-existing');
  await page.evaluate(() => { (window as any).existingCover = 'old.png'; });
  await preparePage(page, { title: '标题', content: '正文', tags: [], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 3000 });
  expect(await page.evaluate(() => ({ saved: (window as any).coverSaved, cleared: (window as any).cleared, uploads: (window as any).coverUploads, open: !(document.querySelector('.d-modal-mask') as HTMLElement).hidden })))
    .toEqual({ saved: 'cover.png', cleared: 1, uploads: 1, open: false });
});
it('旧版页面（「设置封面」按钮 →「上传封面」→「确定」）照旧能设封面', async () => {
  const { page } = await pageFor('cover-legacy');
  expect(await page.evaluate(scripts.coverEditorOpen)).toBe(false);
  await page.evaluate(() => {
    document.querySelector('.cover-plugin-preview')?.remove();
    const old = document.createElement('div');
    old.innerHTML = '<button class="upload-cover">设置封面</button><div class="d-modal" hidden><button>上传封面</button><div class="upload-wrapper"><input type="file" accept="image/*"></div><div class="d-modal-footer"><button id="confirm">确定</button></div></div>';
    document.body.append(old);
    old.querySelector<HTMLElement>('.upload-cover')!.onclick = () => { old.querySelector<HTMLElement>('.d-modal')!.hidden = false; };
    old.querySelector<HTMLElement>('#confirm')!.onclick = () => { old.querySelector<HTMLElement>('.d-modal')!.hidden = true; };
  });
  await preparePage(page, { title: '标题', content: '正文', tags: [], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 3000 });
  expect(await page.evaluate(() => (document.querySelector('.d-modal input[type="file"]') as HTMLInputElement).files?.[0]?.name)).toBe('cover.png');
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
  expect(await page.evaluate(() => (document.querySelector('[contenteditable]') as HTMLElement).innerText)).toMatch(/^正文\n#科技\[话题\]#\s?#AI\[话题\]#\s?#冷门话题\s$/);
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});
it('候选列表重画、点下去插错了话题：等位置稳定再点，插错的退格删掉重选，只看正文里的话题', async () => {
  const { page } = await pageFor('topic-race');
  await page.evaluate(() => {
    (window as any).hotTopic = 'vibe知识大赏'; (window as any).misfire = 1;
    // 右边的笔记预览也有一份话题，核对时不能算进去。
    const preview = document.createElement('div'); preview.innerHTML = '<a data-topic=\'{"name":"预览里的"}\'>#预览里的</a>'; document.body.append(preview);
  });
  const warnings = await preparePage(page, { title: '标题', content: '正文', tags: ['科技', 'AI'], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 3000 });
  expect(warnings).toEqual([]);
  expect(await page.evaluate(() => [...document.querySelectorAll('[contenteditable] a[data-topic]')].map(a => JSON.parse(a.getAttribute('data-topic')!).name))).toEqual(['科技', 'AI']);
});
it('页面自己加进来的、不在清单里的话题（关联活动、旧草稿）在准备完之前删掉，并告诉用户', async () => {
  const { page } = await pageFor('extra-topics');
  await page.evaluate(() => { (window as any).autoTopic = 'AI替我说'; });
  const warnings = await preparePage(page, { title: '标题', content: '正文', tags: ['科技', 'AI'], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 3000 });
  expect(await page.evaluate(() => [...document.querySelectorAll('[contenteditable] a[data-topic]')].map(a => JSON.parse(a.getAttribute('data-topic')!).name))).toEqual(['科技', 'AI']);
  expect(warnings).toEqual(['已删掉正文里不在话题清单里的话题：AI替我说。']);
});
it('片场客户端不放行键盘与鼠标事件（旧版）时不整个失败：退回插入文字，话题留成文字并提醒', async () => {
  const { page } = await pageFor('old-client');
  const raw = page.raw.bind(page);
  (page as any).raw = (method: string, params?: Record<string, unknown>) => /^Input\.dispatch/.test(method) ? Promise.reject(Error('不支持这个网页控制命令')) : raw(method, params);
  const warnings = await preparePage(page, { title: '标题', content: '正文', tags: ['科技'], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 300 });
  expect(warnings.join('\n')).toContain('科技');
  expect(await page.evaluate(() => (document.querySelector('[contenteditable]') as HTMLElement).innerText)).toMatch(/正文\s#科技/);
});
/** 往假页面的本机草稿库里放几条视频草稿（与小红书的 draft-database-v1 / video-draft 同形）。 */
async function seedDrafts(page: Page, drafts: { id: string; title: string; size: number; at: number; duration?: number }[]) {
  await page.evaluate(async (list: { id: string; title: string; size: number; at: number; duration?: number }[]) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('draft-database-v1', 10);
      open.onupgradeneeded = () => { for (const s of ['video-draft', 'image-draft']) open.result.createObjectStore(s, { keyPath: 'draftId' }); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('video-draft', 'readwrite');
        for (const d of list) tx.objectStore('video-draft').put({ draftId: d.id, timeStamp: d.at, uid: 'u', content: { draftStore: { title: d.title, video: { fileid: 'spectrum/' + d.id, fsize: d.size, duration: d.duration ?? 0 } } } });
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

const media = (extra: Record<string, unknown> = {}) => ({ title: '我的标题', content: '正文', tags: [] as string[], video: path.join(root, 'video.mp4'), videoHash: 'hash', cover: path.join(root, 'cover.png'), ...extra });
const title = (page: Page) => page.evaluate(() => (document.querySelector('input[placeholder]') as HTMLInputElement).value);

it('检测到上传失败后不填写，也不尝试提交', async () => {
  const { page } = await pageFor('failed-upload');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#progress')!.textContent = '上传失败，请重新上传';
    };
  });
  const log: string[] = []; const r = await preparePage(page, media(), (_f, m) => log.push(m), { timeout: 500 }).catch(e => e); console.log(log, r, await page.evaluate(() => [document.body.innerText, (window as any).uploads])); expect(String(r)).toContain("上传或处理失败");
  expect(await title(page)).toBe('');
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});

it('大视频上传超过单步时限也一直等，进度在走就传完接着填写', async () => {
  const { page } = await pageFor('slow-upload');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      const status = document.querySelector<HTMLElement>('#progress')!;
      let percent = 0; status.textContent = '上传中 0%';
      const timer = setInterval(() => {
        percent += 10;
        if (percent < 100) { status.textContent = `上传中 ${percent}%`; return; }
        clearInterval(timer); status.textContent = '上传成功，重新上传';
      }, 150);
    };
  });
  const messages: string[] = [], fractions: number[] = [];
  const uploads = vi.fn();
  const started = Date.now();
  await expect(preparePage(page, media(), (f, message) => { fractions.push(f); messages.push(message); }, { timeout: 600, onUpload: uploads })).resolves.toEqual([]);
  expect(Date.now() - started).toBeGreaterThan(1000);
  expect(uploads).toHaveBeenCalledOnce();
  expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/^正在上传视频 \d+%/), '正在填写标题、正文和话题']));
  const uploading = fractions.filter((_f, i) => /^正在上传视频 \d+%/.test(messages[i]));
  expect(Math.min(...uploading)).toBeGreaterThanOrEqual(0.2); expect(Math.max(...uploading)).toBeLessThanOrEqual(0.55);
  expect(await title(page)).toBe('我的标题');
});

it('窗口开着时上传卡住也不设时限，等小红书传完照样接着填写', async () => {
  const { page } = await pageFor('stalled-upload');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#progress')!.textContent = '上传中 40%';
      setTimeout(() => { document.querySelector('#progress')!.textContent = '上传成功，重新上传'; }, 2500);
    };
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 500 })).resolves.toEqual([]);
  expect(await title(page)).toBe('我的标题');
});

it('窗口关掉（离开小红书）时停止等待', async () => {
  const { page } = await pageFor('closed-window');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#progress')!.textContent = '上传中 40%';
      setTimeout(() => { location.href = 'about:blank'; }, 300);
    };
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 500 })).rejects.toThrow();
});

it('窗口停在编辑页时接着上次的上传填写，不再上传一次视频', async () => {
  const { page } = await pageFor('resume');
  expect(await canResume(page)).toBe(false);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#editor')!.hidden = false;
    document.querySelector('#progress')!.textContent = '上传中 40%';
  });
  expect(await canResume(page)).toBe(true);
  await page.evaluate(() => setTimeout(() => { document.querySelector('#progress')!.textContent = '上传成功，重新上传'; }, 500));
  const uploaded = vi.fn();
  await expect(preparePage(page, media(), () => {}, { timeout: 2000, resume: true, onUpload: uploaded })).resolves.toEqual([]);
  expect(uploaded).not.toHaveBeenCalled();
  expect(await page.evaluate(() => ({ uploads: (window as any).uploads, cover: (window as any).coverSaved, submits: (window as any).submits })))
    .toEqual({ uploads: [], cover: 'cover.png', submits: 0 });
  expect(await title(page)).toBe('我的标题');
});

it('上传失败的编辑页不续接', async () => {
  const { page } = await pageFor('resume-failed');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#editor')!.hidden = false;
    document.querySelector('#progress')!.textContent = '上传失败';
  });
  expect(await canResume(page)).toBe(false);
});

it('只有进度条在走、文字不变时不算卡住，并按进度条报百分比', async () => {
  const { page } = await pageFor('bar-only');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      const status = document.querySelector<HTMLElement>('#progress')!;
      status.innerHTML = '<span>上传中</span><span class="bar" role="progressbar" aria-valuemax="200" aria-valuenow="0" style="display:inline-block;width:1px;height:2px"></span>';
      const bar = status.querySelector<HTMLElement>('.bar')!;
      let value = 0;
      const timer = setInterval(() => {
        value += 20;
        if (value < 200) { bar.setAttribute('aria-valuenow', String(value)); return; }
        clearInterval(timer); status.textContent = '上传成功，重新上传';
      }, 120);
    };
  });
  const messages: string[] = [];
  await expect(preparePage(page, media(), (_f, message) => messages.push(message), { timeout: 1000 })).resolves.toEqual([]);
  expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/^正在上传视频 [1-9]\d*%/)]));
});

it('上传中弹出验证：停下全部自动操作交给用户，验证没了再接着填写', async () => {
  const { page } = await pageFor('verification');
  await page.evaluate(() => {
    // 隐藏着的验证容器不算。
    document.body.insertAdjacentHTML('beforeend', '<div class="red-captcha-container" style="display:none;width:300px;height:200px"></div>');
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#progress')!.textContent = '上传中 30%';
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="verify" style="width:320px;height:200px">安全验证 请完成下列验证后继续</div>'), 200);
      setTimeout(() => { document.querySelector('#progress')!.textContent = '上传成功，重新上传'; }, 400);
    };
  });
  const events: string[] = [];
  const done = preparePage(page, media(), (_f, message) => { if (message.includes('验证')) events.push(message); }, {
    timeout: 1000, onPause: () => events.push('pause'), onResume: () => events.push('resume'),
  });
  await expect.poll(() => events.includes('pause'), { timeout: 5000 }).toBe(true);
  await new Promise(r => setTimeout(r, 1500));
  expect(await title(page)).toBe('');
  expect(events).toEqual(['pause', '小红书要求验证：请在小红书窗口完成验证，完成后自动继续']);
  await page.evaluate(() => document.querySelector('#verify')!.remove());
  await expect(done).resolves.toEqual([]);
  expect(events.at(-1)).toBe('resume');
  expect(await title(page)).toBe('我的标题');
});

it('认得出小红书的验证组件与身份确认弹窗，不把封面编辑器当成验证', async () => {
  const { page } = await pageFor('verification-kinds');
  expect(await page.evaluate(scripts.verificationOpen)).toBe(false);
  await page.evaluate(() => { (document.querySelector('.d-modal-mask') as HTMLElement).hidden = false; });
  expect(await page.evaluate(scripts.verificationOpen)).toBe(false);
  await page.evaluate(() => { (document.querySelector('.d-modal-mask') as HTMLElement).hidden = true; document.body.insertAdjacentHTML('beforeend', '<iframe src="about:blank#captcha" style="width:300px;height:200px"></iframe>'); });
  expect(await page.evaluate(scripts.verificationOpen)).toBe(true);
  await page.evaluate(() => { document.querySelector('iframe')!.remove(); document.body.insertAdjacentHTML('beforeend', '<div class="d-modal" style="width:300px;height:200px">身份验证 请输入短信验证码</div>'); });
  expect(await page.evaluate(scripts.verificationOpen)).toBe(true);
});

it('草稿箱里只接着同一个成片的草稿：大小一样、时长对不上的不认，也不删任何草稿', async () => {
  const { page } = await pageFor('draft-duration');
  const video = path.join(root, 'video.mp4'), size = fs.statSync(video).size;
  const base = Date.parse('2026-11-17T03:36:12Z');
  await seedDrafts(page, [{ id: 'other-cut', title: '别的剪辑', size, at: base, duration: 95 }]);
  await expect(preparePage(page, media({ videoSize: size, videoDuration: 180_000 }), () => {}, { timeout: 2000 })).resolves.toEqual([]);
  expect(await page.evaluate(() => ({ resumed: (window as any).resumed, deleted: (window as any).deleted, uploads: (window as any).uploads })))
    .toEqual({ resumed: undefined, deleted: undefined, uploads: ['video.mp4'] });

  const { page: same } = await pageFor('draft-same-film');
  await seedDrafts(same, [{ id: 'other-cut', title: '别的剪辑', size, at: base, duration: 95 }, { id: 'mine', title: '这个成片', size, at: base - 1000, duration: 180.2 }]);
  const uploaded = vi.fn();
  await expect(preparePage(same, media({ videoSize: size, videoDuration: 180_000 }), () => {}, { timeout: 2000, onUpload: uploaded })).resolves.toEqual([]);
  expect(uploaded).toHaveBeenCalledOnce();
  expect(await same.evaluate(() => ({ resumed: (window as any).resumed, deleted: (window as any).deleted, uploads: (window as any).uploads })))
    .toEqual({ resumed: 'mine', deleted: undefined, uploads: [] });
});

it('这个成片已经发过：不上传，说明何时发的；点了「仍然上传」才上传', async () => {
  const { page } = await pageFor('published');
  postedNotes = { code: 0, success: true, data: { page: -1, notes: [
    { display_title: '我的标题', type: 'normal', time: '2026-11-01 10:00', tab_status: 1 },
    { display_title: '别的笔记', type: 'video', video_info: { duration: 180 }, time: '2026-11-02 10:00', tab_status: 1 },
    { display_title: '我的 标题', type: 'video', video_info: { duration: 181 }, time: '2026-11-18 15:44', tab_status: 2 },
  ] } };
  try {
    const error = await preparePage(page, media({ videoDuration: 180_400 }), () => {}, { timeout: 2000 }).catch(err => err);
    expect(error).toBeInstanceOf(AlreadyPublished);
    expect(error.message).toMatch(/2026-11-18 15:44 已经发到这个小红书账号了（「我的 标题」，正在审核）.*仍然上传/);
    expect(await page.evaluate(() => (window as any).uploads)).toEqual([]);
    // 时长差得多就不是这个成片。
    await expect(preparePage(page, media({ videoDuration: 120_000 }), () => {}, { timeout: 2000 })).resolves.toEqual([]);
    expect(await page.evaluate(() => (window as any).uploads)).toEqual(['video.mp4']);
    await page.navigate(origin + '/publish/publish');
    await page.waitFor(() => document.querySelector('.upload-input') !== null, 5000);
    await expect(preparePage(page, media({ videoDuration: 180_400 }), () => {}, { timeout: 2000, again: true })).resolves.toEqual([]);
    expect(await page.evaluate(() => (window as any).uploads)).toEqual(['video.mp4']);
  } finally { postedNotes = { code: 0, success: true, data: { notes: [], page: -1 } }; }
});

it('翻页读已发布笔记，带上页面自己的签名', async () => {
  const { page } = await pageFor('notes-pages');
  await page.evaluate(() => {
    (window as any)._webmsxyw = (url: string) => ({ 'X-s': 'sig:' + url, 'X-t': 1 });
    const real = window.fetch; (window as any).seen = [];
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith('/api/galaxy/v2/creator/note/user/posted')) return real(input, init);
      (window as any).seen.push([url, (init?.headers as Record<string, string>)['x-s']]);
      const page = Number(new URL(url, location.href).searchParams.get('page'));
      return Response.json({ code: 0, success: true, data: { page: page < 1 ? page + 1 : -1, notes: [{ display_title: 'p' + page, type: 'video', video_info: { duration: 10 } }] } });
    };
  });
  expect((await page.evaluate(scripts.recentNotes, 5))?.map(n => [n.title, n.duration])).toEqual([['p0', 10_000], ['p1', 10_000]]);
  expect(await page.evaluate(() => (window as any).seen)).toEqual([
    ['/api/galaxy/v2/creator/note/user/posted?tab=0&page=0', 'sig:/api/galaxy/v2/creator/note/user/posted?tab=0&page=0'],
    ['/api/galaxy/v2/creator/note/user/posted?tab=0&page=1', 'sig:/api/galaxy/v2/creator/note/user/posted?tab=0&page=1'],
  ]);
});

it('读不到已发布笔记时照常上传，并提醒用户留意', async () => {
  const { page } = await pageFor('notes-unreadable');
  postedNotes = null;
  try {
    await expect(preparePage(page, media(), () => {}, { timeout: 2000 })).resolves.toEqual([expect.stringContaining('没能读到这个账号已发布的笔记')]);
  } finally { postedNotes = { code: 0, success: true, data: { notes: [], page: -1 } }; }
  expect(await title(page)).toBe('我的标题');
});

it('插件页面：成片已经发过时显示「仍然上传」，点了带 again 重新准备', async () => {
  const { page } = await pageFor('plugin-ui-again'); await page.navigate(origin + '/ui/');
  await page.waitFor(() => document.querySelectorAll('#accounts option').length === 2, 5000);
  expect(await page.evaluate(() => (document.querySelector('#again') as HTMLElement).hidden)).toBe(true);
  await page.evaluate(() => { (window as any).nextStatus = 'already_published'; });
  await page.click('#prepare');
  await page.waitFor(() => !(document.querySelector('#again') as HTMLElement).hidden, 5000);
  expect(await page.evaluate(() => document.querySelector('#status')?.textContent)).toContain('已经发到');
  await page.evaluate(() => { (window as any).nextStatus = ''; });
  await page.click('#again');
  await page.waitFor(() => (document.querySelector('#again') as HTMLElement).hidden, 5000);
  await page.waitFor(() => (window as any).calls.length === 2, 5000);
  expect(await page.evaluate(() => (window as any).calls.map((c: any) => c.params))).toEqual([{ account: 'a' }, { account: 'a', again: '1' }]);
});
