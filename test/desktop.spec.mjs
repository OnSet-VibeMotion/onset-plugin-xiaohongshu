import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
const { test, expect, openProject, api } = await import(pathToFileURL(path.join(process.env.ONSET_XHS_HOST, 'apps/desktop/e2e/fixtures.mjs')).href);
const plugin = path.resolve(import.meta.dirname, '..');
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
const account = '00000000-0000-4000-8000-000000000001';

test('真实插件在片场内上传填写，返回项目后再打开仍保留用户修改', async ({ electronApp, page, project, sandbox }) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'onset-station.json'), 'utf8'));
  fs.mkdirSync(sandbox.stations, { recursive: true });
  fs.writeFileSync(path.join(sandbox.stations, 'installed.json'), JSON.stringify({ version: 1, plugins: [{
    id: manifest.id, version: manifest.version, source: 'link:' + plugin, commit: '', digest: '', role: { flow: false, replaces: '', after: 'publish', nodes: true },
  }] }));
  const data = path.join(sandbox.stations, manifest.id, 'data');
  fs.mkdirSync(path.join(data, 'accounts', account), { recursive: true });
  fs.writeFileSync(path.join(data, 'accounts', account, 'account.json'), JSON.stringify({ id: account, name: '测试工作号', created_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(project.path, 'final.mp4'), 'fixture-video');
  fs.writeFileSync(path.join(project.path, 'cover.png'), 'fixture-cover');
  fs.writeFileSync(path.join(project.path, 'publish.md'), `---\n${stringify({ platform: 'xiaohongshu', publish_status: 'ready', video: { path: 'final.mp4' }, copy: { primary_title: '片场内自动填写', introduction: '在客户端里检查并发布', hashtags: [] }, cover: { images: [{ platform: 'xiaohongshu', ratio: '3:4', path: 'cover.png' }] } })}---\n`);
  await electronApp.evaluate(({ session }, { dir, html }) => {
    session.fromPath(dir).protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  }, { dir: path.join(data, 'web-sessions', account), html: fixture });
  await openProject(page, project);
  const run = async op => {
    const started = await api(page, `/api/stations/${manifest.id}/ops/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { account } }) });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    let result;
    await expect.poll(async () => {
      const station = (await api(page, '/api/stations')).body.stations.find(s => s.id === manifest.id);
      result = station.ops.find(o => o.name === op).last_run;
      return result?.task_id === started.body.task_id;
    }, { timeout: 25_000 }).toBe(true);
    expect(result.ok, result.text).toBe(true);
    return result.data;
  };
  expect((await run('prepare')).status).toBe('ready_to_publish');
  const content = await electronApp.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.xiaohongshu.com/'));
    const result = await wc.executeJavaScript(`({ title: document.querySelector('input[placeholder]').value, body: document.querySelector('[contenteditable]').innerText, video: document.querySelector('input[accept="video/*"]').files[0].name, cover: document.querySelector('input[accept="image/*"]').files[0].name, submits: window.submits })`);
    await wc.executeJavaScript(`document.querySelector('input[placeholder]').value='用户改过的标题'`);
    const bar = webContents.getAllWebContents().find(w => w.getURL().startsWith('data:text/html'));
    await bar.executeJavaScript(`document.querySelector('a').click()`);
    return result;
  });
  expect(content).toEqual({ title: '片场内自动填写', body: '在客户端里检查并发布', video: 'final.mp4', cover: 'cover.png', submits: 0 });
  await run('open_account');
  expect(await electronApp.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.xiaohongshu.com/'));
    const title = await wc.executeJavaScript(`document.querySelector('input[placeholder]').value`);
    await wc.executeJavaScript(`document.querySelector('#publish').click()`);
    if (await wc.executeJavaScript('window.submits') !== 1) throw Error('不能由用户发布');
    return title;
  })).toBe('用户改过的标题');
});
