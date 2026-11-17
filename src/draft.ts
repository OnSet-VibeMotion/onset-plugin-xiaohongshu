import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { projectFile } from './files';

/** cover 为空表示 publish.md 里没有登记封面：不设置，小红书用视频首帧。 */
export interface Draft { title: string; content: string; tags: string[]; video: string; videoHash: string; cover: string }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('发布信息格式不正确');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw Error(`${field}不能为空`);
  return value.trim();
}
export async function readDraft(root: string): Promise<Draft> {
  const file = projectFile(root, 'publish.md');
  if (fs.statSync(file).size > 262_144) throw Error('publish.md 太大');
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw Error('publish.md 缺少 YAML 发布信息');
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw Error('publish.md 的 YAML 格式有误');
  const d = record(doc.toJS({ maxAliasCount: 20 }));
  // 只看小红书自己要的数据够不够：platform 是这次发布的主平台、publish_status 是按主平台查的结果，
  // 小红书可能只是其中之一，主平台还缺什么不该挡住这里。标题与封面优先用为小红书单独登记的。
  const copy = record(d.copy), video = record(d.video), cover = record(d.cover);
  if (video.replacement_in_progress === true) throw Error('成片仍在替换中');
  const platformTitles = copy.platform_titles ? record(copy.platform_titles) : {};
  const ownTitle = typeof platformTitles.xiaohongshu === 'string' && platformTitles.xiaohongshu.trim() !== '';
  const title = text(ownTitle ? platformTitles.xiaohongshu : copy.primary_title, '标题');
  if ([...title].length > 20) {
    throw Error(ownTitle ? '小红书标题超过 20 字，请先修改' : '标题超过 20 字（小红书的上限）：请在片场给小红书单独写一个标题（copy.platform_titles.xiaohongshu）');
  }
  let content = text(copy.introduction, '正文');
  const credits = d.credits ? record(d.credits) : null;
  if (credits?.required === true) {
    const attribution = text(credits.text, '素材署名');
    if (!content.includes(attribution)) content += `\n\n${attribution}`;
  }
  const tags = copy.hashtags ?? [];
  if (!Array.isArray(tags) || tags.length > 10) throw Error('话题应是最多 10 项的列表');
  const normalizedTags = [...new Set(tags.map(tag => {
    const normalized = text(tag, '话题').replace(/^#/, '');
    if (!normalized || /[\s#\x00-\x1f]/.test(normalized)) throw Error('话题不能包含空格、换行或多余的 #');
    return normalized;
  }))];
  if ([...content, ...normalizedTags.join(' #')].length > 1000) throw Error('正文与话题超过 1000 字，请先精简');
  const videoPath = projectFile(root, text(video.path, '视频路径'));
  if (!['.mp4', '.mov', '.m4v'].includes(path.extname(videoPath).toLowerCase()) || fs.statSync(videoPath).size === 0) throw Error('请选择非空的 MP4、MOV 或 M4V 视频');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(videoPath)) hash.update(chunk);
  const videoHash = hash.digest('hex');
  if (video.sha256 && video.sha256 !== videoHash) throw Error('成片已变动，请先刷新发布信息');
  const coverPath = pickCover(root, cover.images);
  return { title, content, tags: normalizedTags, video: videoPath, videoHash, cover: coverPath };
}

/**
 * 挑一张封面：小红书 3:4 → 小红书其他比例 → 任何平台的 3:4（小红书推荐竖版）→ 任何一张。
 * 同一档里有几张不同的图时报错，不悄悄挑一张。一张都没有时返回空，不设置封面。
 */
function pickCover(root: string, images: unknown): string {
  if (images === undefined) return '';
  if (!Array.isArray(images)) throw Error('封面登记格式不正确');
  const all = images.map(record);
  const own = all.filter(c => c.platform === 'xiaohongshu');
  const tiers = [own.filter(c => c.ratio === '3:4'), own, all.filter(c => c.ratio === '3:4'), all];
  for (const tier of tiers) {
    const paths = [...new Set(tier.map(c => text(c.path, '封面路径')))];
    if (paths.length === 0) continue;
    if (paths.length > 1) throw Error('有几张候选封面，分不清用哪张：请在片场给小红书登记一张 3:4 封面');
    const file = projectFile(root, paths[0]);
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(file).toLowerCase()) || fs.statSync(file).size === 0) throw Error('封面需要非空的 PNG、JPEG 或 WebP 图片');
    return file;
  }
  return '';
}
