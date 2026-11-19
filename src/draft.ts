import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { projectFile } from './files';

/** cover 为空表示 publish.md 里没有登记封面：不设置，小红书用视频首帧。 */
export interface Draft {
  title: string; content: string; tags: string[]; video: string; videoHash: string; cover: string;
  /** 文件大小（字节）与修改时间（毫秒）：认出小红书本机草稿里是不是这个成片。 */
  videoSize?: number;
  videoModified?: number;
  /** 成片时长（毫秒），读不出来为 null：和已发布笔记、草稿、编辑页里的视频时长比对。 */
  videoDuration?: number | null;
}
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
  // 话题优先用为小红书单独写的完整列表（copy.platform_hashtags.xiaohongshu，空列表就是不带话题），没写才用通用的 copy.hashtags。
  const platformTags = copy.platform_hashtags ? record(copy.platform_hashtags) : {};
  const ownTags = Object.hasOwn(platformTags, 'xiaohongshu');
  const tags = ownTags ? platformTags.xiaohongshu : copy.hashtags ?? [];
  if (!Array.isArray(tags) || tags.length > 10) throw Error(ownTags ? '小红书话题（copy.platform_hashtags.xiaohongshu）应是最多 10 项的列表' : '话题应是最多 10 项的列表');
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
  const coverPath = pickCover(root, cover.images, landscape(video));
  const stat = fs.statSync(videoPath);
  return {
    title, content, tags: normalizedTags, video: videoPath, videoHash, cover: coverPath,
    videoSize: stat.size, videoModified: Math.floor(stat.mtimeMs), videoDuration: mp4Duration(videoPath),
  };
}

/**
 * 读 MP4 / MOV 的时长（moov/mvhd，毫秒）。只按盒子头跳着读，不读整个文件；读不出来返回 null。
 */
export function mp4Duration(file: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const read = (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, fs.readSync(fd!, buffer, 0, length, offset));
    };
    const boxes = function* (start: number, end: number) {
      let offset = start;
      while (offset + 8 <= end) {
        const head = read(offset, 16);
        if (head.length < 8) return;
        let length = head.readUInt32BE(0), header = 8;
        if (length === 1) { if (head.length < 16) return; length = Number(head.readBigUInt64BE(8)); header = 16; }
        else if (length === 0) length = end - offset;
        if (length < header) return;
        yield { type: head.toString('latin1', 4, 8), start: offset + header, end: Math.min(offset + length, end) };
        offset += length;
      }
    };
    for (const top of boxes(0, size)) {
      if (top.type !== 'moov') continue;
      for (const box of boxes(top.start, top.end)) {
        if (box.type !== 'mvhd') continue;
        const body = read(box.start, 32);
        const version = body[0];
        const scale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
        const duration = version === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
        return scale ? Math.round(duration * 1000 / scale) : null;
      }
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** 成片是横屏吗：看 publish.md 的 video.width_px / height_px，没写就当竖屏（小红书原来的做法）。 */
function landscape(video: Record<string, unknown>): boolean {
  const w = Number(video.width_px), h = Number(video.height_px);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w > h;
}

/**
 * 挑一张封面。小红书的封面跟着成片的方向：横屏成片用 4:3（与抖音的横版封面是同一张），竖屏用 3:4。
 * - 横屏：小红书的 4:3 → 任何平台的 4:3 → 小红书其他比例 → 任何一张。比例比平台要紧：
 *   给小红书登记了 3:4、给抖音登记了 4:3 时，用的是 4:3 那张。
 * - 竖屏：小红书的 3:4 → 小红书其他比例 → 任何平台的 3:4 → 任何一张。
 * 同一档里有几张不同的图时报错，不悄悄挑一张。一张都没有时返回空，不设置封面。
 */
function pickCover(root: string, images: unknown, wide: boolean): string {
  if (images === undefined) return '';
  if (!Array.isArray(images)) throw Error('封面登记格式不正确');
  const all = images.map(record);
  const own = all.filter(c => c.platform === 'xiaohongshu');
  const ratio = wide ? '4:3' : '3:4';
  const tiers = wide
    ? [own.filter(c => c.ratio === ratio), all.filter(c => c.ratio === ratio), own, all]
    : [own.filter(c => c.ratio === ratio), own, all.filter(c => c.ratio === ratio), all];
  for (const tier of tiers) {
    const paths = [...new Set(tier.map(c => text(c.path, '封面路径')))];
    if (paths.length === 0) continue;
    if (paths.length > 1) throw Error(`有几张候选封面，分不清用哪张：请在片场给小红书登记一张 ${ratio} 封面`);
    const file = projectFile(root, paths[0]);
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(file).toLowerCase()) || fs.statSync(file).size === 0) throw Error('封面需要非空的 PNG、JPEG 或 WebP 图片');
    return file;
  }
  return '';
}
