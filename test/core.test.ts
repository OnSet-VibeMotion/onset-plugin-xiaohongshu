import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { AccountStore, newAccountID, withAccountLock } from '../src/accounts';
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
  const add = (store: AccountStore, name: string, user_id?: string, avatar?: string) => store.saveLoggedIn({ id: newAccountID(), name, user_id, avatar }).account;
  it('登录后记下昵称与头像；每个账号独立的浏览器目录', () => {
    const data = temp(); const store = new AccountStore(data);
    const avatar = 'data:image/png;base64,iVBORw0KGgo=';
    const a = add(store, '个人号', 'u1', avatar), b = add(store, '工作号', 'u2');
    expect(a.id).not.toBe(b.id);
    expect(store.profile(a.id)).not.toBe(store.profile(b.id));
    expect(new AccountStore(data).list().map(x => [x.name, x.avatar ?? ''])).toEqual([['个人号', avatar], ['工作号', '']]);
    expect(fs.statSync(store.profile(a.id)).mode & 0o777).toBe(0o700);
  });
  it('同一个小红书账号重新登录：换成新的一条，删掉旧的登录状态，保留加入时间', () => {
    const data = temp(); const store = new AccountStore(data);
    const old = add(store, '旧昵称', 'same');
    const session = path.join(data, 'web-sessions', old.id);
    fs.mkdirSync(session, { recursive: true });
    const { account, replaced } = store.saveLoggedIn({ id: newAccountID(), name: '新昵称', user_id: 'same' });
    expect(replaced?.id).toBe(old.id);
    expect(account.created_at).toBe(old.created_at);
    expect(store.list().map(a => a.name)).toEqual(['新昵称']);
    expect(fs.existsSync(session)).toBe(false);
  });
  it('移除账号时一并删掉登录状态；昵称过长截断、控制字符换成空格；不认外来的头像格式', () => {
    const data = temp(); const store = new AccountStore(data);
    const a = add(store, '字'.repeat(50) + '\n尾', undefined, 'https://example.com/a.png');
    expect([...a.name].length).toBe(40);
    expect(a.avatar).toBeUndefined();
    fs.mkdirSync(path.join(data, 'web-sessions', a.id), { recursive: true });
    expect(store.remove(a.id).id).toBe(a.id);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(path.join(data, 'web-sessions', a.id))).toBe(false);
    expect(() => store.saveLoggedIn({ id: newAccountID(), name: '  ' })).toThrow('昵称');
  });
  it('拒绝非法编号和缺失账号', () => {
    const s = new AccountStore(temp());
    expect(() => s.get('../outside')).toThrow();
    expect(() => s.get('00000000-0000-4000-8000-000000000000')).toThrow();
    expect(() => s.saveLoggedIn({ id: '../x', name: '坏' })).toThrow();
  });
  it('一个账号准备期间禁止并发；异常后能再次使用', async () => {
    const s = new AccountStore(temp()); const a = add(s, '个人号');
    await withAccountLock(s.profile(a.id), async () => {
      await expect(withAccountLock(s.profile(a.id), async () => {})).rejects.toThrow('正在');
    });
    await expect(withAccountLock(s.profile(a.id), async () => { throw Error('failure'); })).rejects.toThrow('failure');
    await expect(withAccountLock(s.profile(a.id), async () => 42)).resolves.toBe(42);
  });
  it('进程退出留下的账号锁可恢复，损坏的锁不会被静默接管', async () => {
    const store = new AccountStore(temp()); const account = add(store, '恢复测试');
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
    { copy: { primary_title: '', introduction: '正文' } },
    { video: { path: '../outside.mp4' } }, { video: { path: 'missing.mp4' } },
    { video: { path: 'cover.png' } }, { video: { path: 'final.mp4', sha256: 'a'.repeat(64) } },
    { credits: { required: true, text: '' } },
    { video: { path: 'final.mp4', replacement_in_progress: true } },
    { copy: { primary_title: '标题', introduction: '字'.repeat(1001), hashtags: [] } },
    { copy: { primary_title: '标题', introduction: '正文', hashtags: Array(11).fill('话题') } },
    { copy: { primary_title: '标题', introduction: '正文', hashtags: ['坏\n标签'] } },
  ])('拒绝不完整或不匹配的素材 %j', async (over) => {
    await expect(readDraft(project(over))).rejects.toThrow();
  });
  // 只看小红书要的数据够不够：主平台是别的、按主平台查出的问题，都不挡这里。
  it('主平台不是小红书、主平台还有问题时照样能做', async () => {
    const root = project({ platform: 'douyin', publish_status: 'blocked' });
    expect((await readDraft(root)).title).toBe('测试标题');
  });
  it('标题优先用为小红书单独写的；主标题超过 20 字时说清怎么补', async () => {
    const own = await readDraft(project({ copy: { primary_title: '长'.repeat(25), introduction: '正文', platform_titles: { xiaohongshu: '小红书的标题', douyin: '抖音的' } } }));
    expect(own.title).toBe('小红书的标题');
    await expect(readDraft(project({ copy: { primary_title: '长'.repeat(25), introduction: '正文' } }))).rejects.toThrow('copy.platform_titles.xiaohongshu');
  });
  it('封面按小红书 3:4、小红书其他、任何 3:4、任何一张的顺序挑；没有就不设', async () => {
    const pick = async (images: unknown[] | undefined) => {
      const root = project({ cover: images === undefined ? {} : { images } });
      for (const name of ['a.png', 'b.png', 'c.png']) fs.writeFileSync(path.join(root, name), 'image');
      const cover = (await readDraft(root)).cover;
      return cover ? path.basename(cover) : '';
    };
    expect(await pick([{ platform: 'douyin', ratio: '3:4', path: 'a.png' }, { platform: 'xiaohongshu', ratio: '1:1', path: 'b.png' }])).toBe('b.png');
    expect(await pick([{ platform: 'douyin', ratio: '4:3', path: 'a.png' }, { platform: 'bilibili', ratio: '3:4', path: 'c.png' }])).toBe('c.png');
    expect(await pick([{ platform: 'bilibili', ratio: '16:10', path: 'a.png' }])).toBe('a.png');
    // 同一张图登记给几个平台不算分不清。
    expect(await pick([{ platform: 'douyin', ratio: '3:4', path: 'a.png' }, { platform: 'shipinhao', ratio: '3:4', path: 'a.png' }])).toBe('a.png');
    expect(await pick([])).toBe('');
    expect(await pick(undefined)).toBe('');
  });
  it('话题优先用为小红书单独写的列表，空列表就是不带话题；没写才用通用话题', async () => {
    const own = await readDraft(project({ copy: { primary_title: '标题', introduction: '正文', hashtags: ['通用'], platform_hashtags: { xiaohongshu: ['#通用', '小红书活动'], douyin: ['别的平台'] } } }));
    expect(own.tags).toEqual(['通用', '小红书活动']);
    const none = await readDraft(project({ copy: { primary_title: '标题', introduction: '正文', hashtags: ['通用'], platform_hashtags: { xiaohongshu: [] } } }));
    expect(none.tags).toEqual([]);
    const shared = await readDraft(project({ copy: { primary_title: '标题', introduction: '正文', hashtags: ['通用'], platform_hashtags: { douyin: ['别的平台'] } } }));
    expect(shared.tags).toEqual(['通用']);
    await expect(readDraft(project({ copy: { primary_title: '标题', introduction: '正文', platform_hashtags: { xiaohongshu: '小红书活动' } } }))).rejects.toThrow('copy.platform_hashtags.xiaohongshu');
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
