import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { projectFile } from './files';

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
  if (d.platform !== 'xiaohongshu') throw Error('请先在片场将发布平台设为小红书');
  if (d.publish_status === 'blocked') throw Error('发布信息仍有阻塞问题，请先在片场处理');
  const copy = record(d.copy), video = record(d.video), cover = record(d.cover);
  if (video.replacement_in_progress === true) throw Error('成片仍在替换中');
  const title = text(copy.primary_title, '标题');
  if ([...title].length > 20) throw Error('标题超过 20 字，请先修改标题');
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
  if (!Array.isArray(cover.images)) throw Error('缺少小红书封面');
  const candidates = cover.images.map(record).filter(c => c.platform === 'xiaohongshu');
  const portrait = candidates.filter(c => c.ratio === '3:4');
  const selected = portrait.length ? portrait : candidates;
  if (selected.length !== 1) throw Error('需要一张明确的小红书封面，优先选择 3:4 封面');
  const coverPath = projectFile(root, text(selected[0].path, '封面路径'));
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(coverPath).toLowerCase()) || fs.statSync(coverPath).size === 0) throw Error('封面需要非空的 PNG、JPEG 或 WebP 图片');
  return { title, content, tags: normalizedTags, video: videoPath, videoHash, cover: coverPath };
}
