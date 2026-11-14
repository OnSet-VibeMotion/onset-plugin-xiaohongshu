import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from '../src/browser';
import { CDP, Page } from '../src/cdp';
import { preparePage } from '../src/prepare';

let root: string, origin: string, server: http.Server;
const browsers: Awaited<ReturnType<typeof openBrowser>>[] = [];
const fixture = `<!doctype html><html lang="zh"><body>
<button class="creator-tab">上传视频</button>
<input type="file" class="upload-input" accept="video/*">
<p id="progress">请上传视频</p>
<input placeholder="填写标题"><div contenteditable="true" class="tiptap ProseMirror" style="min-height:60px"></div>
<button class="upload-cover">设置封面</button>
<div class="d-modal" hidden><button>上传封面</button><div class="upload-wrapper"><input type="file" accept="image/*"></div><div class="d-modal-footer"><button id="confirm">确定</button></div></div>
<div class="publish-page-publish-btn"><button id="publish">发布</button></div>
<script>
window.submits=0; window.uploads=[];
document.querySelector('.upload-input').onchange=e=>{uploads.push(e.target.files[0].name);document.querySelector('#progress').textContent='上传成功，重新上传';};
document.querySelector('.upload-cover').onclick=()=>document.querySelector('.d-modal').hidden=false;
document.querySelector('#confirm').onclick=()=>{document.querySelector('.d-modal').hidden=true;document.querySelector('.upload-cover').textContent='编辑封面';};
document.querySelector('#publish').onclick=()=>submits++;
</script></body></html>`;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-xhs-browser-'));
  server = http.createServer((req, res) => {
    const files: Record<string, [string, string]> = { '/ui/': ['ui/index.html', 'text/html'], '/ui/app.js': ['ui/app.js', 'text/javascript'], '/ui/style.css': ['ui/style.css', 'text/css'] };
    const route = files[req.url ?? ''];
    if (route) { res.setHeader('Content-Type', route[1] + '; charset=utf-8'); res.end(fs.readFileSync(route[0])); return; }
    if (req.url === '/station-ui/_sdk.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(`
        document.documentElement.style.cssText='--text:#eee8dd;--bg:#17191b;--panel:#25272a;--well:#202224;--line:#3b3d40;--accent:#ccb486;--accent-ink:#17191b;--text-2:#b3b0a9;--text-3:#96928b;--bad:#e98c80';
        window.calls=[]; window.latest=null;
        window.onset={ready:Promise.resolve(),onRefresh:()=>{},read:async p=>({text:JSON.stringify(p.includes('accounts')?{accounts:[{id:'a',name:'个人号'},{id:'b',name:'工作号'}]}:window.latest)}),
        run:async(op,params)=>{calls.push({op,params});window.latest={status:'ready_to_publish',request_id:params.request_id,message:'内容已填好，请在小红书页面手动发布',account:{id:params.account},warnings:[]};return {started:true};}};
      `); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterAll(async () => {
  for (const browser of browsers) { try { await browser.send('Browser.close'); } catch {} browser.disconnect(); }
  await new Promise<void>(r => server.close(() => r()));
  // Chromium may still be flushing its profile after Browser.close.
  await new Promise(r => setTimeout(r, 500));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  const draft = { title: '标题', content: '正文', tags: ['科技'], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') };
  const warnings = await preparePage(page, draft, () => {}, { timeout: 100 });
  expect(warnings[0]).toContain('科技');
  expect(await page.evaluate(() => (document.querySelector('[contenteditable]') as HTMLElement).innerText)).toContain('#科技');
  await page.evaluate(() => document.querySelector('.upload-cover')?.remove());
  await expect(preparePage(page, { ...draft, tags: [] }, () => {}, { timeout: 100 })).rejects.toThrow('封面');
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});
it('匹配到准确的话题时选中候选，确认封面不触及其他确认弹窗', async () => {
  const { page } = await pageFor('topic-selected');
  await page.evaluate(() => {
    const topic = document.createElement('button'); topic.setAttribute('role', 'option'); topic.textContent = '#科技';
    topic.onclick = () => { (window as any).topicSelected = true; }; document.body.append(topic);
    const unrelated = document.createElement('div'); unrelated.setAttribute('role', 'dialog'); unrelated.hidden = true;
    unrelated.innerHTML = '<button>确定</button>'; document.body.append(unrelated);
  });
  const warnings = await preparePage(page, { title: '标题', content: '正文', tags: ['科技'], video: path.join(root, 'video.mp4'), videoHash: '', cover: path.join(root, 'cover.png') }, () => {}, { timeout: 500 });
  expect(warnings).toEqual([]); expect(await page.evaluate(() => (window as any).topicSelected)).toBe(true);
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
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
