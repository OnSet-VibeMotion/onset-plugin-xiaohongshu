import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { AccountStore, withAccountLock } from '../src/accounts';
import { readDraft } from '../src/draft';
import { projectFile, writeProjectJSON } from '../src/files';

const roots: string[] = [];
function temp() { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-xhs-test-'))); roots.push(p); return p; }
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function project(over: Record<string, unknown> = {}) {
  const root = temp();
  fs.writeFileSync(path.join(root, 'final.mp4'), 'video');
  fs.writeFileSync(path.join(root, 'cover.png'), 'image');
  fs.writeFileSync(path.join(root, 'publish.md'), `---\n${stringify({
    platform: 'xiaohongshu', publish_status: 'ready', video: { path: 'final.mp4' },
    copy: { primary_title: '测试标题', introduction: '测试正文', hashtags: ['#科技', '视频'] },
    cover: { images: [{ platform: 'xiaohongshu', ratio: '3:4', path: 'cover.png' }] },
    credits: { required: true, text: '图片：作者甲' }, ...over,
  })}---\n`);
  return root;
}

describe('账号资料', () => {
  it('账号共用插件数据目录，但每个账号拥有独立浏览器目录，重命名不丢登录状态', () => {
    const data = temp(); const store = new AccountStore(data);
    const a = store.add('个人号'), b = store.add('工作号');
    expect(a.id).not.toBe(b.id);
    expect(store.profile(a.id)).not.toBe(store.profile(b.id));
    fs.writeFileSync(path.join(store.profile(a.id), 'sentinel'), 'session-a');
    store.rename(a.id, '生活号');
    expect(new AccountStore(data).list().map(a => a.name).sort()).toEqual(['工作号', '生活号']);
    expect(fs.readFileSync(path.join(store.profile(a.id), 'sentinel'), 'utf8')).toBe('session-a');
    expect(fs.statSync(store.profile(a.id)).mode & 0o777).toBe(0o700);
  });
  it('拒绝空名、重复名字、非法编号和缺失账号', () => {
    const s = new AccountStore(temp()); s.add('个人号');
    for (const name of ['', ' ', '坏\n名字', '字'.repeat(41), '个人号']) expect(() => s.add(name)).toThrow();
    expect(() => s.get('../outside')).toThrow();
    expect(() => s.get('00000000-0000-4000-8000-000000000000')).toThrow();
    const b = s.add('工作号'); expect(() => s.rename(b.id, '个人号')).toThrow();
  });
  it('一个账号准备期间禁止并发；异常后能再次使用', async () => {
    const s = new AccountStore(temp()); const a = s.add('个人号');
    await withAccountLock(s.profile(a.id), async () => {
      await expect(withAccountLock(s.profile(a.id), async () => {})).rejects.toThrow('正在');
    });
    await expect(withAccountLock(s.profile(a.id), async () => { throw Error('failure'); })).rejects.toThrow('failure');
    await expect(withAccountLock(s.profile(a.id), async () => 42)).resolves.toBe(42);
  });
  it('进程退出留下的账号锁可恢复，损坏的锁不会被静默接管', async () => {
    const store = new AccountStore(temp()); const account = store.add('恢复测试');
    const lock = path.join(store.profile(account.id), 'operation.lock');
    fs.writeFileSync(lock, '999999999');
    await expect(withAccountLock(store.profile(account.id), async () => 'recovered')).resolves.toBe('recovered');
    fs.writeFileSync(lock, 'invalid');
    await expect(withAccountLock(store.profile(account.id), async () => {})).rejects.toThrow('损坏');
  });
});

describe('发布素材', () => {
  it('读取视频、平台封面、正文、话题与署名', async () => {
    const root = project(); const d = await readDraft(root);
    expect(d.title).toBe('测试标题'); expect(d.content).toContain('图片：作者甲');
    expect(d.tags).toEqual(['科技', '视频']); expect(d.video).toBe(path.join(root, 'final.mp4'));
    expect(d.cover).toBe(path.join(root, 'cover.png')); expect(d.videoHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { platform: 'douyin' }, { publish_status: 'blocked' },
    { copy: { primary_title: '', introduction: '正文' } },
    { video: { path: '../outside.mp4' } }, { video: { path: 'missing.mp4' } },
    { video: { path: 'cover.png' } }, { video: { path: 'final.mp4', sha256: 'a'.repeat(64) } },
    { cover: { images: [] } }, { credits: { required: true, text: '' } },
    { video: { path: 'final.mp4', replacement_in_progress: true } },
    { copy: { primary_title: '标题', introduction: '字'.repeat(1001), hashtags: [] } },
    { copy: { primary_title: '标题', introduction: '正文', hashtags: Array(11).fill('话题') } },
    { copy: { primary_title: '标题', introduction: '正文', hashtags: ['坏\n标签'] } },
  ])('拒绝不完整或不匹配的素材 %j', async (over) => {
    await expect(readDraft(project(over))).rejects.toThrow();
  });
  it('不截断标题，不悄悄忽略多张候选封面', async () => {
    await expect(readDraft(project({ copy: { primary_title: '长'.repeat(21), introduction: '正文' } }))).rejects.toThrow('标题');
    await expect(readDraft(project({ cover: { images: [
      { platform: 'xiaohongshu', ratio: '3:4', path: 'cover.png' },
      { platform: 'xiaohongshu', ratio: '3:4', path: 'other.png' },
    ] } }))).rejects.toThrow('封面');
  });
  it('拒绝越界符号链接，状态写入也不能穿过链接', () => {
    const root = temp(), outside = temp(); fs.writeFileSync(path.join(outside, 'secret.mp4'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.mp4'), path.join(root, 'video.mp4'));
    expect(() => projectFile(root, 'video.mp4')).toThrow();
    fs.symlinkSync(outside, path.join(root, 'production'));
    expect(() => writeProjectJSON(root, 'production/xiaohongshu/state.json', { status: 'ready' })).toThrow();
    expect(fs.readdirSync(outside)).toEqual(['secret.mp4']);
  });
});
